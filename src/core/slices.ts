/**
 * Slices (Aseprite-style): named rectangles on the canvas. A slice with a `center` is a 9-slice:
 * corners stay fixed, edges and center stretch or tile when the UI element is resized.
 */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type StretchMode = "stretch" | "tile";

export interface Slice {
  name: string;
  bounds: Rect;
  /** 9-slice center, relative to bounds. */
  center?: Rect;
  /** How edges/center fill extra space (default "stretch", like Godot). */
  mode?: StretchMode;
}

export interface Margins {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export const MAX_STRETCH = 512;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,31}$/;

function int(v: unknown, what: string, min: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min) throw new Error(`${what} must be an integer ≥ ${min}.`);
  return v;
}

export function validateSliceName(name: string): string {
  const n = String(name).trim();
  if (!NAME_RE.test(n)) throw new Error(`Invalid slice name "${name}" (letters, digits, space, - and _; max 32).`);
  return n;
}

export function validateSlice(raw: unknown, width: number, height: number): Slice {
  const s = raw as Partial<Slice> | null;
  if (!s || typeof s !== "object") throw new Error("Slice must be an object.");
  const name = validateSliceName(String(s.name ?? ""));
  const b = s.bounds as Partial<Rect> | undefined;
  if (!b) throw new Error(`Slice "${name}" has no bounds.`);
  const bounds = { x: int(b.x, "x", 0), y: int(b.y, "y", 0), w: int(b.w, "w", 1), h: int(b.h, "h", 1) };
  if (bounds.x + bounds.w > width || bounds.y + bounds.h > height) {
    throw new Error(`Slice "${name}" (${bounds.x},${bounds.y} ${bounds.w}×${bounds.h}) is outside the ${width}×${height} canvas.`);
  }
  const out: Slice = { name, bounds };
  if (s.center) {
    const c = s.center as Partial<Rect>;
    const center = { x: int(c.x, "center x", 0), y: int(c.y, "center y", 0), w: int(c.w, "center w", 1), h: int(c.h, "center h", 1) };
    if (center.x + center.w > bounds.w || center.y + center.h > bounds.h) {
      throw new Error(`Slice "${name}": the 9-slice center must fit inside the ${bounds.w}×${bounds.h} bounds.`);
    }
    out.center = center;
  }
  if (s.mode !== undefined) {
    if (s.mode !== "stretch" && s.mode !== "tile") throw new Error(`Slice "${name}": mode must be "stretch" or "tile".`);
    out.mode = s.mode;
  }
  return out;
}

/** Builds a 9-slice from border widths (what UI tools call patch margins). */
export function sliceFromMargins(name: string, bounds: Rect, m: Margins, mode?: StretchMode): Slice {
  for (const k of ["left", "top", "right", "bottom"] as const) int(m[k], k, 0);
  const w = bounds.w - m.left - m.right;
  const h = bounds.h - m.top - m.bottom;
  if (w < 1 || h < 1) {
    throw new Error(`Margins ${m.left}/${m.top}/${m.right}/${m.bottom} leave no center in a ${bounds.w}×${bounds.h} slice; keep at least 1 px.`);
  }
  return { name, bounds, center: { x: m.left, y: m.top, w, h }, ...(mode ? { mode } : {}) };
}

export function marginsOf(s: Slice): Margins | null {
  if (!s.center) return null;
  const { bounds: b, center: c } = s;
  return { left: c.x, top: c.y, right: b.w - c.x - c.w, bottom: b.h - c.y - c.h };
}

export function describeSlice(s: Slice): string {
  const b = s.bounds;
  const m = marginsOf(s);
  return (
    `${s.name}: ${b.w}×${b.h} at (${b.x},${b.y})` +
    (m ? `, 9-slice margins L${m.left} T${m.top} R${m.right} B${m.bottom}, ${s.mode ?? "stretch"}` : "")
  );
}

function axis(t: number, target: number, size: number, lo: number, hi: number, tile: boolean): number {
  if (t < lo) return t;
  if (t >= target - hi) return size - (target - t);
  const cs = size - lo - hi;
  const mid = t - lo;
  return lo + (tile ? mid % cs : Math.floor((mid * cs) / (target - lo - hi)));
}

/** Resizes a slice of a frame (palette indices, canvas width srcW) to tw×th using its 9-slice. */
export function nineSlice(src: Int16Array, srcW: number, s: Slice, tw: number, th: number): Int16Array {
  const m = marginsOf(s);
  if (!m) throw new Error(`Slice "${s.name}" has no 9-slice center.`);
  const minW = m.left + m.right + 1;
  const minH = m.top + m.bottom + 1;
  if (!Number.isInteger(tw) || !Number.isInteger(th) || tw < minW || th < minH || tw > MAX_STRETCH || th > MAX_STRETCH) {
    throw new Error(`Stretch size must be ${minW}..${MAX_STRETCH} × ${minH}..${MAX_STRETCH} for slice "${s.name}" (got ${tw}×${th}).`);
  }
  const b = s.bounds;
  const tile = s.mode === "tile";
  const out = new Int16Array(tw * th);
  for (let y = 0; y < th; y++) {
    const sy = b.y + axis(y, th, b.h, m.top, m.bottom, tile);
    for (let x = 0; x < tw; x++) {
      const sx = b.x + axis(x, tw, b.w, m.left, m.right, tile);
      out[y * tw + x] = src[sy * srcW + sx];
    }
  }
  return out;
}
