#!/usr/bin/env node
/**
 * Dotquill MCP server (stdio). Claude Code launches it; it reads and writes `*.pixel.json`
 * assets in a workspace folder and starts the live viewer on first use.
 *
 *   node src/mcp/server.ts [--dir <workspace>]
 *   env: DOTQUILL_DIR, DOTQUILL_PORT (default 7420), DOTQUILL_NO_VIEWER=1
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { audit } from "../core/audit.ts";
import { readPNG } from "../core/bitmap.ts";
import { ColorMatcher, lightness, normalizeHex, parseHex } from "../core/color.ts";
import { checkDuration, MAX_FRAMES, PixelDoc, validateLayerName, validatePalette, type TagDirection } from "../core/doc.ts";
import { applyOps, resolveColor, writeRows, type DrawOp } from "../core/draw.ts";
import { buildExport, findGodotResDir, godotAnimations, writeExport } from "../core/export.ts";
import { encodeRows, formatGrid, indexToChar, MAX_COLORS } from "../core/grid.ts";
import { GUIDE, GUIDE_TOPICS } from "../core/guide.ts";
import { imageToDoc } from "../core/importer.ts";
import { DEFAULT_PRESET, PRESETS, resolvePalette, type PaletteSpec } from "../core/palettes.ts";
import { renderPreview } from "../core/render.ts";
import { describeSlice, sliceFromMargins, validateSlice, validateSliceName, type Slice } from "../core/slices.ts";
import { validateName, Workspace } from "../core/store.ts";
import { VERSION } from "../core/version.ts";
import { openBrowser, startViewer } from "../viewer/server.ts";

// ---------- setup ----------

function argValue(flag: string): string | undefined {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag) return argv[i + 1];
    if (argv[i].startsWith(`${flag}=`)) return argv[i].slice(flag.length + 1);
  }
  return undefined;
}

const ws = new Workspace(argValue("--dir") ?? process.env.DOTQUILL_DIR ?? path.join(process.cwd(), "pixel-art"));
const log = (...a: unknown[]) => console.error("[dotquill]", ...a);

let viewerPromise: Promise<string | null> | null = null;
function ensureViewer(): Promise<string | null> {
  if (process.env.DOTQUILL_NO_VIEWER === "1") return Promise.resolve(null);
  viewerPromise ??= startViewer(ws, { port: Number(process.env.DOTQUILL_PORT) || 7420 })
    .then((v) => {
      log(`viewer ${v.url}${v.reused ? " (already running)" : ""}`);
      return v.url;
    })
    .catch((e) => {
      log("viewer failed:", e);
      viewerPromise = null;
      return null;
    });
  return viewerPromise;
}

// ---------- helpers ----------

type Content = CallToolResult["content"];

function ok(text: string, extra: Content = []): CallToolResult {
  return { content: [{ type: "text", text }, ...extra] };
}

function imageContent(png: Buffer): Content[number] {
  return { type: "image", data: png.toString("base64"), mimeType: "image/png" };
}

async function run(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  void ensureViewer();
  try {
    return await fn();
  } catch (e) {
    return { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
  }
}

/** Load → mutate → save under a per-asset lock, then point the viewer at it. */
async function edit<T>(name: string, fn: (doc: PixelDoc) => Promise<T> | T): Promise<{ doc: PixelDoc; result: T; name: string }> {
  const n = validateName(name);
  return ws.withLock(n, async () => {
    const doc = await ws.load(n);
    const result = await fn(doc);
    await ws.save(n, doc);
    await ws.setFocus(n);
    return { doc, result, name: n };
  });
}

function summary(name: string, doc: PixelDoc): string {
  const layers = doc.layers.map((l) => (l.visible ? l.name : `${l.name} (hidden)`)).join(", ");
  const tags = doc.tags.length ? ` · tags: ${doc.tags.map((t) => `${t.name} ${t.from}–${t.to}`).join(", ")}` : "";
  const slices = doc.slices.length ? ` · slices: ${doc.slices.map((s) => (s.center ? `${s.name} (9-slice)` : s.name)).join(", ")}` : "";
  return (
    `"${name}" ${doc.width}×${doc.height} · ${doc.frames.length} frame${doc.frames.length > 1 ? "s" : ""}` +
    ` · layers (bottom→top): ${layers} · palette ${doc.paletteName ?? "custom"} (${doc.palette.length} colors)${tags}${slices}`
  );
}

function legend(doc: PixelDoc): string {
  const items = doc.palette.map((hex, i) => `${indexToChar(i)}=${hex} L${String(lightness(hex)).padStart(2)}`);
  const lines: string[] = [];
  for (let i = 0; i < items.length; i += 4) lines.push("  " + items.slice(i, i + 4).join("   "));
  return lines.join("\n") + '\n  "." = transparent';
}

function framePreview(doc: PixelDoc, frame: number): Content {
  const p = renderPreview(doc, { frames: [frame] });
  return [{ type: "text", text: p.description }, imageContent(p.png)];
}

const loadPalette = async (asset: string) => {
  const d = await ws.load(asset);
  return { colors: d.palette, ...(d.paletteName ? { name: d.paletteName } : {}) };
};

// ---------- schemas ----------

const zName = z.string().describe('Asset name, e.g. "slime" or "characters/hero" (folders allowed).');
const zColor = z
  .union([z.number().int(), z.string()])
  .describe('Legend character ("a"), palette index (10), exact palette hex ("#be4a2f"), or "." for transparent.');
const zPoint = z.array(z.number().int()).length(2).describe("[x, y]");
const zInt = z.number().int();
const zPos = z.number().int().min(1);
const zRegion = z.object({ x: zInt, y: zInt, w: zPos, h: zPos });
const zOnlyOn = z
  .array(zColor)
  .optional()
  .describe('Mask: only paint over pixels that currently have one of these colors ("." = empty pixels).');
const zPalette = z
  .object({
    preset: z.string().optional().describe(`Built-in: ${Object.keys(PRESETS).join(", ")}.`),
    colors: z.array(z.string()).optional().describe("Custom list of #rrggbb colors."),
    lospec: z.string().optional().describe('Lospec palette slug, e.g. "resurrect-64" (downloaded from lospec.com).'),
    fromAsset: z.string().optional().describe("Copy another asset's palette."),
  })
  .describe(`Palette source: give exactly one field. Default: ${DEFAULT_PRESET}.`);

const zOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("pixel"), points: z.array(zPoint).min(1), color: zColor, onlyOn: zOnlyOn }),
  z.object({
    op: z.literal("line"),
    points: z.array(zPoint).min(2).describe("Polyline vertices; pixel-perfect Bresenham segments."),
    closed: z.boolean().optional(),
    color: zColor,
    onlyOn: zOnlyOn,
  }),
  z.object({ op: z.literal("rect"), x: zInt, y: zInt, w: zPos, h: zPos, color: zColor, fill: z.boolean().optional(), onlyOn: zOnlyOn }),
  z.object({
    op: z.literal("ellipse"),
    x: zInt,
    y: zInt,
    w: zPos,
    h: zPos,
    color: zColor,
    fill: z.boolean().optional(),
    onlyOn: zOnlyOn,
  }).describe("Ellipse inscribed in the box x,y,w,h."),
  z.object({
    op: z.literal("fill"),
    x: zInt,
    y: zInt,
    color: zColor,
    contiguous: z.boolean().optional().describe("false = replace that color everywhere in the cel."),
  }).describe("Flood fill (4-connected) from x,y."),
  z.object({ op: z.literal("replace"), from: zColor, to: zColor, region: zRegion.optional() }),
  z.object({
    op: z.literal("outline"),
    color: zColor,
    mode: z.enum(["outer", "inner"]).optional().describe("outer (default): around opaque pixels; inner: on their edge."),
    corners: z.boolean().optional().describe("Include diagonal neighbors (8-connected). Default false = rounder."),
    refresh: z
      .boolean()
      .optional()
      .describe("Rebuild: remove this color where it touches empty space, then outline again. Use after moving or reshaping outlined parts (fixes gaps and doubles)."),
  }),
  z.object({
    op: z.literal("mirror"),
    axis: z.enum(["x", "y"]).describe('"x" copies one half onto the other horizontally (left↔right); "y" vertically.'),
    from: z.enum(["left", "right", "top", "bottom"]).optional().describe("Source half. Default left / top."),
  }),
  z.object({ op: z.literal("flip"), axis: z.enum(["x", "y"]) }),
  z.object({ op: z.literal("shift"), dx: zInt, dy: zInt, wrap: z.boolean().optional() }),
  z.object({ op: z.literal("clear"), region: zRegion.optional() }),
  z.object({
    op: z.literal("copy"),
    x: zInt,
    y: zInt,
    w: zPos,
    h: zPos,
    toX: zInt,
    toY: zInt,
    fromFrame: zInt.optional(),
    fromLayer: z.string().optional(),
    cut: z.boolean().optional().describe("Clear the source region (move instead of copy)."),
    includeTransparent: z.boolean().optional().describe("Also copy empty pixels (default: skip them)."),
  }).describe("Copy a region (optionally from another frame/layer) to toX,toY."),
  z.object({
    op: z.literal("dither"),
    x: zInt,
    y: zInt,
    w: zPos,
    h: zPos,
    color: zColor,
    pattern: z.enum(["checker", "sparse", "dense"]).optional().describe("checker 50%, sparse 25%, dense 75%."),
    onlyOn: zOnlyOn,
  }),
]);

const zFrameOp = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("add"),
    at: zInt.optional().describe("Insert position (default: end)."),
    copyFrom: zInt.optional().describe("Duplicate this frame's pixels (all layers)."),
    count: z.number().int().min(1).max(64).optional(),
    duration: zInt.optional().describe("ms (default: copied frame's or 100)."),
  }),
  z.object({ action: z.literal("delete"), index: zInt }),
  z.object({ action: z.literal("move"), from: zInt, to: zInt }),
  z.object({ action: z.literal("duration"), ms: zInt, index: zInt.optional().describe("Omit to set all frames.") }),
  z.object({
    action: z.literal("tag"),
    name: z.string().min(1).max(40),
    from: zInt,
    to: zInt,
    direction: z.enum(["forward", "reverse", "pingpong"]).optional(),
  }).describe("Name a frame range (e.g. idle 0–3). Replaces a tag with the same name."),
  z.object({ action: z.literal("untag"), name: z.string() }),
]);

const zLayerOp = z.discriminatedUnion("action", [
  z.object({ action: z.literal("add"), name: z.string(), at: zInt.optional().describe("Index in the bottom→top list (default: top).") }),
  z.object({ action: z.literal("delete"), name: z.string() }),
  z.object({ action: z.literal("rename"), name: z.string(), to: z.string() }),
  z.object({ action: z.literal("move"), name: z.string(), to: zInt.describe("New index, 0 = bottom.") }),
  z.object({ action: z.literal("visibility"), name: z.string(), visible: z.boolean() }),
  z.object({ action: z.literal("merge_down"), name: z.string().describe("Merged into the layer below it.") }),
]);

// ---------- server ----------

const INSTRUCTIONS = `Dotquill is a local pixel-art studio. You draw palette-indexed pixels; the user watches live in a browser viewer (open_viewer) and exports assets for their game.
Before your first drawing in a session, read guide (topic "workflow"); read other topics when relevant (sprites, shading, outlines, animation, tiles, palettes, ui).
Coordinates: x → right, y ↓ down, (0,0) top-left. One character per pixel from the palette legend; "." = transparent.
Always check your work with render_preview (rulers, grid, actual-size copies) and fix problems before calling an asset done; run audit at the end.
Assets are files <workspace>/<name>.pixel.json (workspace: ${ws.root}). Exports go to <workspace>/exports unless outDir is given.`;

const server = new McpServer({ name: "dotquill", version: VERSION }, { instructions: INSTRUCTIONS });

server.registerTool(
  "guide",
  {
    title: "Pixel-art guide",
    description: `Pixel-art techniques and the recommended workflow for this tool. Read "workflow" before your first drawing. Topics: ${GUIDE_TOPICS.join(", ")}, all.`,
    inputSchema: { topic: z.enum(["all", ...GUIDE_TOPICS]).optional().describe('Default "workflow".') },
    annotations: { readOnlyHint: true },
  },
  async ({ topic }) =>
    run(async () => ok(topic === "all" ? GUIDE_TOPICS.map((t) => GUIDE[t]).join("\n\n") : GUIDE[topic ?? "workflow"])),
);

server.registerTool(
  "list_assets",
  {
    title: "List assets",
    description: "Lists all assets in the workspace with size, frames and palette.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () =>
    run(async () => {
      const items = await ws.list();
      if (!items.length) return ok(`No assets yet in ${ws.root}. Create one with create_asset.`);
      const lines = items.map((a) =>
        a.error
          ? `- ${a.name}: unreadable (${a.error})`
          : `- ${a.name}: ${a.width}×${a.height}, ${a.frames} frame(s), ${a.layers} layer(s), palette ${a.paletteName ?? "custom"} (${a.colors})`,
      );
      return ok(`${items.length} asset(s) in ${ws.root}:\n${lines.join("\n")}`);
    }),
);

server.registerTool(
  "create_asset",
  {
    title: "Create asset",
    description:
      "Creates a new sprite/tile/icon canvas. Returns the palette legend (character → color) used for writing pixels. Optionally fills frame 0 of the bottom layer from rows.",
    inputSchema: {
      name: zName,
      width: z.number().int().min(1).max(512),
      height: z.number().int().min(1).max(512),
      palette: zPalette.optional(),
      layers: z.array(z.string()).optional().describe('Layer names bottom→top. Default ["main"].'),
      frames: z.number().int().min(1).max(MAX_FRAMES).optional(),
      frameDuration: z.number().int().optional().describe("ms per frame (default 100)."),
      rows: z.array(z.string()).optional().describe("Initial pixels for frame 0, bottom layer (one string per row)."),
      notes: z.string().optional().describe("Intent / style notes kept with the asset."),
      overwrite: z.boolean().optional(),
    },
  },
  async (a) =>
    run(async () => {
      const name = validateName(a.name);
      return ws.withLock(name, async () => {
        if (!a.overwrite && (await ws.exists(name))) {
          throw new Error(`Asset "${name}" already exists. Pass overwrite:true or choose another name.`);
        }
        const pal = await resolvePalette(a.palette, loadPalette);
        const doc = PixelDoc.create({
          width: a.width,
          height: a.height,
          palette: pal.colors,
          ...(pal.name ? { paletteName: pal.name } : {}),
          ...(a.layers ? { layers: a.layers } : {}),
          ...(a.frames ? { frames: a.frames } : {}),
          ...(a.frameDuration ? { frameDuration: a.frameDuration } : {}),
          ...(a.notes ? { notes: a.notes } : {}),
        });
        const extra: string[] = [];
        if (a.rows?.length) {
          const r = writeRows(doc, 0, doc.layers[0].name, a.rows);
          extra.push(`Wrote ${r.changed} px from rows.`, ...r.warnings);
        }
        await ws.save(name, doc);
        await ws.setFocus(name);
        const url = await ensureViewer();
        return ok(
          [
            `Created ${summary(name, doc)}`,
            ...extra,
            "Palette legend (char=color, L=lightness 0-100):",
            legend(doc),
            url ? `Viewer: ${url}#${encodeURIComponent(name)}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        );
      });
    }),
);

server.registerTool(
  "get_asset",
  {
    title: "Read asset pixels",
    description:
      "Returns asset info, the palette legend and pixel rows with x/y rulers (composite of visible layers unless layer is given). Use it to read exact pixels before editing.",
    inputSchema: {
      name: zName,
      frame: zInt.optional().describe("Default 0."),
      allFrames: z.boolean().optional(),
      layer: z.string().optional().describe("Show a single layer instead of the composite."),
      rulers: z.boolean().optional().describe("Default true. false = plain rows you can paste back into write_pixels."),
    },
    annotations: { readOnlyHint: true },
  },
  async (a) =>
    run(async () => {
      const name = validateName(a.name);
      const doc = await ws.load(name);
      const frames = a.allFrames ? doc.frames.map((_, i) => i) : [doc.checkFrame(a.frame ?? 0)];
      const layer = a.layer !== undefined ? doc.resolveLayer(a.layer) : undefined;
      const out = [summary(name, doc)];
      if (doc.notes) out.push(`Notes: ${doc.notes}`);
      out.push("Palette legend:", legend(doc));
      if (doc.slices.length) out.push("Slices:", ...doc.slices.map((s) => `  ${describeSlice(s)}`));
      for (const f of frames) {
        const rows = encodeRows(doc.composite(f, layer ? { layer } : {}), doc.width, doc.height);
        out.push(
          `\nFrame ${f} (${doc.frames[f].duration} ms), ${layer ? `layer "${layer}"` : "visible layers"}:`,
          a.rulers === false ? rows.join("\n") : formatGrid(rows, doc.width),
        );
      }
      return ok(out.join("\n"));
    }),
);

server.registerTool(
  "write_pixels",
  {
    title: "Write pixel rows",
    description:
      'Writes rows of palette characters into a frame/layer at (x, y). "." = transparent, "_" = keep existing pixel. Best for organic shapes and whole sprites. Rows may be shorter than the canvas (region write).',
    inputSchema: {
      name: zName,
      rows: z.array(z.string()).min(1).describe('One string per row, one character per pixel. No spaces.'),
      x: zInt.optional().describe("Left of the region (default 0)."),
      y: zInt.optional().describe("Top of the region (default 0)."),
      frame: zInt.optional().describe("Default 0."),
      layer: z.string().optional().describe("Default: bottom layer."),
      preview: z.boolean().optional().describe("Return a rendered preview of the frame."),
    },
  },
  async (a) =>
    run(async () => {
      const frame = a.frame ?? 0;
      const { doc, result, name } = await edit(a.name, (d) => {
        d.checkFrame(frame);
        const layer = d.resolveLayer(a.layer);
        return { layer, ...writeRows(d, frame, layer, a.rows, a.x ?? 0, a.y ?? 0) };
      });
      const text = [
        `"${name}" frame ${frame}, layer "${result.layer}": ${result.changed} px changed (${a.rows.length} rows at ${a.x ?? 0},${a.y ?? 0}).`,
        ...result.warnings.map((w) => `⚠ ${w}`),
      ].join("\n");
      return ok(text, a.preview ? framePreview(doc, frame) : []);
    }),
);

server.registerTool(
  "draw",
  {
    title: "Draw operations",
    description:
      "Applies drawing ops in order to one layer of one frame, a list of frames, or all frames: pixel, line (polyline), rect, ellipse, fill, replace, outline, mirror, flip, shift, clear, copy, dither. Colors are legend characters, indices, palette hex or \".\". Most ops accept onlyOn to paint only over certain colors (great for shading inside a shape).",
    inputSchema: {
      name: zName,
      ops: z.array(zOp).min(1),
      frame: zInt.optional().describe("Default 0."),
      frames: z.array(zInt).min(1).optional().describe("Apply the same ops to each of these frames (overrides frame)."),
      allFrames: z.boolean().optional().describe("Apply the same ops to every frame (overrides frames)."),
      layer: z.string().optional().describe("Default: bottom layer."),
      preview: z.boolean().optional().describe("Return a rendered preview of the (first) frame."),
    },
  },
  async (a) =>
    run(async () => {
      const { doc, result, name } = await edit(a.name, (d) => {
        const layer = d.resolveLayer(a.layer);
        const frames = a.allFrames
          ? d.frames.map((_, i) => i)
          : a.frames?.length
            ? [...new Set(a.frames.map((f) => d.checkFrame(f)))]
            : [d.checkFrame(a.frame ?? 0)];
        const lines: string[] = [];
        for (const f of frames) {
          const r = applyOps(d, f, layer, a.ops as DrawOp[]);
          lines.push(frames.length > 1 ? `frame ${f}: ${r.join("; ")}` : r.join("\n"));
        }
        return { layer, frames, lines };
      });
      const text = `"${name}" layer "${result.layer}":\n${result.lines.join("\n")}`;
      return ok(text, a.preview ? framePreview(doc, result.frames[0]) : []);
    }),
);

server.registerTool(
  "render_preview",
  {
    title: "Render preview",
    description:
      "Renders the asset as an image for you to inspect: zoomed with x/y rulers and a pixel grid (blue every 8 px), checkerboard transparency, 9-slice guides, plus actual-size 1× and 2× copies. Shows all frames side by side by default. Use tile:true to check seamless tiles, diff:true to check animation, stretch:[w,h] to check UI resizing.",
    inputSchema: {
      name: zName,
      frames: z.array(zInt).optional().describe("Frames to show (default all, max 16)."),
      zoom: z.number().int().min(1).max(48).optional().describe("Default: automatic."),
      grid: z.boolean().optional(),
      background: z.string().optional().describe('"checker" (default) or #rrggbb, e.g. the game background color.'),
      layer: z.string().optional().describe("Show only this layer."),
      tile: z.boolean().optional().describe("Repeat 3×3 to check seams."),
      diff: z
        .boolean()
        .optional()
        .describe("Outline (magenta) every pixel that changed since the previous frame; frame 0 is compared with the last. Lists changed-pixel counts."),
      stretch: z
        .array(z.number().int().min(1).max(512))
        .length(2)
        .optional()
        .describe("[w, h]: show the frames resized through the 9-slice to this size, e.g. [96, 40]. Checks that a panel or button resizes cleanly."),
      slice: z.string().optional().describe("Slice for stretch (default: the first 9-slice)."),
    },
    annotations: { readOnlyHint: true },
  },
  async (a) =>
    run(async () => {
      const name = validateName(a.name);
      const doc = await ws.load(name);
      const p = renderPreview(doc, {
        ...(a.frames ? { frames: a.frames } : {}),
        ...(a.zoom ? { zoom: a.zoom } : {}),
        ...(a.grid !== undefined ? { grid: a.grid } : {}),
        ...(a.background ? { background: a.background } : {}),
        ...(a.layer !== undefined ? { layer: a.layer } : {}),
        ...(a.tile ? { tile: true } : {}),
        ...(a.diff ? { diff: true } : {}),
        ...(a.stretch ? { stretch: [a.stretch[0], a.stretch[1]] as [number, number] } : {}),
        ...(a.slice !== undefined ? { slice: a.slice } : {}),
      });
      return ok(`${summary(name, doc)}\n${p.description}`, [imageContent(p.png)]);
    }),
);

server.registerTool(
  "palette",
  {
    title: "Palette",
    description:
      'Palette tools. "presets": list built-in palettes. "set": switch an asset to another palette (remap nearest or by index). "edit": change one color (recolors its pixels). "add": append colors.',
    inputSchema: {
      action: z.enum(["presets", "set", "edit", "add"]),
      name: zName.optional().describe("Asset (not needed for presets)."),
      palette: zPalette.optional().describe("For set."),
      remap: z.enum(["nearest", "index"]).optional().describe('For set: "nearest" (default) maps pixels to the closest new color; "index" keeps indices (palette swap).'),
      index: zColor.optional().describe("For edit: which entry (character or index)."),
      color: z.string().optional().describe("For edit: new #rrggbb."),
      colors: z.array(z.string()).optional().describe("For add: #rrggbb colors."),
    },
  },
  async (a) =>
    run(async () => {
      if (a.action === "presets") {
        const lines = Object.entries(PRESETS).map(([k, p]) => `- ${k} (${p.colors.length}): ${p.description}`);
        return ok(
          `Built-in palettes:\n${lines.join("\n")}\nAny Lospec palette also works: { "lospec": "<slug>" } (see https://lospec.com/palette-list).`,
        );
      }
      if (!a.name) throw new Error(`"name" is required for action "${a.action}".`);
      const spec: PaletteSpec | undefined = a.palette;
      const resolved = a.action === "set" ? await resolvePalette(spec, loadPalette) : null;
      const { doc, result, name } = await edit(a.name, (d) => {
        if (a.action === "set") {
          const next = resolved!.colors;
          const usage = d.colorUsage();
          if ((a.remap ?? "nearest") === "index") {
            const maxUsed = usage.reduce((m, n, i) => (n > 0 ? i : m), -1);
            if (maxUsed >= next.length) {
              throw new Error(`Pixels use index ${maxUsed} but the new palette has only ${next.length} colors. Use remap "nearest".`);
            }
            d.palette = next;
          } else {
            const m = new ColorMatcher(next);
            const map = d.palette.map((hex) => m.nearest(parseHex(hex)));
            d.remap((i) => map[i]);
            d.palette = next;
          }
          d.paletteName = resolved!.name;
          return `Palette set to ${resolved!.name ?? "custom"} (${next.length} colors, remap ${a.remap ?? "nearest"}).`;
        }
        if (a.action === "edit") {
          if (a.index === undefined || !a.color) throw new Error("edit needs index and color.");
          const i = resolveColor(a.index, d.palette);
          if (i < 0) throw new Error("Cannot edit the transparent entry.");
          const hex = normalizeHex(a.color);
          const dup = d.palette.indexOf(hex);
          if (dup >= 0 && dup !== i) throw new Error(`${hex} is already in the palette as "${indexToChar(dup)}".`);
          const old = d.palette[i];
          d.palette[i] = hex;
          d.paletteName = undefined;
          return `"${indexToChar(i)}" changed ${old} → ${hex}; all its pixels are recolored.`;
        }
        if (!a.colors?.length) throw new Error("add needs colors.");
        const before = d.palette.length;
        const merged = validatePalette([...d.palette, ...a.colors]);
        if (merged.length > MAX_COLORS) throw new Error(`Palette would exceed ${MAX_COLORS} colors.`);
        d.palette = merged;
        d.paletteName = undefined;
        return `Added ${merged.length - before} color(s); palette now has ${merged.length}.`;
      });
      return ok(`${result}\n${summary(name, doc)}\nPalette legend:\n${legend(doc)}`);
    }),
);

server.registerTool(
  "frames",
  {
    title: "Frames & tags",
    description:
      "Animation frames: add (optionally copying a frame), delete, move, set durations, and name ranges with tags (idle, walk…). Ops run in order.",
    inputSchema: { name: zName, ops: z.array(zFrameOp).min(1) },
  },
  async (a) =>
    run(async () => {
      const { doc, result, name } = await edit(a.name, (d) => {
        const notes: string[] = [];
        for (const op of a.ops) {
          switch (op.action) {
            case "add": {
              const count = op.count ?? 1;
              const at = op.at ?? d.frames.length;
              if (!Number.isInteger(at) || at < 0 || at > d.frames.length) throw new Error(`add: at must be 0..${d.frames.length}.`);
              if (d.frames.length + count > MAX_FRAMES) throw new Error(`Max ${MAX_FRAMES} frames.`);
              const src = op.copyFrom !== undefined ? d.frames[d.checkFrame(op.copyFrom)] : null;
              const duration = checkDuration(op.duration ?? src?.duration ?? 100);
              const fresh = Array.from({ length: count }, () => ({
                duration,
                cels: new Map(src ? [...src.cels].map(([k, v]) => [k, v.slice()] as const) : []),
              }));
              d.frames.splice(at, 0, ...fresh);
              for (const t of d.tags) {
                if (t.from >= at) {
                  t.from += count;
                  t.to += count;
                } else if (t.to >= at) t.to += count;
              }
              notes.push(`added ${count} frame(s) at ${at}${src ? ` copied from ${op.copyFrom}` : ""}`);
              break;
            }
            case "delete": {
              d.checkFrame(op.index);
              if (d.frames.length === 1) throw new Error("Cannot delete the only frame.");
              d.frames.splice(op.index, 1);
              d.tags = d.tags
                .map((t) => ({
                  ...t,
                  from: t.from > op.index ? t.from - 1 : t.from,
                  to: t.to >= op.index ? t.to - 1 : t.to,
                }))
                .filter((t) => t.to >= t.from);
              notes.push(`deleted frame ${op.index}`);
              break;
            }
            case "move": {
              d.checkFrame(op.from);
              d.checkFrame(op.to);
              const [f] = d.frames.splice(op.from, 1);
              d.frames.splice(op.to, 0, f);
              notes.push(`moved frame ${op.from} → ${op.to} (tags unchanged)`);
              break;
            }
            case "duration": {
              const ms = checkDuration(op.ms);
              if (op.index !== undefined) d.frames[d.checkFrame(op.index)].duration = ms;
              else for (const f of d.frames) f.duration = ms;
              notes.push(`duration ${ms} ms on ${op.index !== undefined ? `frame ${op.index}` : "all frames"}`);
              break;
            }
            case "tag": {
              d.checkFrame(op.from);
              d.checkFrame(op.to);
              if (op.to < op.from) throw new Error("tag: to must be ≥ from.");
              const tag = { name: op.name.trim(), from: op.from, to: op.to, direction: (op.direction ?? "forward") as TagDirection };
              d.tags = [...d.tags.filter((t) => t.name !== tag.name), tag].sort((x, y) => x.from - y.from);
              notes.push(`tag ${tag.name} = ${tag.from}–${tag.to}`);
              break;
            }
            case "untag": {
              const before = d.tags.length;
              d.tags = d.tags.filter((t) => t.name !== op.name);
              if (d.tags.length === before) throw new Error(`No tag "${op.name}".`);
              notes.push(`removed tag ${op.name}`);
              break;
            }
          }
        }
        return notes;
      });
      const frames = doc.frames.map((f, i) => `${i}:${f.duration}ms`).join(" ");
      return ok(`${result.join("; ")}.\n${summary(name, doc)}\nFrames: ${frames}`);
    }),
);

server.registerTool(
  "layers",
  {
    title: "Layers",
    description: "Layer management: add, delete, rename, move (0 = bottom), visibility, merge_down. Ops run in order.",
    inputSchema: { name: zName, ops: z.array(zLayerOp).min(1) },
  },
  async (a) =>
    run(async () => {
      const { doc, result, name } = await edit(a.name, (d) => {
        const notes: string[] = [];
        const idx = (n: string) => d.layers.findIndex((l) => l.name === d.resolveLayer(n));
        for (const op of a.ops) {
          switch (op.action) {
            case "add": {
              const ln = validateLayerName(op.name);
              if (d.layers.some((l) => l.name.toLowerCase() === ln.toLowerCase())) throw new Error(`Layer "${ln}" exists.`);
              const at = op.at ?? d.layers.length;
              if (at < 0 || at > d.layers.length) throw new Error(`add: at must be 0..${d.layers.length}.`);
              d.layers.splice(at, 0, { name: ln, visible: true });
              notes.push(`added layer "${ln}" at ${at}`);
              break;
            }
            case "delete": {
              if (d.layers.length === 1) throw new Error("Cannot delete the only layer.");
              const i = idx(op.name);
              const [l] = d.layers.splice(i, 1);
              for (const f of d.frames) f.cels.delete(l.name);
              notes.push(`deleted layer "${l.name}"`);
              break;
            }
            case "rename": {
              const i = idx(op.name);
              const to = validateLayerName(op.to);
              if (d.layers.some((l, j) => j !== i && l.name.toLowerCase() === to.toLowerCase())) throw new Error(`Layer "${to}" exists.`);
              const from = d.layers[i].name;
              d.layers[i].name = to;
              for (const f of d.frames) {
                const c = f.cels.get(from);
                f.cels.delete(from);
                if (c) f.cels.set(to, c);
              }
              notes.push(`renamed "${from}" → "${to}"`);
              break;
            }
            case "move": {
              const i = idx(op.name);
              if (op.to < 0 || op.to >= d.layers.length) throw new Error(`move: to must be 0..${d.layers.length - 1}.`);
              const [l] = d.layers.splice(i, 1);
              d.layers.splice(op.to, 0, l);
              notes.push(`moved "${l.name}" to ${op.to}`);
              break;
            }
            case "visibility": {
              const l = d.layers[idx(op.name)];
              l.visible = op.visible;
              notes.push(`"${l.name}" ${op.visible ? "shown" : "hidden"}`);
              break;
            }
            case "merge_down": {
              const i = idx(op.name);
              if (i === 0) throw new Error("The bottom layer has nothing below it.");
              const top = d.layers[i].name;
              const below = d.layers[i - 1].name;
              d.frames.forEach((f, fi) => {
                const src = f.cels.get(top);
                if (!src) return;
                const dst = d.cel(fi, below);
                for (let k = 0; k < src.length; k++) if (src[k] >= 0) dst[k] = src[k];
                f.cels.delete(top);
              });
              d.layers.splice(i, 1);
              notes.push(`merged "${top}" into "${below}"`);
              break;
            }
          }
        }
        return notes;
      });
      return ok(`${result.join("; ")}.\n${summary(name, doc)}`);
    }),
);

const zSliceOp = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("set"),
    slice: z.string().describe('Slice name, e.g. "panel". Replaces a slice with the same name.'),
    x: zInt.optional().describe("Bounds (default: the whole canvas)."),
    y: zInt.optional(),
    w: zPos.optional(),
    h: zPos.optional(),
    nine: z
      .object({
        left: z.number().int().min(0),
        top: z.number().int().min(0),
        right: z.number().int().min(0),
        bottom: z.number().int().min(0),
      })
      .optional()
      .describe("9-slice border widths in px: corners keep their size, edges and center stretch. Omit for a plain named region."),
    mode: z
      .enum(["stretch", "tile"])
      .optional()
      .describe('How edges and center fill extra space: "stretch" (default, like Godot) or "tile" (repeat; best for patterned borders).'),
  }),
  z.object({ action: z.literal("delete"), slice: z.string() }),
]);

server.registerTool(
  "slices",
  {
    title: "Slices (9-slice UI)",
    description:
      'Named canvas regions. With nine margins a slice becomes a 9-slice for UI panels, buttons and bars: corners stay fixed, edges and center stretch or tile. Shown as guides in previews; check resizing with render_preview stretch. Exported in sheet JSON (Aseprite slices) and as Godot StyleBoxTexture (export format "godot-stylebox").',
    inputSchema: { name: zName, ops: z.array(zSliceOp).min(1) },
  },
  async (a) =>
    run(async () => {
      const { doc, result, name } = await edit(a.name, (d) => {
        const notes: string[] = [];
        for (const op of a.ops) {
          const sliceName = validateSliceName(op.slice);
          const idx = d.slices.findIndex((s) => s.name.toLowerCase() === sliceName.toLowerCase());
          if (op.action === "delete") {
            if (idx < 0) throw new Error(`No slice "${sliceName}".`);
            d.slices.splice(idx, 1);
            notes.push(`deleted slice ${sliceName}`);
            continue;
          }
          const x = op.x ?? 0;
          const y = op.y ?? 0;
          const bounds = { x, y, w: op.w ?? d.width - x, h: op.h ?? d.height - y };
          const raw: Slice = op.nine
            ? sliceFromMargins(sliceName, bounds, op.nine, op.mode)
            : { name: sliceName, bounds, ...(op.mode ? { mode: op.mode } : {}) };
          const slice = validateSlice(raw, d.width, d.height);
          if (idx >= 0) d.slices[idx] = slice;
          else d.slices.push(slice);
          notes.push(`set ${describeSlice(slice)}`);
        }
        return notes;
      });
      return ok(`${result.join("\n")}\n${summary(name, doc)}`);
    }),
);

server.registerTool(
  "audit",
  {
    title: "Audit",
    description:
      "Automatic pixel-art checks: stray and lone pixels, art touching the canvas edge, empty frames, frame-to-frame bounding-box jitter, color usage. Run before calling an asset done.",
    inputSchema: { name: zName },
    annotations: { readOnlyHint: true },
  },
  async (a) =>
    run(async () => {
      const name = validateName(a.name);
      return ok(audit(await ws.load(name), name));
    }),
);

server.registerTool(
  "export",
  {
    title: "Export",
    description:
      'Exports for games: "png" (one frame), "frames" (one PNG per frame), "sheet" (sprite sheet PNG + Aseprite-compatible JSON with durations, tags and slices), "gif" (animated preview), "godot-stylebox" (9-slice UI: PNG + a Godot StyleBoxTexture .tres per frame; single-frame tags name the states, e.g. normal/hover/pressed), "godot-spriteframes" (animations: sheet PNG + a SpriteFrames .tres with one animation per tag and the frame durations, for AnimatedSprite2D). Writes to <workspace>/exports by default, or to outDir (for Godot use a folder inside the Godot project so texture paths become res://).',
    inputSchema: {
      name: zName,
      format: z.enum(["png", "frames", "sheet", "gif", "godot-stylebox", "godot-spriteframes"]),
      slice: z.string().optional().describe("godot-stylebox: which 9-slice (default: the first)."),
      scale: z.number().int().min(1).max(32).optional().describe("Integer upscale (default 1)."),
      frame: zInt.optional().describe('For "png" (default 0).'),
      tag: z.string().optional().describe("Only this tag's frames."),
      columns: z.number().int().min(1).optional().describe("Sheet columns."),
      padding: z.number().int().min(0).max(64).optional().describe("Sheet spacing in px."),
      outDir: z.string().optional().describe("Absolute path, or relative to the workspace."),
    },
  },
  async (a) =>
    run(async () => {
      const name = validateName(a.name);
      const doc = await ws.load(name);
      const outDir = a.outDir ? path.resolve(ws.root, a.outDir) : ws.exportsDir;
      const godot = a.format.startsWith("godot-");
      const resDir = godot ? await findGodotResDir(outDir) : null;
      const files = buildExport(doc, name, {
        format: a.format,
        ...(a.scale ? { scale: a.scale } : {}),
        ...(a.frame !== undefined ? { frame: a.frame } : {}),
        ...(a.tag ? { tag: a.tag } : {}),
        ...(a.columns ? { columns: a.columns } : {}),
        ...(a.padding !== undefined ? { padding: a.padding } : {}),
        ...(a.slice !== undefined ? { slice: a.slice } : {}),
        ...(resDir ? { resDir } : {}),
      });
      const paths = await writeExport(files, outDir);
      const lines = [`Exported "${name}" (${a.format}) to ${outDir}:`, ...paths.map((p, i) => `- ${p} (${files[i].data.length} bytes)`)];
      if (godot) {
        lines.push(
          resDir
            ? `Godot project found: textures referenced as ${resDir}….`
            : "No project.godot above outDir: the .tres files reference the PNG by a relative path (keep them in the same folder).",
          a.format === "godot-spriteframes"
            ? `Animations: ${godotAnimations(doc, a.tag)
                .map((an) => `${an.name} (${an.frames.length} frames, ${Math.round(an.speed * 100) / 100} fps)`)
                .join(", ")}. Assign the .tres to AnimatedSprite2D → Sprite Frames, then play("<name>").`
            : "Use a .tres as a Panel/Button style (theme_override_styles) or in a Theme.",
          "For crisp pixels set Project Settings → Rendering → Textures → Default Texture Filter = Nearest.",
        );
      }
      return ok(lines.join("\n"));
    }),
);

server.registerTool(
  "import_png",
  {
    title: "Import PNG",
    description:
      "Creates an asset from a PNG: keeps the image's own colors (≤88) or quantizes to a palette; can slice a sprite sheet into frames and downscale upscaled art (e.g. AI-generated images at 8× scale).",
    inputSchema: {
      path: z.string().describe("PNG path: absolute, or relative to the project folder."),
      name: zName,
      palette: zPalette.optional().describe("Quantize to this palette. Omit to keep the image's colors."),
      frameWidth: z.number().int().min(1).optional().describe("Slice into frames of this size (after downscale)."),
      frameHeight: z.number().int().min(1).optional(),
      downscale: z.number().int().min(1).max(64).optional().describe("Divide size by this factor (center sampling)."),
      overwrite: z.boolean().optional(),
    },
  },
  async (a) =>
    run(async () => {
      const name = validateName(a.name);
      const file = path.resolve(process.cwd(), a.path);
      const img = readPNG(await fs.readFile(file));
      const pal = a.palette ? await resolvePalette(a.palette, loadPalette) : undefined;
      const { doc, report } = imageToDoc(img, {
        ...(pal ? { palette: pal } : {}),
        ...(a.frameWidth ? { frameWidth: a.frameWidth } : {}),
        ...(a.frameHeight ? { frameHeight: a.frameHeight } : {}),
        ...(a.downscale ? { downscale: a.downscale } : {}),
      });
      return ws.withLock(name, async () => {
        if (!a.overwrite && (await ws.exists(name))) throw new Error(`Asset "${name}" already exists. Pass overwrite:true.`);
        await ws.save(name, doc);
        await ws.setFocus(name);
        return ok(`${report.join("\n")}\nCreated ${summary(name, doc)}\nPalette legend:\n${legend(doc)}`);
      });
    }),
);

server.registerTool(
  "manage_asset",
  {
    title: "Manage asset",
    description:
      'duplicate (to a new name, e.g. for variants), rename, delete (moved to .dotquill/trash), undo (restore the previous saved version; repeatable), or notes (replace the intent/style notes; keep them in sync with the art).',
    inputSchema: {
      action: z.enum(["duplicate", "rename", "delete", "undo", "notes"]),
      name: zName,
      to: zName.optional().describe("New name for duplicate/rename."),
      notes: z.string().max(2000).optional().describe('For notes: the new text ("" clears).'),
    },
  },
  async (a) =>
    run(async () => {
      const name = validateName(a.name);
      switch (a.action) {
        case "notes": {
          if (a.notes === undefined) throw new Error('notes needs "notes" (use "" to clear).');
          await edit(name, (d) => {
            d.notes = a.notes!.trim();
          });
          return ok(a.notes.trim() ? `Notes of "${name}" updated.` : `Notes of "${name}" cleared.`);
        }
        case "duplicate":
        case "rename": {
          if (!a.to) throw new Error(`${a.action} needs "to".`);
          const to = validateName(a.to);
          if (a.action === "rename") {
            await ws.withLock(name, () => ws.rename(name, to));
          } else {
            const doc = await ws.load(name);
            await ws.withLock(to, async () => {
              if (await ws.exists(to)) throw new Error(`Asset "${to}" already exists.`);
              await ws.save(to, doc, { history: false });
            });
          }
          await ws.setFocus(to);
          return ok(`${a.action === "rename" ? "Renamed" : "Duplicated"} "${name}" → "${to}".`);
        }
        case "delete": {
          const dest = await ws.withLock(name, () => ws.remove(name));
          return ok(`Deleted "${name}" (moved to ${dest}).`);
        }
        case "undo": {
          const done = await ws.withLock(name, () => ws.undo(name));
          if (!done) return ok(`Nothing to undo for "${name}".`);
          await ws.setFocus(name);
          return ok(`Restored the previous version of "${name}" (${await ws.historyCount(name)} more undo step(s) available).`);
        }
      }
    }),
);

server.registerTool(
  "open_viewer",
  {
    title: "Open viewer",
    description:
      "Returns the local viewer URL (live gallery, animation playback, export buttons) and opens it in the user's browser. Optionally focuses an asset.",
    inputSchema: {
      name: zName.optional(),
      open: z.boolean().optional().describe("Open the browser (default true)."),
    },
  },
  async (a) =>
    run(async () => {
      const url = await ensureViewer();
      if (!url) throw new Error("The viewer is disabled (DOTQUILL_NO_VIEWER) or could not start; see server logs.");
      let target = url;
      if (a.name) {
        const name = validateName(a.name);
        await ws.setFocus(name);
        target = `${url}#${encodeURIComponent(name)}`;
      }
      if (a.open !== false) openBrowser(target);
      return ok(`Viewer: ${target}${a.open !== false ? " (opened in the browser)" : ""}`);
    }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
// Exit with the client even if viewer connections (SSE) are still open.
process.stdin.on("end", () => process.exit(0));
process.stdin.on("close", () => process.exit(0));
log(`v${VERSION} ready · workspace ${ws.root}`);
