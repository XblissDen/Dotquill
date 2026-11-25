import { Bitmap, paletteRGB, type RGBA } from "./bitmap.ts";
import { parseHex } from "./color.ts";
import type { PixelDoc } from "./doc.ts";

export interface PreviewOptions {
  frames?: number[];
  zoom?: number;
  grid?: boolean;
  /** "checker" (default) or a #rrggbb color. */
  background?: string;
  /** Show only this layer instead of the visible-layer composite. */
  layer?: string;
  /** Repeat the frame 3×3 to check seamless tiles. */
  tile?: boolean;
  /** Outline pixels that changed since the previous frame (frame 0 vs the last). */
  diff?: boolean;
}

export interface Preview {
  png: Buffer;
  description: string;
  zoom: number;
}

const PAGE: RGBA = [24, 24, 30, 255];
const CHECK_A: RGBA = [58, 58, 68, 255];
const CHECK_B: RGBA = [74, 74, 86, 255];
const SMALL_BG: RGBA = [58, 58, 68, 255];
const RULER: RGBA = [165, 165, 180, 255];
const BORDER: RGBA = [110, 110, 125, 255];
const GRID_MINOR: RGBA = [128, 128, 140, 70];
const GRID_MAJOR: RGBA = [0, 190, 255, 150];
const TILE_MARK: RGBA = [255, 138, 76, 210];
const DIFF_MARK: RGBA = [255, 0, 200, 255];
const DIFF_FILL: RGBA = [255, 0, 200, 150];
export const MAX_PREVIEW_FRAMES = 16;

function rulerStep(zoom: number, maxCoord: number, fs: number): number {
  const need = Bitmap.textWidth(String(maxCoord), fs) + 6;
  for (const s of [1, 2, 4, 8, 16, 32, 64, 128, 256]) if (s * zoom >= need) return s;
  return 512;
}

/**
 * Renders a zoomed preview meant for a model's eyes: rulers with pixel coordinates,
 * a pixel grid (blue every 8 px), checkerboard transparency and actual-size copies.
 */
export function renderPreview(doc: PixelDoc, opts: PreviewOptions = {}): Preview {
  const all = doc.frames.map((_, i) => i);
  const frames = (opts.frames?.length ? opts.frames : all).slice(0, MAX_PREVIEW_FRAMES);
  for (const f of frames) doc.checkFrame(f);
  const layer = opts.layer !== undefined ? doc.resolveLayer(opts.layer) : undefined;
  const tile = !!opts.tile;
  const reps = tile ? 3 : 1;
  const W = doc.width;
  const H = doc.height;
  const cw = W * reps;
  const ch = H * reps;
  const n = frames.length;
  const gap = 14;
  const margin = 10;
  const auto = Math.floor(Math.min((1100 - gap * (n - 1)) / (cw * n), 640 / ch));
  const zoom = Math.max(1, Math.min(48, Math.round(opts.zoom ?? Math.min(24, auto))));
  const grid = opts.grid ?? (zoom >= 6 && !tile);
  const rulers = zoom >= 4 && !tile;
  const fs = 2;
  const step = rulers ? rulerStep(zoom, Math.max(W, H) - 1, fs) : 0;
  const rulerLeft = rulers ? Bitmap.textWidth(String(H - 1), fs) + 10 : 0;
  const rulerTop = rulers ? 5 * fs + 8 : 0;
  const pw = cw * zoom;
  const ph = ch * zoom;
  const panelsW = n * pw + (n - 1) * gap;
  const small = tile ? [] : [1, 2];
  const groupW = (s: number) => n * W * s + (n - 1) * 4;
  const stripW = small.reduce((acc, s, i) => acc + groupW(s) + (i ? gap * 2 : 0), 0);
  const stripH = small.length ? H * 2 : 0;
  const imgW = margin * 2 + rulerLeft + Math.max(panelsW, stripW);
  const imgH = margin * 2 + rulerTop + ph + (stripH ? gap + stripH : 0);

  const bmp = new Bitmap(imgW, imgH, PAGE);
  const pal = paletteRGB(doc.palette);
  const solidRGB = opts.background && opts.background !== "checker" ? parseHex(opts.background) : null;
  const solid: RGBA | null = solidRGB ? [solidRGB[0], solidRGB[1], solidRGB[2], 255] : null;
  const composites = frames.map((f) => doc.composite(f, layer ? { layer } : {}));
  const x0 = margin + rulerLeft;
  const y0 = margin + rulerTop;
  const total = doc.frames.length;
  const diff = !!opts.diff && total > 1;
  const changed: number[] = [];

  composites.forEach((comp, k) => {
    const px = x0 + k * (pw + gap);
    bmp.strokeRect(px - 1, y0 - 1, pw + 2, ph + 2, BORDER);
    if (solid) bmp.fillRect(px, y0, pw, ph, solid);
    else bmp.checker(px, y0, pw, ph, Math.max(2, Math.floor(zoom / 2)), CHECK_A, CHECK_B);
    for (let ry = 0; ry < reps; ry++) {
      for (let rx = 0; rx < reps; rx++) bmp.drawIndexed(comp, W, H, pal, px + rx * W * zoom, y0 + ry * H * zoom, zoom);
    }
    if (grid) {
      for (let i = 1; i < cw; i++) bmp.fillRect(px + i * zoom, y0, 1, ph, i % 8 === 0 ? GRID_MAJOR : GRID_MINOR);
      for (let j = 1; j < ch; j++) bmp.fillRect(px, y0 + j * zoom, pw, 1, j % 8 === 0 ? GRID_MAJOR : GRID_MINOR);
    }
    if (tile) bmp.strokeRect(px + W * zoom, y0 + H * zoom, W * zoom, H * zoom, TILE_MARK);
    if (diff) {
      const prev = doc.composite((frames[k] - 1 + total) % total, layer ? { layer } : {});
      const ox = px + (tile ? W * zoom : 0);
      const oy = y0 + (tile ? H * zoom : 0);
      let count = 0;
      for (let i = 0; i < comp.length; i++) {
        if (comp[i] === prev[i]) continue;
        count++;
        const cx = ox + (i % W) * zoom;
        const cy = oy + Math.floor(i / W) * zoom;
        if (zoom >= 4) bmp.strokeRect(cx, cy, zoom, zoom, DIFF_MARK);
        else bmp.fillRect(cx, cy, zoom, zoom, DIFF_FILL);
      }
      changed.push(count);
    }
    if (rulers) {
      for (let x = 0; x < W; x += step) {
        const s = String(x);
        bmp.text(s, px + x * zoom + Math.floor((zoom - Bitmap.textWidth(s, fs)) / 2), margin, fs, RULER);
      }
      if (k === 0) {
        for (let y = 0; y < H; y += step) {
          const s = String(y);
          bmp.text(s, x0 - 6 - Bitmap.textWidth(s, fs), y0 + y * zoom + Math.floor((zoom - 5 * fs) / 2), fs, RULER);
        }
      }
    }
  });

  if (small.length) {
    let sx = x0;
    const sy = y0 + ph + gap;
    small.forEach((s, gi) => {
      if (gi) sx += gap * 2;
      composites.forEach((comp, k) => {
        bmp.fillRect(sx, sy, W * s, H * s, solid ?? SMALL_BG);
        bmp.drawIndexed(comp, W, H, pal, sx, sy, s);
        sx += W * s + (k < n - 1 ? 4 : 0);
      });
    });
  }

  const hidden = all.length - n;
  const description = [
    `${n === 1 ? `Frame ${frames[0]}` : `Frames ${frames.join(", ")} (left→right)`} at ${zoom}×` +
      `${layer ? `, layer "${layer}" only` : ""}${tile ? ", tiled 3×3 (center copy outlined in orange)" : ""}.`,
    rulers ? `Top numbers = x, left numbers = y${step > 1 ? ` (every ${step} px)` : ""}.` : "",
    grid ? "Thin grid line per pixel, blue line every 8 px." : "",
    solid ? `Background ${opts.background}.` : "Checkerboard = transparent.",
    small.length ? "Bottom row: same frames at actual size, 1× then 2×." : "",
    diff
      ? `Magenta squares = pixels changed since the previous frame (frame 0 vs ${total - 1}): ` +
        frames.map((f, k) => `f${f} ${changed[k]} px`).join(", ") +
        "."
      : opts.diff
        ? "diff ignored: the asset has a single frame."
        : "",
    hidden > 0 && !opts.frames?.length ? `${hidden} more frame(s) not shown; pass frames to see them.` : "",
  ]
    .filter(Boolean)
    .join(" ");

  return { png: bmp.toPNG(), description, zoom };
}
