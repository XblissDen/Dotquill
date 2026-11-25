import { normalizeHex } from "./color.ts";
import { decodeRows, encodeRows, isEmpty, MAX_COLORS, TRANSPARENT } from "./grid.ts";
import { validateSlice, type Slice } from "./slices.ts";
import { validateTileset, type Tileset } from "./tileset.ts";

export interface LayerInfo {
  name: string;
  visible: boolean;
}

export interface Frame {
  duration: number;
  cels: Map<string, Int16Array>;
}

export type TagDirection = "forward" | "reverse" | "pingpong";

export interface Tag {
  name: string;
  from: number;
  to: number;
  direction: TagDirection;
}

/** On-disk JSON shape (`*.pixel.json`). Pixel rows are human-readable and diff well in git. */
export interface DocFile {
  format: "dotquill";
  version: 1;
  width: number;
  height: number;
  palette: string[];
  paletteName?: string;
  layers: LayerInfo[];
  frames: { duration: number; cels: Record<string, string[]> }[];
  tags: Tag[];
  slices?: Slice[];
  tileset?: Tileset;
  notes?: string;
  created: string;
  updated: string;
}

export const MAX_SIZE = 512;
export const MAX_FRAMES = 256;
const LAYER_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,31}$/;

export function validateLayerName(name: string): string {
  const n = String(name).trim();
  if (!LAYER_RE.test(n)) {
    throw new Error(`Invalid layer name "${name}" (letters, digits, space, - and _; max 32 chars).`);
  }
  return n;
}

export function validatePalette(colors: readonly string[]): string[] {
  if (!Array.isArray(colors) || colors.length === 0) throw new Error("Palette is empty.");
  const out: string[] = [];
  const seen = new Set<string>();
  for (const c of colors) {
    const h = normalizeHex(c);
    if (!seen.has(h)) {
      seen.add(h);
      out.push(h);
    }
  }
  if (out.length > MAX_COLORS) {
    throw new Error(`Palette has ${out.length} colors; the maximum is ${MAX_COLORS}.`);
  }
  return out;
}

export function checkDuration(ms: number): number {
  if (!Number.isInteger(ms) || ms < 10 || ms > 60000) {
    throw new Error(`Frame duration must be an integer 10..60000 ms (got ${ms}).`);
  }
  return ms;
}

function checkSize(w: number, h: number): void {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > MAX_SIZE || h > MAX_SIZE) {
    throw new Error(`Canvas size must be integers 1..${MAX_SIZE} (got ${w}×${h}).`);
  }
}

export interface CreateOptions {
  width: number;
  height: number;
  palette: readonly string[];
  paletteName?: string;
  layers?: readonly string[];
  frames?: number;
  frameDuration?: number;
  notes?: string;
  tileset?: Tileset;
}

interface DocInit {
  width: number;
  height: number;
  palette: string[];
  paletteName: string | undefined;
  layers: LayerInfo[];
  frames: Frame[];
  tags: Tag[];
  slices: Slice[];
  tileset?: Tileset | undefined;
  notes: string;
  created: string;
  updated: string;
}

export class PixelDoc {
  width: number;
  height: number;
  palette: string[];
  paletteName: string | undefined;
  /** Bottom to top. */
  layers: LayerInfo[];
  frames: Frame[];
  tags: Tag[];
  /** Named regions; ones with a center are 9-slices for UI. */
  slices: Slice[];
  /** Set when the canvas is a tileset (a grid of tiles or a blob autotile template). */
  tileset: Tileset | undefined;
  notes: string;
  created: string;
  updated: string;

  constructor(d: DocInit) {
    this.width = d.width;
    this.height = d.height;
    this.palette = d.palette;
    this.paletteName = d.paletteName;
    this.layers = d.layers;
    this.frames = d.frames;
    this.tags = d.tags;
    this.slices = d.slices;
    this.tileset = d.tileset;
    this.notes = d.notes;
    this.created = d.created;
    this.updated = d.updated;
  }

  static create(o: CreateOptions): PixelDoc {
    checkSize(o.width, o.height);
    const palette = validatePalette(o.palette);
    const layerNames = (o.layers?.length ? o.layers : ["main"]).map(validateLayerName);
    if (new Set(layerNames).size !== layerNames.length) throw new Error("Layer names must be unique.");
    const count = o.frames ?? 1;
    if (!Number.isInteger(count) || count < 1 || count > MAX_FRAMES) {
      throw new Error(`Frame count must be 1..${MAX_FRAMES}.`);
    }
    const duration = checkDuration(o.frameDuration ?? 100);
    const tileset = o.tileset ? validateTileset(o.tileset, o.width, o.height) : undefined;
    const now = new Date().toISOString();
    return new PixelDoc({
      width: o.width,
      height: o.height,
      palette,
      paletteName: o.paletteName,
      layers: layerNames.map((name) => ({ name, visible: true })),
      frames: Array.from({ length: count }, () => ({ duration, cels: new Map() })),
      tags: [],
      slices: [],
      tileset,
      notes: o.notes ?? "",
      created: now,
      updated: now,
    });
  }

  static fromJSON(raw: unknown): PixelDoc {
    const d = raw as Partial<DocFile> | null;
    if (!d || d.format !== "dotquill") throw new Error("Not a Dotquill file.");
    if (d.version !== 1) throw new Error(`Unsupported file version ${String(d.version)}.`);
    const width = Number(d.width);
    const height = Number(d.height);
    checkSize(width, height);
    const palette = validatePalette(d.palette ?? []);
    const layers = (d.layers ?? []).map((l) => ({ name: validateLayerName(l.name), visible: l.visible !== false }));
    if (layers.length === 0) throw new Error("File has no layers.");
    const frames: Frame[] = (d.frames ?? []).map((f, i) => {
      const cels = new Map<string, Int16Array>();
      for (const [layer, rows] of Object.entries(f.cels ?? {})) {
        if (!layers.some((l) => l.name === layer)) continue;
        try {
          cels.set(layer, decodeRows(rows, width, height, palette.length));
        } catch (e) {
          throw new Error(`frame ${i}, layer "${layer}": ${(e as Error).message}`);
        }
      }
      return { duration: checkDuration(f.duration ?? 100), cels };
    });
    if (frames.length === 0) throw new Error("File has no frames.");
    const tags = (d.tags ?? [])
      .filter((t) => t && typeof t.name === "string")
      .map((t) => ({
        name: t.name,
        from: Math.max(0, Math.min(frames.length - 1, Number(t.from) || 0)),
        to: Math.max(0, Math.min(frames.length - 1, Number(t.to) || 0)),
        direction: (["forward", "reverse", "pingpong"].includes(t.direction) ? t.direction : "forward") as TagDirection,
      }));
    const slices = (d.slices ?? []).map((s) => validateSlice(s, width, height));
    const tileset = d.tileset ? validateTileset(d.tileset, width, height) : undefined;
    return new PixelDoc({
      width,
      height,
      palette,
      paletteName: d.paletteName,
      layers,
      frames,
      tags,
      slices,
      tileset,
      notes: d.notes ?? "",
      created: d.created ?? new Date().toISOString(),
      updated: d.updated ?? new Date().toISOString(),
    });
  }

  toJSON(): DocFile {
    const out: DocFile = {
      format: "dotquill",
      version: 1,
      width: this.width,
      height: this.height,
      palette: [...this.palette],
      layers: this.layers.map((l) => ({ ...l })),
      frames: this.frames.map((f) => {
        const cels: Record<string, string[]> = {};
        for (const l of this.layers) {
          const c = f.cels.get(l.name);
          if (c && !isEmpty(c)) cels[l.name] = encodeRows(c, this.width, this.height);
        }
        return { duration: f.duration, cels };
      }),
      tags: this.tags.map((t) => ({ ...t })),
      created: this.created,
      updated: this.updated,
    };
    if (this.paletteName) out.paletteName = this.paletteName;
    if (this.slices.length) out.slices = this.slices.map((s) => JSON.parse(JSON.stringify(s)) as Slice);
    if (this.tileset) out.tileset = { ...this.tileset };
    if (this.notes) out.notes = this.notes;
    return out;
  }

  /** The named slice, or the first 9-slice when no name is given. */
  nineSlice(name?: string): Slice {
    const s =
      name !== undefined
        ? this.slices.find((x) => x.name.toLowerCase() === name.trim().toLowerCase())
        : this.slices.find((x) => x.center);
    if (!s) {
      throw new Error(
        name !== undefined
          ? `No slice "${name}". Slices: ${this.slices.map((x) => x.name).join(", ") || "(none)"}.`
          : "This asset has no 9-slice. Add one with the slices tool (action set with nine margins).",
      );
    }
    if (!s.center) throw new Error(`Slice "${s.name}" has no 9-slice margins.`);
    return s;
  }

  blank(): Int16Array {
    return new Int16Array(this.width * this.height).fill(TRANSPARENT);
  }

  /** Default layer is the bottom one. Matching is case-insensitive. */
  resolveLayer(name?: string): string {
    if (name === undefined || name === "") return this.layers[0].name;
    const l =
      this.layers.find((x) => x.name === name) ??
      this.layers.find((x) => x.name.toLowerCase() === name.trim().toLowerCase());
    if (!l) {
      throw new Error(`No layer "${name}". Layers (bottom→top): ${this.layers.map((x) => x.name).join(", ")}.`);
    }
    return l.name;
  }

  checkFrame(i: number): number {
    if (!Number.isInteger(i) || i < 0 || i >= this.frames.length) {
      throw new Error(`Frame ${i} does not exist (frames are 0..${this.frames.length - 1}).`);
    }
    return i;
  }

  /** Returns the cel for (frame, layer), creating an empty one if needed. */
  cel(frame: number, layer: string): Int16Array {
    const f = this.frames[this.checkFrame(frame)];
    let c = f.cels.get(layer);
    if (!c) {
      c = this.blank();
      f.cels.set(layer, c);
    }
    return c;
  }

  /** Flattens visible layers (or a single layer) of a frame. */
  composite(frame: number, opts: { layer?: string; includeHidden?: boolean } = {}): Int16Array {
    const f = this.frames[this.checkFrame(frame)];
    const out = this.blank();
    const names =
      opts.layer !== undefined
        ? [this.resolveLayer(opts.layer)]
        : this.layers.filter((l) => l.visible || opts.includeHidden).map((l) => l.name);
    for (const name of names) {
      const c = f.cels.get(name);
      if (!c) continue;
      for (let i = 0; i < c.length; i++) if (c[i] >= 0) out[i] = c[i];
    }
    return out;
  }

  /** Pixel count per palette index across all cels. */
  colorUsage(): number[] {
    const counts = new Array<number>(this.palette.length).fill(0);
    for (const f of this.frames) {
      for (const c of f.cels.values()) {
        for (let i = 0; i < c.length; i++) if (c[i] >= 0) counts[c[i]]++;
      }
    }
    return counts;
  }

  /** Applies an index mapping (old → new) to every pixel of every cel. */
  remap(map: (index: number) => number): void {
    for (const f of this.frames) {
      for (const c of f.cels.values()) {
        for (let i = 0; i < c.length; i++) if (c[i] >= 0) c[i] = map(c[i]);
      }
    }
  }

  touch(): void {
    this.updated = new Date().toISOString();
  }
}
