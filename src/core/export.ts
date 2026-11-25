import { promises as fs } from "node:fs";
import path from "node:path";
import gifenc from "gifenc";
import { toAseprite } from "./aseprite.ts";
import { Bitmap, paletteRGB } from "./bitmap.ts";
import type { PixelDoc } from "./doc.ts";
import { marginsOf, type Rect } from "./slices.ts";
import { blobTiles, E, gridTiles, N, NE, NW, S, SE, SW, VARIANT_PROBABILITY, W as WEST } from "./tileset.ts";
import { VERSION } from "./version.ts";

export type ExportFormat =
  | "png"
  | "frames"
  | "sheet"
  | "gif"
  | "aseprite"
  | "godot-stylebox"
  | "godot-spriteframes"
  | "godot-tileset";
export const EXPORT_FORMATS: readonly ExportFormat[] = [
  "png",
  "frames",
  "sheet",
  "gif",
  "aseprite",
  "godot-stylebox",
  "godot-spriteframes",
  "godot-tileset",
];
/** Columns of the generated blob atlas. */
export const BLOB_ATLAS_COLUMNS = 8;

export interface ExportOptions {
  format: ExportFormat;
  /** Integer upscale (nearest neighbor). */
  scale?: number;
  /** Frame for "png". */
  frame?: number;
  /** Limit frames/sheet/gif to a tag's range. */
  tag?: string;
  /** Sheet columns (default: one row up to 16 frames, then a square-ish grid). */
  columns?: number;
  /** Sheet spacing between frames in output pixels. */
  padding?: number;
  layer?: string;
  /** godot-stylebox: which 9-slice (default: the first one). */
  slice?: string;
  /** godot-*: res:// folder the files land in (e.g. "res://ui/"); otherwise texture paths are relative. */
  resDir?: string;
  /** godot-tileset: full-tile collision squares on physics layer 0. */
  collision?: boolean;
}

// Godot's square-tile peering bits, in the order Godot writes them.
const PEERING_BITS: readonly [number, string][] = [
  [E, "right_side"],
  [SE, "bottom_right_corner"],
  [S, "bottom_side"],
  [SW, "bottom_left_corner"],
  [WEST, "left_side"],
  [NW, "top_left_corner"],
  [N, "top_side"],
  [NE, "top_right_corner"],
];

/** Most used color of a tile, as a Godot Color (terrain swatch in the editor). */
function dominantColor(px: Int16Array, palette: readonly string[]): string {
  const counts = new Map<number, number>();
  for (const v of px) if (v >= 0) counts.set(v, (counts.get(v) ?? 0) + 1);
  const best = [...counts].sort((a, b) => b[1] - a[1])[0];
  const [r, g, b] = best ? paletteRGB([palette[best[0]]])[0] : [128, 128, 128];
  return `Color(${[r, g, b].map((c) => gdFloat(Math.round((c / 255) * 1000) / 1000)).join(", ")}, 1)`;
}

/** Finds the Godot project containing dir and returns dir as a res:// folder ("res://ui/"), or null. */
export async function findGodotResDir(dir: string): Promise<string | null> {
  const target = path.resolve(dir);
  let cur = target;
  for (;;) {
    try {
      await fs.access(path.join(cur, "project.godot"));
      const rel = path.relative(cur, target).split(path.sep).join("/");
      return `res://${rel ? `${rel}/` : ""}`;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return null;
      cur = parent;
    }
  }
}

function scaleRect(r: Rect, s: number): Rect {
  return { x: r.x * s, y: r.y * s, w: r.w * s, h: r.h * s };
}

/** Godot text-resource float: 1.0, 8.33333. */
function gdFloat(n: number): string {
  return Number.isInteger(n) ? `${n}.0` : String(Math.round(n * 100000) / 100000);
}

function gdString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export interface GodotAnimation {
  name: string;
  /** Frame indices in play order (pingpong and reverse already expanded). */
  frames: number[];
  /** Godot plays `speed` frames per second; each frame lasts `duration` units of 1/speed. */
  speed: number;
  durations: number[];
}

/** Animations from tags (or one "default" over all frames); per-frame ms become relative durations. */
export function godotAnimations(doc: PixelDoc, tag?: string): GodotAnimation[] {
  const last = doc.frames.length - 1;
  const tags = tag
    ? doc.tags.filter((t) => t.name.toLowerCase() === tag.toLowerCase())
    : doc.tags.length
      ? doc.tags
      : [{ name: "default", from: 0, to: last, direction: "forward" as const }];
  if (!tags.length) throw new Error(`No tag "${tag}".`);
  return tags.map((t) => {
    let seq: number[] = [];
    for (let i = Math.min(t.from, t.to); i <= Math.max(t.from, t.to); i++) seq.push(i);
    if (t.direction === "reverse") seq.reverse();
    if (t.direction === "pingpong" && seq.length > 2) seq = [...seq, ...seq.slice(1, -1).reverse()];
    const ms = seq.map((f) => doc.frames[f].duration);
    const unit = Math.min(...ms);
    return { name: t.name, frames: seq, speed: 1000 / unit, durations: ms.map((m) => m / unit) };
  });
}

/** Single-frame tag names make nice state names (normal, hover, pressed). */
function frameLabel(doc: PixelDoc, f: number, count: number): string {
  const tag = doc.tags.find((t) => t.from === f && t.to === f);
  if (tag) return tag.name.toLowerCase().replace(/[^a-z0-9_-]+/g, "_");
  return count > 1 ? String(f) : "";
}

export interface ExportFile {
  /** Relative path, e.g. "characters/hero_sheet.png". */
  path: string;
  data: Buffer;
  mime: string;
}

export function selectFrames(doc: PixelDoc, tag?: string): number[] {
  if (!tag) return doc.frames.map((_, i) => i);
  const t = doc.tags.find((x) => x.name === tag) ?? doc.tags.find((x) => x.name.toLowerCase() === tag.toLowerCase());
  if (!t) {
    throw new Error(`No tag "${tag}". Tags: ${doc.tags.map((x) => x.name).join(", ") || "(none)"}.`);
  }
  const out: number[] = [];
  for (let i = Math.min(t.from, t.to); i <= Math.max(t.from, t.to); i++) out.push(i);
  return out;
}

export function buildExport(doc: PixelDoc, name: string, o: ExportOptions): ExportFile[] {
  const scale = o.scale ?? 1;
  if (!Number.isInteger(scale) || scale < 1 || scale > 32) throw new Error("scale must be an integer 1..32.");
  const layer = o.layer !== undefined ? doc.resolveLayer(o.layer) : undefined;
  const pal = paletteRGB(doc.palette);
  const W = doc.width * scale;
  const H = doc.height * scale;
  const suffix = scale > 1 ? `@${scale}x` : "";
  const composite = (f: number) => doc.composite(f, layer ? { layer } : {});
  const renderFrame = (f: number) => {
    const b = new Bitmap(W, H);
    b.drawIndexed(composite(f), doc.width, doc.height, pal, 0, 0, scale);
    return b;
  };
  const layoutSheet = (frames: number[]) => {
    const n = frames.length;
    const cols = Math.max(1, Math.min(n, o.columns ?? (n <= 16 ? n : Math.ceil(Math.sqrt(n)))));
    const rows = Math.ceil(n / cols);
    const pad = Math.max(0, o.padding ?? 0);
    const sheetW = cols * W + (cols - 1) * pad;
    const sheetH = rows * H + (rows - 1) * pad;
    const sheet = new Bitmap(sheetW, sheetH);
    const pos = frames.map((f, k) => {
      const x = (k % cols) * (W + pad);
      const y = Math.floor(k / cols) * (H + pad);
      sheet.drawIndexed(composite(f), doc.width, doc.height, pal, x, y, scale);
      return { x, y };
    });
    return { sheet, pos, sheetW, sheetH };
  };

  switch (o.format) {
    case "png": {
      const f = doc.checkFrame(o.frame ?? 0);
      const file = doc.frames.length > 1 ? `${name}_${f}${suffix}.png` : `${name}${suffix}.png`;
      return [{ path: file, data: renderFrame(f).toPNG(), mime: "image/png" }];
    }
    case "frames": {
      return selectFrames(doc, o.tag).map((f) => ({
        path: `${name}_${f}${suffix}.png`,
        data: renderFrame(f).toPNG(),
        mime: "image/png",
      }));
    }
    case "sheet": {
      const frames = selectFrames(doc, o.tag);
      const n = frames.length;
      const { sheet, pos, sheetW, sheetH } = layoutSheet(frames);
      const base = name.split("/").pop()!;
      const image = `${base}_sheet${suffix}.png`;
      const entries = frames.map((f, k) => {
        const { x, y } = pos[k];
        return {
          filename: `${base} ${f}`,
          frame: { x, y, w: W, h: H },
          rotated: false,
          trimmed: false,
          spriteSourceSize: { x: 0, y: 0, w: W, h: H },
          sourceSize: { w: W, h: H },
          duration: doc.frames[f].duration,
        };
      });
      const tags = o.tag
        ? doc.tags
            .filter((t) => t.name.toLowerCase() === o.tag!.toLowerCase())
            .map((t) => ({ name: t.name, from: 0, to: n - 1, direction: t.direction }))
        : doc.tags.map((t) => ({ name: t.name, from: t.from, to: t.to, direction: t.direction }));
      // Aseprite "array" JSON: understood by Phaser, PixiJS, Godot importers, etc.
      const json = {
        frames: entries,
        meta: {
          app: "dotquill",
          version: VERSION,
          image,
          format: "RGBA8888",
          size: { w: sheetW, h: sheetH },
          scale: String(scale),
          frameTags: tags,
          layers: [],
          // Aseprite slice format; bounds are per frame (sprite coordinates), scaled.
          slices: doc.slices.map((s) => ({
            name: s.name,
            color: "#0000ffff",
            keys: [{ frame: 0, bounds: scaleRect(s.bounds, scale), ...(s.center ? { center: scaleRect(s.center, scale) } : {}) }],
          })),
        },
      };
      return [
        { path: `${name}_sheet${suffix}.png`, data: sheet.toPNG(), mime: "image/png" },
        { path: `${name}_sheet${suffix}.json`, data: Buffer.from(JSON.stringify(json, null, 2)), mime: "application/json" },
      ];
    }
    case "godot-stylebox": {
      // One texture + a StyleBoxTexture .tres per frame (button states → normal/hover/pressed via single-frame tags).
      const slice = doc.nineSlice(o.slice);
      const m = marginsOf(slice)!;
      const frames = selectFrames(doc, o.tag);
      const { sheet, pos } = layoutSheet(frames);
      const base = name.split("/").pop()!;
      const folder = name.includes("/") ? name.slice(0, name.lastIndexOf("/") + 1) : "";
      const png = frames.length > 1 ? `${base}_sheet${suffix}.png` : `${base}${suffix}.png`;
      const texPath = o.resDir ? `${o.resDir}${folder}${png}` : png;
      const b = scaleRect(slice.bounds, scale);
      const tile = slice.mode === "tile";
      const files: ExportFile[] = [{ path: `${folder}${png}`, data: sheet.toPNG(), mime: "image/png" }];
      frames.forEach((f, k) => {
        const label = frameLabel(doc, f, frames.length);
        const tres = [
          '[gd_resource type="StyleBoxTexture" load_steps=2 format=3]',
          "",
          `[ext_resource type="Texture2D" path="${texPath}" id="1_tex"]`,
          "",
          "[resource]",
          'texture = ExtResource("1_tex")',
          `texture_margin_left = ${m.left * scale}.0`,
          `texture_margin_top = ${m.top * scale}.0`,
          `texture_margin_right = ${m.right * scale}.0`,
          `texture_margin_bottom = ${m.bottom * scale}.0`,
          ...(tile ? ["axis_stretch_horizontal = 1", "axis_stretch_vertical = 1"] : []),
          `region_rect = Rect2(${pos[k].x + b.x}, ${pos[k].y + b.y}, ${b.w}, ${b.h})`,
          "",
        ].join("\n");
        files.push({
          path: `${folder}${base}${label ? `_${label}` : ""}${suffix}.tres`,
          data: Buffer.from(tres),
          mime: "text/plain",
        });
      });
      return files;
    }
    case "godot-spriteframes": {
      // Sheet PNG + SpriteFrames .tres: one AtlasTexture per frame, one animation per tag.
      const anims = godotAnimations(doc, o.tag);
      const frames = [...new Set(anims.flatMap((a) => a.frames))].sort((a, b) => a - b);
      const { sheet, pos } = layoutSheet(frames);
      const base = name.split("/").pop()!;
      const folder = name.includes("/") ? name.slice(0, name.lastIndexOf("/") + 1) : "";
      const png = `${base}_sheet${suffix}.png`;
      const texPath = o.resDir ? `${o.resDir}${folder}${png}` : png;
      const out = [
        `[gd_resource type="SpriteFrames" load_steps=${frames.length + 2} format=3]`,
        "",
        `[ext_resource type="Texture2D" path="${texPath}" id="1_tex"]`,
        "",
      ];
      frames.forEach((f, k) => {
        out.push(
          `[sub_resource type="AtlasTexture" id="AtlasTexture_f${f}"]`,
          'atlas = ExtResource("1_tex")',
          `region = Rect2(${pos[k].x}, ${pos[k].y}, ${W}, ${H})`,
          "",
        );
      });
      const animText = anims.map((a) =>
        [
          "{",
          '"frames": [' +
            a.frames
              .map((f, i) => `{\n"duration": ${gdFloat(a.durations[i])},\n"texture": SubResource("AtlasTexture_f${f}")\n}`)
              .join(", ") +
            "],",
          '"loop": true,',
          `"name": &"${gdString(a.name)}",`,
          `"speed": ${gdFloat(a.speed)}`,
          "}",
        ].join("\n"),
      );
      out.push("[resource]", `animations = [${animText.join(", ")}]`, "");
      return [
        { path: `${folder}${png}`, data: sheet.toPNG(), mime: "image/png" },
        { path: `${folder}${base}_frames${suffix}.tres`, data: Buffer.from(out.join("\n")), mime: "text/plain" },
      ];
    }
    case "godot-tileset": {
      // Tile atlas PNG + TileSet .tres. Blob tilesets get a terrain set with peering bits, so Godot autotiles them.
      const ts = doc.tileset;
      if (!ts) throw new Error("This asset is not a tileset. Create one with create_asset tileset, or set it with manage_asset action tileset.");
      const f = doc.checkFrame(o.frame ?? 0);
      const T = ts.tile;
      const TS = T * scale;
      const base = name.split("/").pop()!;
      const folder = name.includes("/") ? name.slice(0, name.lastIndexOf("/") + 1) : "";
      const png = `${base}_tiles${suffix}.png`;
      const texPath = o.resDir ? `${o.resDir}${folder}${png}` : png;
      type Placed = { col: number; row: number; pixels: Int16Array; mask?: number; probability?: number };
      let placed: Placed[];
      let cols: number;
      let rows: number;
      let center: Int16Array | null = null;
      if (ts.layout === "blob") {
        const tiles = blobTiles(doc, f);
        cols = BLOB_ATLAS_COLUMNS;
        rows = Math.ceil(tiles.length / cols);
        placed = tiles.map((t, k) => ({
          col: k % cols,
          row: Math.floor(k / cols),
          pixels: t.pixels,
          mask: t.mask,
          ...(t.variant ? { probability: VARIANT_PROBABILITY } : {}),
        }));
        center = tiles.find((t) => t.mask === 255 && !t.variant)!.pixels;
      } else {
        cols = doc.width / T;
        rows = doc.height / T;
        placed = gridTiles(doc, f);
      }
      if (!placed.length) throw new Error("The tileset has no tiles yet (every cell is empty).");
      const atlas = new Bitmap(cols * TS, rows * TS);
      for (const t of placed) atlas.drawIndexed(t.pixels, T, T, pal, t.col * TS, t.row * TS, scale);
      const h = TS / 2;
      const out = [
        '[gd_resource type="TileSet" load_steps=3 format=3]',
        "",
        `[ext_resource type="Texture2D" path="${texPath}" id="1_tex"]`,
        "",
        '[sub_resource type="TileSetAtlasSource" id="TileSetAtlasSource_1"]',
        'texture = ExtResource("1_tex")',
        `texture_region_size = Vector2i(${TS}, ${TS})`,
      ];
      for (const t of placed) {
        const id = `${t.col}:${t.row}/0`;
        out.push(`${id} = 0`);
        if (t.mask !== undefined) out.push(`${id}/terrain_set = 0`, `${id}/terrain = 0`);
        if (t.probability !== undefined) out.push(`${id}/probability = ${gdFloat(t.probability)}`);
        if (o.collision) out.push(`${id}/physics_layer_0/polygon_0/points = PackedVector2Array(${-h}, ${-h}, ${h}, ${-h}, ${h}, ${h}, ${-h}, ${h})`);
        if (t.mask !== undefined) for (const [bit, key] of PEERING_BITS) if (t.mask & bit) out.push(`${id}/terrains_peering_bit/${key} = 0`);
      }
      out.push("", "[resource]", `tile_size = Vector2i(${TS}, ${TS})`);
      if (o.collision) out.push("physics_layer_0/collision_layer = 1");
      if (center) {
        out.push(
          "terrain_set_0/mode = 0",
          `terrain_set_0/terrain_0/name = "${gdString(ts.terrain ?? base)}"`,
          `terrain_set_0/terrain_0/color = ${dominantColor(center, doc.palette)}`,
        );
      }
      out.push('sources/0 = SubResource("TileSetAtlasSource_1")', "");
      return [
        { path: `${folder}${png}`, data: atlas.toPNG(), mime: "image/png" },
        { path: `${folder}${base}_tileset${suffix}.tres`, data: Buffer.from(out.join("\n")), mime: "text/plain" },
      ];
    }
    case "aseprite":
      // An editable source file: always 1×, all frames, layers, tags and slices.
      return [{ path: `${name}.aseprite`, data: toAseprite(doc), mime: "application/octet-stream" }];
    case "gif": {
      const frames = selectFrames(doc, o.tag);
      const gifPalette = [[0, 0, 0], ...pal.map((c) => [c[0], c[1], c[2]])];
      const enc = gifenc.GIFEncoder();
      frames.forEach((f, k) => {
        const comp = composite(f);
        const idx = new Uint8Array(W * H);
        for (let y = 0; y < H; y++) {
          const sy = Math.floor(y / scale) * doc.width;
          for (let x = 0; x < W; x++) {
            const v = comp[sy + Math.floor(x / scale)];
            idx[y * W + x] = v < 0 ? 0 : v + 1;
          }
        }
        enc.writeFrame(idx, W, H, {
          palette: k === 0 ? gifPalette : undefined,
          delay: doc.frames[f].duration,
          transparent: true,
          transparentIndex: 0,
          dispose: 2,
          repeat: 0,
        });
      });
      enc.finish();
      return [{ path: `${name}${suffix}.gif`, data: Buffer.from(enc.bytes()), mime: "image/gif" }];
    }
    default:
      throw new Error(`Unknown export format "${String((o as { format: string }).format)}".`);
  }
}

export async function writeExport(files: readonly ExportFile[], outDir: string): Promise<string[]> {
  const out: string[] = [];
  for (const f of files) {
    const p = path.join(outDir, ...f.path.split("/"));
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, f.data);
    out.push(p);
  }
  return out;
}
