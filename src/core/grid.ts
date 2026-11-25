/**
 * Pixels are stored and exchanged as text rows: one character per pixel.
 * The character is the palette index in ALPHABET order ("0" = 0 … "a" = 10 …).
 * "." is transparent. "_" means "leave unchanged" (only when writing).
 */
export const ALPHABET =
  "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ!#$%&()*+,-/:;<=>?@[]^{|}~";
export const MAX_COLORS = ALPHABET.length;
export const TRANSPARENT = -1;
export const SKIP = -2;

const LOOKUP = new Map<string, number>();
for (let i = 0; i < ALPHABET.length; i++) LOOKUP.set(ALPHABET[i], i);
LOOKUP.set(".", TRANSPARENT);
LOOKUP.set("_", SKIP);

export function indexToChar(i: number): string {
  return i < 0 ? "." : ALPHABET[i];
}

export function charToIndex(c: string): number | undefined {
  return LOOKUP.get(c);
}

export function encodeRows(data: Int16Array, width: number, height: number): string[] {
  const rows: string[] = [];
  for (let y = 0; y < height; y++) {
    let s = "";
    for (let x = 0; x < width; x++) s += indexToChar(data[y * width + x]);
    rows.push(s);
  }
  return rows;
}

/** Strict decoding used when loading files. */
export function decodeRows(
  rows: readonly string[],
  width: number,
  height: number,
  paletteSize: number,
): Int16Array {
  if (!Array.isArray(rows) || rows.length !== height) {
    throw new Error(`expected ${height} rows, got ${Array.isArray(rows) ? rows.length : typeof rows}`);
  }
  const data = new Int16Array(width * height).fill(TRANSPARENT);
  for (let y = 0; y < height; y++) {
    const row = rows[y];
    if (typeof row !== "string" || row.length !== width) {
      throw new Error(`row ${y} must have ${width} characters`);
    }
    for (let x = 0; x < width; x++) {
      const v = LOOKUP.get(row[x]);
      if (v === undefined || v === SKIP || v >= paletteSize) {
        throw new Error(`invalid pixel "${row[x]}" at (${x},${y})`);
      }
      data[y * width + x] = v;
    }
  }
  return data;
}

export function isEmpty(data: Int16Array): boolean {
  for (let i = 0; i < data.length; i++) if (data[i] >= 0) return false;
  return true;
}

/** Rows with x/y rulers, for reading by a model or a human. */
export function formatGrid(rows: readonly string[], width: number): string {
  const pad = String(Math.max(0, rows.length - 1)).length;
  const prefix = " ".repeat(pad + 2);
  let tens = "";
  let units = "";
  for (let x = 0; x < width; x++) {
    tens += x % 10 === 0 ? String(Math.floor(x / 10) % 10) : " ";
    units += String(x % 10);
  }
  const lines: string[] = [];
  if (width > 10) lines.push(prefix + tens);
  lines.push(prefix + units);
  rows.forEach((r, y) => lines.push(String(y).padStart(pad) + "  " + r));
  return lines.join("\n");
}
