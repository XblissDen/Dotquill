import { PNG } from "pngjs";
import { parseHex, type RGB } from "./color.ts";

export type RGBA = readonly [number, number, number, number];

// 3×5 glyphs for ruler numbers.
const GLYPHS: Record<string, string[]> = {
  "0": ["111", "101", "101", "101", "111"],
  "1": ["010", "110", "010", "010", "111"],
  "2": ["111", "001", "111", "100", "111"],
  "3": ["111", "001", "111", "001", "111"],
  "4": ["101", "101", "111", "001", "001"],
  "5": ["111", "100", "111", "001", "111"],
  "6": ["111", "100", "111", "101", "111"],
  "7": ["111", "001", "001", "001", "001"],
  "8": ["111", "101", "111", "101", "111"],
  "9": ["111", "101", "111", "001", "111"],
  "-": ["000", "000", "111", "000", "000"],
};

/** Minimal RGBA raster with alpha blending, used for previews and exports. */
export class Bitmap {
  readonly width: number;
  readonly height: number;
  readonly data: Buffer;

  constructor(width: number, height: number, fill?: RGBA) {
    this.width = width;
    this.height = height;
    this.data = Buffer.alloc(width * height * 4);
    if (fill) this.fillRect(0, 0, width, height, fill);
  }

  blend(x: number, y: number, c: RGBA): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const d = this.data;
    const i = (y * this.width + x) * 4;
    const a = c[3] / 255;
    if (a >= 1) {
      d[i] = c[0];
      d[i + 1] = c[1];
      d[i + 2] = c[2];
      d[i + 3] = 255;
      return;
    }
    if (a <= 0) return;
    const da = d[i + 3] / 255;
    const oa = a + da * (1 - a);
    for (let k = 0; k < 3; k++) d[i + k] = Math.round((c[k] * a + d[i + k] * da * (1 - a)) / oa);
    d[i + 3] = Math.round(oa * 255);
  }

  fillRect(x: number, y: number, w: number, h: number, c: RGBA): void {
    const x0 = Math.max(0, x);
    const y0 = Math.max(0, y);
    const x1 = Math.min(this.width, x + w);
    const y1 = Math.min(this.height, y + h);
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) this.blend(xx, yy, c);
  }

  strokeRect(x: number, y: number, w: number, h: number, c: RGBA): void {
    this.fillRect(x, y, w, 1, c);
    this.fillRect(x, y + h - 1, w, 1, c);
    this.fillRect(x, y + 1, 1, h - 2, c);
    this.fillRect(x + w - 1, y + 1, 1, h - 2, c);
  }

  checker(x: number, y: number, w: number, h: number, size: number, a: RGBA, b: RGBA): void {
    for (let yy = 0; yy < h; yy += size) {
      for (let xx = 0; xx < w; xx += size) {
        const c = (Math.floor(xx / size) + Math.floor(yy / size)) % 2 === 0 ? a : b;
        this.fillRect(x + xx, y + yy, Math.min(size, w - xx), Math.min(size, h - yy), c);
      }
    }
  }

  /** Draws palette-indexed pixels (negative = transparent) scaled by an integer factor. */
  drawIndexed(idx: Int16Array, iw: number, ih: number, pal: readonly RGB[], dx: number, dy: number, scale: number): void {
    for (let j = 0; j < ih; j++) {
      for (let i = 0; i < iw; i++) {
        const v = idx[j * iw + i];
        if (v < 0) continue;
        const c = pal[v];
        this.fillRect(dx + i * scale, dy + j * scale, scale, scale, [c[0], c[1], c[2], 255]);
      }
    }
  }

  text(s: string, x: number, y: number, scale: number, c: RGBA): void {
    let cx = x;
    for (const ch of s) {
      const g = GLYPHS[ch];
      if (g) {
        for (let r = 0; r < 5; r++) {
          for (let k = 0; k < 3; k++) if (g[r][k] === "1") this.fillRect(cx + k * scale, y + r * scale, scale, scale, c);
        }
      }
      cx += 4 * scale;
    }
  }

  static textWidth(s: string, scale: number): number {
    return s.length * 4 * scale - scale;
  }

  toPNG(): Buffer {
    const png = new PNG({ width: this.width, height: this.height });
    this.data.copy(png.data);
    return PNG.sync.write(png);
  }
}

export function paletteRGB(palette: readonly string[]): RGB[] {
  return palette.map(parseHex);
}

export function indexedToPNG(idx: Int16Array, w: number, h: number, palette: readonly string[], scale = 1): Buffer {
  const b = new Bitmap(w * scale, h * scale);
  b.drawIndexed(idx, w, h, paletteRGB(palette), 0, 0, scale);
  return b.toPNG();
}

export interface RawImage {
  width: number;
  height: number;
  data: Buffer;
}

export function readPNG(buf: Buffer): RawImage {
  const png = PNG.sync.read(buf);
  return { width: png.width, height: png.height, data: png.data };
}
