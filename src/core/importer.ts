import type { RawImage } from "./bitmap.ts";
import { ColorMatcher, toHex } from "./color.ts";
import { PixelDoc } from "./doc.ts";
import { isEmpty, MAX_COLORS } from "./grid.ts";

export interface ImportOptions {
  /** Quantize to this palette. Omit to use the image's own colors (max 88). */
  palette?: { colors: string[]; name?: string };
  /** Slice a sheet into frames (sizes after downscale). */
  frameWidth?: number;
  frameHeight?: number;
  /** Integer factor for upscaled art: samples the center of each k×k block. */
  downscale?: number;
  /** Alpha below this counts as transparent (0..255). */
  alphaThreshold?: number;
}

export function imageToDoc(img: RawImage, o: ImportOptions = {}): { doc: PixelDoc; report: string[] } {
  const k = o.downscale ?? 1;
  if (!Number.isInteger(k) || k < 1 || k > 64) throw new Error("downscale must be an integer 1..64.");
  const w = Math.floor(img.width / k);
  const h = Math.floor(img.height / k);
  if (w < 1 || h < 1) throw new Error(`Image ${img.width}×${img.height} is too small for downscale ${k}.`);
  const thr = o.alphaThreshold ?? 128;
  const report: string[] = [];
  if (img.width % k || img.height % k) report.push(`Image size is not a multiple of ${k}; extra edge pixels were dropped.`);

  // 24-bit color keys, -1 for transparent.
  const keys = new Int32Array(w * h);
  const order: number[] = [];
  const seen = new Set<number>();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.width - 1, x * k + Math.floor(k / 2));
      const sy = Math.min(img.height - 1, y * k + Math.floor(k / 2));
      const i = (sy * img.width + sx) * 4;
      if (img.data[i + 3] < thr) {
        keys[y * w + x] = -1;
        continue;
      }
      const key = (img.data[i] << 16) | (img.data[i + 1] << 8) | img.data[i + 2];
      keys[y * w + x] = key;
      if (!seen.has(key)) {
        seen.add(key);
        order.push(key);
      }
    }
  }
  const rgbOf = (key: number) => [(key >> 16) & 255, (key >> 8) & 255, key & 255] as const;

  let paletteColors: string[];
  let paletteName: string | undefined;
  if (o.palette) {
    paletteColors = o.palette.colors;
    paletteName = o.palette.name;
  } else {
    if (order.length > MAX_COLORS) {
      throw new Error(
        `The image has ${order.length} colors (max ${MAX_COLORS}). Pass a palette to quantize it, ` +
          `e.g. {"preset":"endesga-32"} or {"lospec":"resurrect-64"}, and/or use downscale for upscaled art.`,
      );
    }
    if (order.length === 0) throw new Error("The image is fully transparent.");
    paletteColors = order.map((key) => toHex(rgbOf(key)));
  }

  const fw = o.frameWidth ?? w;
  const fh = o.frameHeight ?? h;
  if (!Number.isInteger(fw) || !Number.isInteger(fh) || fw < 1 || fh < 1 || fw > w || fh > h) {
    throw new Error(`Frame size ${fw}×${fh} does not fit the ${w}×${h} image.`);
  }
  const cols = Math.floor(w / fw);
  const rows = Math.floor(h / fh);
  if (w % fw || h % fh) report.push(`Image ${w}×${h} is not a multiple of the ${fw}×${fh} frame size; leftovers were dropped.`);

  const doc = PixelDoc.create({
    width: fw,
    height: fh,
    palette: paletteColors,
    ...(paletteName ? { paletteName } : {}),
    frames: cols * rows,
  });
  const matcher = new ColorMatcher(doc.palette);
  const exact = new Map(doc.palette.map((hex, i) => [hex, i]));
  let inexact = 0;
  const mapped = new Map<number, number>();
  const indexOf = (key: number) => {
    let v = mapped.get(key);
    if (v === undefined) {
      const rgb = rgbOf(key);
      v = exact.get(toHex(rgb));
      if (v === undefined) {
        v = matcher.nearest(rgb);
        inexact++;
      }
      mapped.set(key, v);
    }
    return v;
  };
  const layer = doc.layers[0].name;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cel = doc.cel(r * cols + c, layer);
      for (let y = 0; y < fh; y++) {
        for (let x = 0; x < fw; x++) {
          const key = keys[(r * fh + y) * w + c * fw + x];
          cel[y * fw + x] = key < 0 ? -1 : indexOf(key);
        }
      }
    }
  }
  while (doc.frames.length > 1 && isEmpty(doc.cel(doc.frames.length - 1, layer))) doc.frames.pop();
  if (o.palette && inexact) report.push(`${inexact} of ${order.length} source colors were not in the palette and were mapped to the nearest color.`);
  report.unshift(
    `Imported ${img.width}×${img.height}${k > 1 ? ` (downscaled ÷${k} to ${w}×${h})` : ""} → ` +
      `${doc.frames.length} frame(s) of ${fw}×${fh}, ${doc.palette.length} palette colors.`,
  );
  return { doc, report };
}
