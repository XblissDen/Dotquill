import { ColorMatcher, normalizeHex, parseHex } from "./color.ts";
import type { PixelDoc } from "./doc.ts";
import { charToIndex, indexToChar, SKIP, TRANSPARENT } from "./grid.ts";

/** A palette index, a legend character ("a"), an exact palette hex ("#1a1c2c"), or "." / -1 for transparent. */
export type ColorArg = number | string;

export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Masked {
  /** Paint only over pixels that currently have one of these colors. */
  onlyOn?: ColorArg[] | undefined;
}

export type DrawOp =
  | ({ op: "pixel"; points: number[][]; color: ColorArg } & Masked)
  | ({ op: "line"; points: number[][]; closed?: boolean | undefined; color: ColorArg } & Masked)
  | ({ op: "rect"; x: number; y: number; w: number; h: number; color: ColorArg; fill?: boolean | undefined } & Masked)
  | ({ op: "ellipse"; x: number; y: number; w: number; h: number; color: ColorArg; fill?: boolean | undefined } & Masked)
  | { op: "fill"; x: number; y: number; color: ColorArg; contiguous?: boolean | undefined }
  | { op: "replace"; from: ColorArg; to: ColorArg; region?: Region | undefined }
  | { op: "outline"; color: ColorArg; mode?: "outer" | "inner" | undefined; corners?: boolean | undefined }
  | { op: "mirror"; axis: "x" | "y"; from?: "left" | "right" | "top" | "bottom" | undefined }
  | { op: "flip"; axis: "x" | "y" }
  | { op: "shift"; dx: number; dy: number; wrap?: boolean | undefined }
  | { op: "clear"; region?: Region | undefined }
  | {
      op: "copy";
      x: number;
      y: number;
      w: number;
      h: number;
      toX: number;
      toY: number;
      fromFrame?: number | undefined;
      fromLayer?: string | undefined;
      cut?: boolean | undefined;
      includeTransparent?: boolean | undefined;
    }
  | ({
      op: "dither";
      x: number;
      y: number;
      w: number;
      h: number;
      color: ColorArg;
      pattern?: "checker" | "sparse" | "dense" | undefined;
    } & Masked);

export function resolveColor(arg: ColorArg, palette: readonly string[]): number {
  if (typeof arg === "number") {
    if (arg === -1) return TRANSPARENT;
    if (!Number.isInteger(arg) || arg < 0 || arg >= palette.length) {
      throw new Error(`Color index ${arg} is outside the palette (0..${palette.length - 1}).`);
    }
    return arg;
  }
  const s = String(arg).trim();
  if (s === "." || s === "-1" || s.toLowerCase() === "transparent") return TRANSPARENT;
  if (s.startsWith("#")) {
    const hex = normalizeHex(s);
    const i = palette.indexOf(hex);
    if (i < 0) {
      const n = new ColorMatcher(palette).nearest(parseHex(hex));
      throw new Error(
        `${hex} is not in the palette (palettes are locked). Nearest: "${indexToChar(n)}" ${palette[n]}. ` +
          `Use the palette tool (edit/add) to change colors.`,
      );
    }
    return i;
  }
  if (s.length === 1) {
    const i = charToIndex(s);
    if (i === undefined || i === SKIP) throw new Error(`"${s}" is not a palette character.`);
    if (i >= palette.length) {
      throw new Error(`"${s}" is beyond the palette (last character is "${indexToChar(palette.length - 1)}").`);
    }
    return i;
  }
  if (/^\d+$/.test(s)) return resolveColor(Number(s), palette);
  throw new Error(
    `Cannot read color "${s}". Use a legend character ("a"), an index (10), a palette hex ("#1a1c2c") or "." for transparent.`,
  );
}

export function bresenham(x0: number, y0: number, x1: number, y1: number, plot: (x: number, y: number) => void): void {
  const dx = Math.abs(x1 - x0);
  const sx = x0 < x1 ? 1 : -1;
  const dy = -Math.abs(y1 - y0);
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  let x = x0;
  let y = y0;
  for (;;) {
    plot(x, y);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
}

/** Filled ellipse inside a w×h box. Tiny sizes use a tighter threshold so 3×3 becomes a "plus". */
export function ellipseMask(w: number, h: number): Uint8Array {
  const m = new Uint8Array(w * h);
  const rx = w / 2;
  const ry = h / 2;
  const t = w <= 3 || h <= 3 ? 0.85 : 1;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const dx = (i + 0.5 - rx) / rx;
      const dy = (j + 0.5 - ry) / ry;
      if (dx * dx + dy * dy <= t + 1e-9) m[j * w + i] = 1;
    }
  }
  return m;
}

function isMaskEdge(m: Uint8Array, w: number, h: number, i: number, j: number): boolean {
  if (!m[j * w + i]) return false;
  if (i === 0 || j === 0 || i === w - 1 || j === h - 1) return true;
  return !m[j * w + i - 1] || !m[j * w + i + 1] || !m[(j - 1) * w + i] || !m[(j + 1) * w + i];
}

const N4 = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;
const N8 = [...N4, [1, 1], [1, -1], [-1, 1], [-1, -1]] as const;

function intArg(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isInteger(v)) throw new Error(`${what} must be an integer.`);
  return v;
}

function point(p: number[], what = "point"): [number, number] {
  if (!Array.isArray(p) || p.length !== 2) throw new Error(`${what} must be [x, y].`);
  return [intArg(p[0], `${what} x`), intArg(p[1], `${what} y`)];
}

function checkBox(w: number, h: number): void {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) {
    throw new Error(`w and h must be positive integers (got ${w}×${h}).`);
  }
}

interface Ctx {
  doc: PixelDoc;
  frame: number;
  layer: string;
}

function applyOp(ctx: Ctx, cel: Int16Array, op: DrawOp): void {
  const { doc } = ctx;
  const W = doc.width;
  const H = doc.height;
  const col = (c: ColorArg) => resolveColor(c, doc.palette);
  const mask = "onlyOn" in op && op.onlyOn?.length ? new Set(op.onlyOn.map(col)) : null;
  const inb = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H;
  const set = (x: number, y: number, c: number) => {
    if (!inb(x, y)) return;
    const i = y * W + x;
    if (mask && !mask.has(cel[i])) return;
    cel[i] = c;
  };
  const regionOrAll = (r?: Region) => {
    if (!r) return { x: 0, y: 0, w: W, h: H };
    checkBox(r.w, r.h);
    return r;
  };

  switch (op.op) {
    case "pixel": {
      const c = col(op.color);
      for (const p of op.points) {
        const [x, y] = point(p);
        set(x, y, c);
      }
      break;
    }
    case "line": {
      const c = col(op.color);
      const pts = op.points.map((p) => point(p));
      if (pts.length < 2) throw new Error("line needs at least 2 points.");
      for (let i = 0; i + 1 < pts.length; i++) {
        bresenham(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], (x, y) => set(x, y, c));
      }
      if (op.closed && pts.length > 2) {
        const a = pts[pts.length - 1];
        bresenham(a[0], a[1], pts[0][0], pts[0][1], (x, y) => set(x, y, c));
      }
      break;
    }
    case "rect": {
      const c = col(op.color);
      checkBox(op.w, op.h);
      const x1 = op.x + op.w - 1;
      const y1 = op.y + op.h - 1;
      for (let y = op.y; y <= y1; y++) {
        for (let x = op.x; x <= x1; x++) {
          if (op.fill || x === op.x || x === x1 || y === op.y || y === y1) set(x, y, c);
        }
      }
      break;
    }
    case "ellipse": {
      const c = col(op.color);
      checkBox(op.w, op.h);
      const m = ellipseMask(op.w, op.h);
      for (let j = 0; j < op.h; j++) {
        for (let i = 0; i < op.w; i++) {
          if (op.fill ? m[j * op.w + i] : isMaskEdge(m, op.w, op.h, i, j)) set(op.x + i, op.y + j, c);
        }
      }
      break;
    }
    case "fill": {
      const c = col(op.color);
      if (!inb(op.x, op.y)) throw new Error(`(${op.x},${op.y}) is outside the ${W}×${H} canvas.`);
      const target = cel[op.y * W + op.x];
      if (target === c) break;
      if (op.contiguous === false) {
        for (let i = 0; i < cel.length; i++) if (cel[i] === target) cel[i] = c;
        break;
      }
      const stack: number[] = [op.x, op.y];
      while (stack.length) {
        const y = stack.pop()!;
        const x = stack.pop()!;
        if (!inb(x, y) || cel[y * W + x] !== target) continue;
        cel[y * W + x] = c;
        for (const [dx, dy] of N4) stack.push(x + dx, y + dy);
      }
      break;
    }
    case "replace": {
      const a = col(op.from);
      const b = col(op.to);
      const r = regionOrAll(op.region);
      for (let y = r.y; y < r.y + r.h; y++) {
        for (let x = r.x; x < r.x + r.w; x++) {
          if (inb(x, y) && cel[y * W + x] === a) cel[y * W + x] = b;
        }
      }
      break;
    }
    case "outline": {
      const c = col(op.color);
      const src = cel.slice();
      const nb = op.corners ? N8 : N4;
      const outer = (op.mode ?? "outer") === "outer";
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const v = src[y * W + x];
          if (outer) {
            if (v >= 0) continue;
            if (nb.some(([dx, dy]) => inb(x + dx, y + dy) && src[(y + dy) * W + x + dx] >= 0)) cel[y * W + x] = c;
          } else {
            if (v < 0) continue;
            if (nb.some(([dx, dy]) => !inb(x + dx, y + dy) || src[(y + dy) * W + x + dx] < 0)) cel[y * W + x] = c;
          }
        }
      }
      break;
    }
    case "mirror": {
      const from = op.from ?? (op.axis === "x" ? "left" : "top");
      if (op.axis === "x" && from !== "left" && from !== "right") throw new Error('axis "x" needs from "left" or "right".');
      if (op.axis === "y" && from !== "top" && from !== "bottom") throw new Error('axis "y" needs from "top" or "bottom".');
      if (op.axis === "x") {
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < Math.floor(W / 2); x++) {
            const a = y * W + x;
            const b = y * W + (W - 1 - x);
            if (from === "left") cel[b] = cel[a];
            else cel[a] = cel[b];
          }
        }
      } else {
        for (let y = 0; y < Math.floor(H / 2); y++) {
          for (let x = 0; x < W; x++) {
            const a = y * W + x;
            const b = (H - 1 - y) * W + x;
            if (from === "top") cel[b] = cel[a];
            else cel[a] = cel[b];
          }
        }
      }
      break;
    }
    case "flip": {
      const src = cel.slice();
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          cel[y * W + x] = op.axis === "x" ? src[y * W + (W - 1 - x)] : src[(H - 1 - y) * W + x];
        }
      }
      break;
    }
    case "shift": {
      const dx = intArg(op.dx, "dx");
      const dy = intArg(op.dy, "dy");
      const src = cel.slice();
      cel.fill(TRANSPARENT);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          let nx = x + dx;
          let ny = y + dy;
          if (op.wrap) {
            nx = ((nx % W) + W) % W;
            ny = ((ny % H) + H) % H;
          } else if (!inb(nx, ny)) continue;
          cel[ny * W + nx] = src[y * W + x];
        }
      }
      break;
    }
    case "clear": {
      const r = regionOrAll(op.region);
      for (let y = r.y; y < r.y + r.h; y++) {
        for (let x = r.x; x < r.x + r.w; x++) if (inb(x, y)) cel[y * W + x] = TRANSPARENT;
      }
      break;
    }
    case "copy": {
      checkBox(op.w, op.h);
      const srcFrame = op.fromFrame ?? ctx.frame;
      const srcLayer = op.fromLayer !== undefined ? doc.resolveLayer(op.fromLayer) : ctx.layer;
      const srcCel = doc.cel(srcFrame, srcLayer);
      const buf = new Int16Array(op.w * op.h);
      for (let j = 0; j < op.h; j++) {
        for (let i = 0; i < op.w; i++) {
          const sx = op.x + i;
          const sy = op.y + j;
          buf[j * op.w + i] = inb(sx, sy) ? srcCel[sy * W + sx] : TRANSPARENT;
        }
      }
      if (op.cut) {
        for (let j = 0; j < op.h; j++) {
          for (let i = 0; i < op.w; i++) if (inb(op.x + i, op.y + j)) srcCel[(op.y + j) * W + op.x + i] = TRANSPARENT;
        }
      }
      for (let j = 0; j < op.h; j++) {
        for (let i = 0; i < op.w; i++) {
          const v = buf[j * op.w + i];
          if (v < 0 && !op.includeTransparent) continue;
          const tx = op.toX + i;
          const ty = op.toY + j;
          if (inb(tx, ty)) cel[ty * W + tx] = v;
        }
      }
      break;
    }
    case "dither": {
      const c = col(op.color);
      checkBox(op.w, op.h);
      const pattern = op.pattern ?? "checker";
      for (let y = op.y; y < op.y + op.h; y++) {
        for (let x = op.x; x < op.x + op.w; x++) {
          const on =
            pattern === "checker"
              ? (x + y) % 2 === 0
              : pattern === "sparse"
                ? x % 2 === 0 && y % 2 === 0
                : !(x % 2 === 1 && y % 2 === 1);
          if (on) set(x, y, c);
        }
      }
      break;
    }
    default:
      throw new Error(`Unknown op "${(op as { op: string }).op}".`);
  }
}

/** Applies ops in order to one cel. Returns one summary line per op. Throws on the first bad op. */
export function applyOps(doc: PixelDoc, frame: number, layer: string, ops: readonly DrawOp[]): string[] {
  const lines: string[] = [];
  ops.forEach((op, n) => {
    const cel = doc.cel(frame, layer);
    const before = cel.slice();
    try {
      applyOp({ doc, frame, layer }, cel, op);
    } catch (e) {
      throw new Error(`op #${n + 1} (${op.op}): ${(e as Error).message}`);
    }
    let changed = 0;
    for (let i = 0; i < cel.length; i++) if (before[i] !== cel[i]) changed++;
    lines.push(`#${n + 1} ${op.op}: ${changed} px changed`);
  });
  return lines;
}

export interface WriteResult {
  changed: number;
  clipped: number;
  warnings: string[];
}

/** Writes text rows into a cel at (x0, y0). "." = transparent, "_" = keep. Validates everything first. */
export function writeRows(
  doc: PixelDoc,
  frame: number,
  layer: string,
  rows: readonly string[],
  x0 = 0,
  y0 = 0,
): WriteResult {
  const last = indexToChar(doc.palette.length - 1);
  const parsed = rows.map((row, j) => {
    if (typeof row !== "string") throw new Error(`Row ${j} is not a string.`);
    return Array.from(row, (ch, i) => {
      const v = charToIndex(ch);
      if (v === undefined) {
        throw new Error(
          `Row ${j}, column ${i}: "${ch}" is not a pixel character. Use "." (transparent), "_" (keep) or palette chars 0..${last}. No spaces.`,
        );
      }
      if (v >= doc.palette.length) {
        throw new Error(`Row ${j}, column ${i}: "${ch}" is beyond the palette (last character is "${last}").`);
      }
      return v;
    });
  });
  const cel = doc.cel(frame, layer);
  const W = doc.width;
  const H = doc.height;
  let changed = 0;
  let clipped = 0;
  parsed.forEach((row, j) => {
    row.forEach((v, i) => {
      if (v === SKIP) return;
      const x = x0 + i;
      const y = y0 + j;
      if (x < 0 || y < 0 || x >= W || y >= H) {
        clipped++;
        return;
      }
      if (cel[y * W + x] !== v) {
        cel[y * W + x] = v;
        changed++;
      }
    });
  });
  const warnings: string[] = [];
  if (clipped) warnings.push(`${clipped} px fell outside the ${W}×${H} canvas and were ignored.`);
  const lengths = new Set(rows.map((r) => Array.from(r).length));
  if (lengths.size > 1) {
    warnings.push(`Rows have different lengths (${[...lengths].sort((a, b) => a - b).join(", ")}); check alignment.`);
  }
  return { changed, clipped, warnings };
}
