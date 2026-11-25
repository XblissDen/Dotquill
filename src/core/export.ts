import { promises as fs } from "node:fs";
import path from "node:path";
import gifenc from "gifenc";
import { Bitmap, paletteRGB } from "./bitmap.ts";
import type { PixelDoc } from "./doc.ts";
import { VERSION } from "./version.ts";

export type ExportFormat = "png" | "frames" | "sheet" | "gif";
export const EXPORT_FORMATS: readonly ExportFormat[] = ["png", "frames", "sheet", "gif"];

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
      const cols = Math.max(1, Math.min(n, o.columns ?? (n <= 16 ? n : Math.ceil(Math.sqrt(n)))));
      const rows = Math.ceil(n / cols);
      const pad = Math.max(0, o.padding ?? 0);
      const sheetW = cols * W + (cols - 1) * pad;
      const sheetH = rows * H + (rows - 1) * pad;
      const sheet = new Bitmap(sheetW, sheetH);
      const base = name.split("/").pop()!;
      const image = `${base}_sheet${suffix}.png`;
      const entries = frames.map((f, k) => {
        const x = (k % cols) * (W + pad);
        const y = Math.floor(k / cols) * (H + pad);
        sheet.drawIndexed(composite(f), doc.width, doc.height, pal, x, y, scale);
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
          slices: [],
        },
      };
      return [
        { path: `${name}_sheet${suffix}.png`, data: sheet.toPNG(), mime: "image/png" },
        { path: `${name}_sheet${suffix}.json`, data: Buffer.from(JSON.stringify(json, null, 2)), mime: "application/json" },
      ];
    }
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
