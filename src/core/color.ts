export type RGB = readonly [number, number, number];
export type Lab = readonly [number, number, number];

const HEX_RE = /^#?([0-9a-fA-F]{6})$/;

export function isHex(s: string): boolean {
  return HEX_RE.test(s.trim());
}

export function parseHex(hex: string): RGB {
  const m = HEX_RE.exec(hex.trim());
  if (!m) throw new Error(`Invalid color "${hex}": expected #rrggbb.`);
  const n = Number.parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function toHex(rgb: RGB): string {
  return "#" + rgb.map((v) => v.toString(16).padStart(2, "0")).join("");
}

export function normalizeHex(hex: string): string {
  return toHex(parseHex(hex));
}

function linear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** sRGB → OKLab (perceptual space used for nearest-color matching and lightness). */
export function rgbToOklab(rgb: RGB): Lab {
  const r = linear(rgb[0]);
  const g = linear(rgb[1]);
  const b = linear(rgb[2]);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** Perceptual lightness 0..100. */
export function lightness(hex: string): number {
  return Math.round(rgbToOklab(parseHex(hex))[0] * 100);
}

/** Finds the perceptually nearest palette entry for arbitrary colors. */
export class ColorMatcher {
  private readonly labs: Lab[];
  private readonly cache = new Map<number, number>();

  constructor(palette: readonly string[]) {
    this.labs = palette.map((h) => rgbToOklab(parseHex(h)));
  }

  nearest(rgb: RGB): number {
    const key = (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    const lab = rgbToOklab(rgb);
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < this.labs.length; i++) {
      const p = this.labs[i];
      const d = (p[0] - lab[0]) ** 2 + (p[1] - lab[1]) ** 2 + (p[2] - lab[2]) ** 2;
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    this.cache.set(key, best);
    return best;
  }
}
