import type { PixelDoc } from "./doc.ts";
import { TRANSPARENT } from "./grid.ts";

/**
 * Tilesets. "grid": the canvas is a grid of independent tiles. "blob": the canvas is a
 * 7×3-tile template that Dotquill expands into the 47 autotile ("blob") tiles a terrain needs:
 *
 *   col:  0          1          2           3              4             5              6
 *   row 0 outer TL   top edge   outer TR    inner (no SE)  above hole    inner (no SW)  variant
 *   row 1 left edge  center     right edge  left of hole   HOLE (empty)  right of hole  variant
 *   row 2 outer BL   bottom     outer BR    inner (no NE)  below hole    inner (no NW)  variant
 *
 * Columns 0–2 are a 3×3 island. Columns 3–5 are solid terrain around a one-cell hole, with
 * borders only around the hole: its corner cells are the four inner corners. Column 6 holds
 * optional center variants. Tiles the template does not contain are built from quarter tiles.
 */
export type TilesetLayout = "blob" | "grid";
export const TILESET_LAYOUTS: readonly TilesetLayout[] = ["blob", "grid"];

export interface Tileset {
  /** Square tile size in px. */
  tile: number;
  layout: TilesetLayout;
  /** Terrain name for engines (blob). */
  terrain?: string;
}

export const BLOB_COLS = 7;
export const BLOB_ROWS = 3;
/** Relative probability of a center variant (the plain center has 1). */
export const VARIANT_PROBABILITY = 0.25;
export const MAX_MAP = 48;

// Neighbor bits of a cell. Corners count only when both adjacent sides are terrain.
export const N = 1;
export const E = 2;
export const S = 4;
export const W = 8;
export const NE = 16;
export const SE = 32;
export const SW = 64;
export const NW = 128;

export function normalizeMask(m: number): number {
  let out = m & (N | E | S | W);
  if (m & NE && m & N && m & E) out |= NE;
  if (m & SE && m & S && m & E) out |= SE;
  if (m & SW && m & S && m & W) out |= SW;
  if (m & NW && m & N && m & W) out |= NW;
  return out;
}

/** The 47 distinct blob tiles, ascending. */
export const BLOB_MASKS: readonly number[] = [...new Set(Array.from({ length: 256 }, (_, m) => normalizeMask(m)))].sort((a, b) => a - b);

type Cell = readonly [number, number];

/** Template cells that are complete tiles, by mask. */
const DRAWN: ReadonlyMap<number, Cell> = new Map<number, Cell>([
  [E | S | SE, [0, 0]],
  [E | S | W | SE | SW, [1, 0]],
  [S | W | SW, [2, 0]],
  [N | E | S | NE | SE, [0, 1]],
  [255, [1, 1]],
  [N | S | W | SW | NW, [2, 1]],
  [N | E | NE, [0, 2]],
  [N | E | W | NE | NW, [1, 2]],
  [N | W | NW, [2, 2]],
  [255 & ~SE, [3, 0]],
  [255 & ~SW, [5, 0]],
  [255 & ~NE, [3, 2]],
  [255 & ~NW, [5, 2]],
]);
/** The edges around the hole: drawn for the picture, checked against the island's edges. */
const HOLE_EDGES: ReadonlyMap<number, Cell> = new Map<number, Cell>([
  [N | E | W | NE | NW, [4, 0]],
  [N | S | W | SW | NW, [3, 1]],
  [N | E | S | NE | SE, [5, 1]],
  [E | S | W | SE | SW, [4, 2]],
]);
const HOLE: Cell = [4, 1];
const VARIANT_CELLS: readonly Cell[] = [
  [6, 0],
  [6, 1],
  [6, 2],
];

const CELL_NAMES: Record<string, string> = {
  "0,0": "outer corner top-left",
  "1,0": "top edge",
  "2,0": "outer corner top-right",
  "0,1": "left edge",
  "1,1": "center",
  "2,1": "right edge",
  "0,2": "outer corner bottom-left",
  "1,2": "bottom edge",
  "2,2": "outer corner bottom-right",
  "3,0": "inner corner (hole at bottom-right)",
  "4,0": "above the hole",
  "5,0": "inner corner (hole at bottom-left)",
  "3,1": "left of the hole",
  "5,1": "right of the hole",
  "3,2": "inner corner (hole at top-right)",
  "4,2": "below the hole",
  "5,2": "inner corner (hole at top-left)",
};

// Quarters: 0 top-left, 1 top-right, 2 bottom-left, 3 bottom-right.
type QState = "outer" | "hedge" | "vedge" | "inner" | "full";
const QUARTER_NAMES = ["top-left", "top-right", "bottom-left", "bottom-right"];
const CORNER_BIT = [NW, NE, SW, SE];
const STATE_NAMES: Record<QState, string> = {
  outer: "outer corner",
  hedge: "horizontal edge",
  vedge: "vertical edge",
  inner: "inner corner",
  full: "full",
};

function quarterState(mask: number, q: number): QState {
  const v = mask & (q < 2 ? N : S);
  const h = mask & (q % 2 ? E : W);
  if (!v && !h) return "outer";
  if (!v) return "hedge";
  if (!h) return "vedge";
  return mask & CORNER_BIT[q] ? "full" : "inner";
}

/** Where each quarter of a composed tile comes from. */
const QUARTER_SOURCE: readonly Record<QState, Cell>[] = [
  { outer: [0, 0], hedge: [1, 0], vedge: [0, 1], inner: [5, 2], full: [1, 1] },
  { outer: [2, 0], hedge: [1, 0], vedge: [2, 1], inner: [3, 2], full: [1, 1] },
  { outer: [0, 2], hedge: [1, 2], vedge: [0, 1], inner: [5, 0], full: [1, 1] },
  { outer: [2, 2], hedge: [1, 2], vedge: [2, 1], inner: [3, 0], full: [1, 1] },
];

const TERRAIN_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,31}$/;

export function blobCanvasSize(tile: number): { width: number; height: number } {
  return { width: BLOB_COLS * tile, height: BLOB_ROWS * tile };
}

export function validateTileset(raw: unknown, width: number, height: number): Tileset {
  const t = (raw ?? {}) as Partial<Tileset>;
  const tile = Number(t.tile);
  if (!Number.isInteger(tile) || tile < 4 || tile > 128) throw new Error(`Tile size must be an integer 4..128 (got ${String(t.tile)}).`);
  const layout = t.layout ?? "blob";
  if (!TILESET_LAYOUTS.includes(layout)) throw new Error(`Tileset layout must be ${TILESET_LAYOUTS.join(" or ")}.`);
  if (layout === "blob") {
    if (tile % 2) throw new Error(`Blob tiles need an even size (tiles are built from quarters); got ${tile}.`);
    const need = blobCanvasSize(tile);
    if (width !== need.width || height !== need.height) {
      throw new Error(`A blob template with ${tile} px tiles is ${need.width}×${need.height} (7×3 tiles); the canvas is ${width}×${height}.`);
    }
  } else if (width % tile || height % tile) {
    throw new Error(`The canvas (${width}×${height}) is not a whole number of ${tile} px tiles.`);
  }
  const out: Tileset = { tile, layout };
  if (t.terrain !== undefined && t.terrain !== "") {
    const name = String(t.terrain).trim();
    if (!TERRAIN_RE.test(name)) throw new Error(`Invalid terrain name "${t.terrain}" (letters, digits, space, - and _; max 32).`);
    out.terrain = name;
  }
  return out;
}

export function describeTileset(t: Tileset, width: number, height: number): string {
  if (t.layout === "grid") return `grid tileset, ${t.tile} px tiles (${width / t.tile}×${height / t.tile} cells)`;
  return `blob tileset, ${t.tile} px tiles${t.terrain ? `, terrain "${t.terrain}"` : ""} (7×3 template → 47 autotiles)`;
}

export const BLOB_TEMPLATE_TEXT =
  "Blob template (tile col,row): cols 0–2 = a 3×3 island (row 0: outer corner top-left, top edge, outer corner top-right; row 1: left edge, " +
  "center, right edge; row 2: outer corner bottom-left, bottom edge, outer corner bottom-right). Cols 3–5 = solid terrain around an empty " +
  "cell (4,1): border only around that hole, none on the block's outside; its corner cells are the inner corners. Col 6 = optional center variants.";

function blank(T: number): Int16Array {
  return new Int16Array(T * T).fill(TRANSPARENT);
}

function cellPixels(src: Int16Array, srcW: number, cell: Cell, T: number): Int16Array {
  const out = blank(T);
  for (let y = 0; y < T; y++) {
    const row = (cell[1] * T + y) * srcW + cell[0] * T;
    out.set(src.subarray(row, row + T), y * T);
  }
  return out;
}

function copyQuarter(src: Int16Array, srcW: number, cell: Cell, q: number, T: number, dst: Int16Array): void {
  const h = T / 2;
  const qx = q % 2 ? h : 0;
  const qy = q < 2 ? 0 : h;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < h; x++) dst[(qy + y) * T + qx + x] = src[(cell[1] * T + qy + y) * srcW + cell[0] * T + qx + x];
  }
}

const isBlank = (a: Int16Array) => a.every((v) => v === TRANSPARENT);

export interface BlobTile {
  mask: number;
  /** 0 = main tile; 1.. = center variants (mask 255 only). */
  variant: number;
  /** Copied from a template cell, or built from quarters. */
  source: "drawn" | "composed";
  pixels: Int16Array;
}

function requireBlob(doc: PixelDoc): Tileset {
  const t = doc.tileset;
  if (!t) throw new Error("This asset is not a tileset. Create one with create_asset tileset, or set it with manage_asset action tileset.");
  if (t.layout !== "blob") throw new Error(`This needs a blob tileset; "${t.layout}" tilesets are plain tiles.`);
  return t;
}

/** The 47 blob tiles (ascending mask) plus center variants, from one frame of a blob template. */
export function blobTiles(doc: PixelDoc, frame = 0): BlobTile[] {
  const T = requireBlob(doc).tile;
  const src = doc.composite(frame);
  const out: BlobTile[] = [];
  for (const mask of BLOB_MASKS) {
    const cell = DRAWN.get(mask);
    if (cell) {
      out.push({ mask, variant: 0, source: "drawn", pixels: cellPixels(src, doc.width, cell, T) });
      continue;
    }
    const px = blank(T);
    for (let q = 0; q < 4; q++) copyQuarter(src, doc.width, QUARTER_SOURCE[q][quarterState(mask, q)], q, T, px);
    out.push({ mask, variant: 0, source: "composed", pixels: px });
  }
  // A variant drawn in any frame counts in every frame, so all frames list the same tiles.
  let v = 0;
  const comps = allComposites(doc);
  for (const cell of VARIANT_CELLS) {
    if (!usedInAnyFrame(comps, doc.width, cell, T)) continue;
    out.push({ mask: 255, variant: ++v, source: "drawn", pixels: cellPixels(src, doc.width, cell, T) });
  }
  return out;
}

const allComposites = (doc: PixelDoc) => doc.frames.map((_, f) => doc.composite(f));

function usedInAnyFrame(comps: readonly Int16Array[], width: number, cell: Cell, T: number): boolean {
  return comps.some((c) => !isBlank(cellPixels(c, width, cell, T)));
}

export interface GridTile {
  col: number;
  row: number;
  pixels: Int16Array;
}

/** Cells of a grid tileset that are non-empty in any frame (the same list for every frame). */
export function gridTiles(doc: PixelDoc, frame = 0): GridTile[] {
  const t = doc.tileset;
  if (!t) throw new Error("This asset is not a tileset.");
  const comps = allComposites(doc);
  const src = comps[doc.checkFrame(frame)];
  const out: GridTile[] = [];
  for (let row = 0; row < doc.height / t.tile; row++) {
    for (let col = 0; col < doc.width / t.tile; col++) {
      if (usedInAnyFrame(comps, doc.width, [col, row], t.tile)) out.push({ col, row, pixels: cellPixels(src, doc.width, [col, row], t.tile) });
    }
  }
  return out;
}

/** Atlas columns of a static blob atlas (animated atlases are this many tiles × frames wide). */
export const BLOB_ATLAS_COLUMNS = 8;

export interface AtlasTile {
  /** Atlas position (in tiles) of the first frame; further frames follow to the right. */
  col: number;
  row: number;
  /** Pixels per animation frame (one entry when the atlas is static). */
  frames: Int16Array[];
  /** Blob terrain mask. */
  mask?: number;
  probability?: number;
}

export interface TileAtlas {
  tile: number;
  /** Atlas size in tiles. */
  cols: number;
  rows: number;
  /** Frame durations in ms; length 1 = static tiles. */
  durations: number[];
  tiles: AtlasTile[];
  /** Blob tilesets: the plain center tile (terrain swatch color). */
  center?: Int16Array;
}

/**
 * Lays out a tileset's tiles for export. If the asset has several frames and any tile changes
 * between them, every tile becomes an animated tile with one atlas cell per frame, left to right.
 * Otherwise only `frame` is used. Blob tilesets: 8 tiles per row; grid tilesets keep their cells.
 */
export function buildTileAtlas(doc: PixelDoc, frame = 0): TileAtlas {
  const t = doc.tileset;
  if (!t) throw new Error("This asset is not a tileset. Create one with create_asset tileset, or set it with manage_asset action tileset.");
  doc.checkFrame(frame);
  const all = doc.frames.map((_, f) => f);
  const perFrame = (f: number) =>
    t.layout === "blob" ? blobTiles(doc, f).map((b) => b.pixels) : gridTiles(doc, f).map((g) => g.pixels);
  const first = perFrame(all[0]);
  const rest = all.slice(1).map(perFrame);
  const animated = rest.some((tiles) => tiles.some((px, k) => px.some((v, i) => v !== first[k][i])));
  const frames = animated ? [first, ...rest] : [perFrame(frame)];
  const n = frames.length;
  const durations = animated ? doc.frames.map((f) => f.duration) : [doc.frames[frame].duration];
  if (t.layout === "blob") {
    const meta = blobTiles(doc, frame);
    const tiles = meta.map((b, k) => ({
      col: (k % BLOB_ATLAS_COLUMNS) * n,
      row: Math.floor(k / BLOB_ATLAS_COLUMNS),
      frames: frames.map((f) => f[k]),
      mask: b.mask,
      ...(b.variant ? { probability: VARIANT_PROBABILITY } : {}),
    }));
    const center = meta.findIndex((b) => b.mask === 255 && !b.variant);
    return {
      tile: t.tile,
      cols: BLOB_ATLAS_COLUMNS * n,
      rows: Math.ceil(tiles.length / BLOB_ATLAS_COLUMNS),
      durations,
      tiles,
      center: frames[0][center],
    };
  }
  const cells = gridTiles(doc, frame);
  return {
    tile: t.tile,
    cols: (doc.width / t.tile) * n,
    rows: doc.height / t.tile,
    durations,
    tiles: cells.map((c, k) => ({ col: c.col * n, row: c.row, frames: frames.map((f) => f[k]) })),
  };
}

/**
 * Default test map. Left: an island with a solid middle (the center tile next to itself), a pond,
 * a one-cell hole, a path and a ring. Right: dense junctions. Together the cells use all 47 blob tiles.
 */
export const SAMPLE_MAP: readonly string[] = [
  "....................",
  ".#########.#..#.#.#.",
  ".#########..#######.",
  ".#########...##.#.#.",
  ".##..#####..#######.",
  ".##..##.##.#.#.####.",
  ".#########.#####.##.",
  ".#########.#.##.###.",
  "......#....#.#####..",
  ".###..#....##.#.###.",
  ".#.#..###..#######..",
  ".###........##.#.#..",
  "....................",
];

export function parseMap(rows: readonly string[]): boolean[][] {
  if (!rows.length) throw new Error("The map is empty.");
  const w = Math.max(...rows.map((r) => r.length));
  if (w > MAX_MAP || rows.length > MAX_MAP) throw new Error(`Maps are at most ${MAX_MAP}×${MAX_MAP} cells.`);
  return rows.map((r, y) =>
    Array.from({ length: w }, (_, x) => {
      const c = r[x] ?? ".";
      if (c !== "#" && c !== ".") throw new Error(`Map row ${y} has "${c}" at ${x}: use "#" for terrain and "." for empty.`);
      return c === "#";
    }),
  );
}

export function cellMask(map: readonly (readonly boolean[])[], x: number, y: number): number {
  const at = (dx: number, dy: number) => !!map[y + dy]?.[x + dx];
  let m = 0;
  if (at(0, -1)) m |= N;
  if (at(1, 0)) m |= E;
  if (at(0, 1)) m |= S;
  if (at(-1, 0)) m |= W;
  if (at(1, -1)) m |= NE;
  if (at(1, 1)) m |= SE;
  if (at(-1, 1)) m |= SW;
  if (at(-1, -1)) m |= NW;
  return normalizeMask(m);
}

/** Deterministic 0..1 per cell, so previews do not flicker between calls. */
function cellRandom(x: number, y: number): number {
  let h = Math.imul(x + 1, 0x27d4eb2d) ^ Math.imul(y + 0x9e37, 0x165667b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

export interface Tilemap {
  pixels: Int16Array;
  width: number;
  height: number;
  cols: number;
  rows: number;
  drawn: number;
  composed: number;
  variants: number;
  /** Distinct blob tiles used. */
  distinct: number;
}

/** Paints a map ("#" terrain, "." empty) with the blob tiles, like an engine's autotiling would. */
export function renderTilemap(doc: PixelDoc, rows: readonly string[] = SAMPLE_MAP, frame = 0): Tilemap {
  const T = requireBlob(doc).tile;
  const map = parseMap(rows);
  const tiles = blobTiles(doc, frame);
  const byMask = new Map<number, BlobTile[]>();
  for (const t of tiles) byMask.set(t.mask, [...(byMask.get(t.mask) ?? []), t]);
  const cols = map[0].length;
  const out: Tilemap = {
    width: cols * T,
    height: map.length * T,
    cols,
    rows: map.length,
    pixels: new Int16Array(cols * T * map.length * T).fill(TRANSPARENT),
    drawn: 0,
    composed: 0,
    variants: 0,
    distinct: 0,
  };
  const seen = new Set<number>();
  map.forEach((line, y) =>
    line.forEach((on, x) => {
      if (!on) return;
      const mask = cellMask(map, x, y);
      const options = byMask.get(mask)!;
      let pick = options[0];
      if (options.length > 1) {
        let r = cellRandom(x, y) * (1 + VARIANT_PROBABILITY * (options.length - 1));
        r -= 1;
        if (r >= 0) pick = options[Math.min(options.length - 1, 1 + Math.floor(r / VARIANT_PROBABILITY))];
      }
      seen.add(mask);
      if (pick.variant) out.variants++;
      else if (pick.source === "drawn") out.drawn++;
      else out.composed++;
      for (let ty = 0; ty < T; ty++) out.pixels.set(pick.pixels.subarray(ty * T, ty * T + T), (y * T + ty) * out.width + x * T);
    }),
  );
  out.distinct = seen.size;
  return out;
}

/** Tileset-specific audit lines: missing template tiles and quarters that composed tiles will mix. */
export function auditTileset(doc: PixelDoc, frame = 0): { warn: string[]; info: string[] } {
  const t = doc.tileset;
  const warn: string[] = [];
  const info: string[] = [];
  if (!t) return { warn, info };
  if (t.layout === "grid") {
    const tiles = gridTiles(doc, frame);
    info.push(`Grid tileset: ${tiles.length} non-empty ${t.tile} px tile(s) of ${(doc.width / t.tile) * (doc.height / t.tile)} cells.`);
    return { warn, info };
  }
  const T = t.tile;
  const src = doc.composite(frame);
  const cells = [...DRAWN, ...HOLE_EDGES];
  const empty = cells.map(([, c]) => c).filter((c) => isBlank(cellPixels(src, doc.width, c, T)));
  if (empty.length) {
    warn.push(`Empty template tile(s): ${empty.map((c) => `(${c[0]},${c[1]}) ${CELL_NAMES[`${c[0]},${c[1]}`]}`).join("; ")}.`);
  }
  if (!isBlank(cellPixels(src, doc.width, HOLE, T))) {
    warn.push(`The hole (${HOLE[0]},${HOLE[1]}) must stay empty: it stands for an empty cell next to the inner corners.`);
  }
  // A quarter that also exists elsewhere in the template should match its source, or composed tiles will show seams.
  const h = T / 2;
  const diffs: string[] = [];
  for (const [mask, cell] of cells) {
    for (let q = 0; q < 4; q++) {
      const state = quarterState(mask, q);
      const from = QUARTER_SOURCE[q][state];
      if (from[0] === cell[0] && from[1] === cell[1]) continue;
      let n = 0;
      const qx = q % 2 ? h : 0;
      const qy = q < 2 ? 0 : h;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < h; x++) {
          const a = src[(cell[1] * T + qy + y) * doc.width + cell[0] * T + qx + x];
          const b = src[(from[1] * T + qy + y) * doc.width + from[0] * T + qx + x];
          if (a !== b) n++;
        }
      }
      if (n) diffs.push(`(${cell[0]},${cell[1]}) ${QUARTER_NAMES[q]} vs (${from[0]},${from[1]}) ${n} px [${STATE_NAMES[state]}]`);
    }
  }
  if (diffs.length) {
    info.push(
      `Tiles missing from the template are built from quarter tiles: ${diffs.length} quarter(s) differ from the copy those tiles use: ` +
        `${diffs.slice(0, 10).join("; ")}${diffs.length > 10 ? `; … (+${diffs.length - 10})` : ""}. ` +
        "Small differences are fine; large ones (outline or edge art crossing the tile's half line) can show seams. Check render_preview tilemap.",
    );
  }
  const variants = VARIANT_CELLS.filter((c) => !isBlank(cellPixels(src, doc.width, c, T))).length;
  const center = DRAWN.get(255)!;
  info.push(
    `Blob tileset: 47 tiles (${DRAWN.size} drawn, ${47 - DRAWN.size} composed)${variants ? ` + ${variants} center variant(s)` : ""}. ` +
      `Center tile at (${center[0]},${center[1]}) must tile with itself: check render_preview tilemap.`,
  );
  return { warn, info };
}
