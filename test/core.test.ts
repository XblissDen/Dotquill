import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { inflateSync } from "node:zlib";
import { audit } from "../src/core/audit.ts";
import { readPNG } from "../src/core/bitmap.ts";
import { PixelDoc } from "../src/core/doc.ts";
import { applyOps, ellipseMask, resolveColor, writeRows } from "../src/core/draw.ts";
import { buildExport, findGodotResDir, godotAnimations, writeExport } from "../src/core/export.ts";
import { encodeRows, formatGrid } from "../src/core/grid.ts";
import { imageToDoc } from "../src/core/importer.ts";
import { PRESETS } from "../src/core/palettes.ts";
import { renderPreview, renderTilemapPreview } from "../src/core/render.ts";
import { nineSlice, sliceFromMargins, validateSlice } from "../src/core/slices.ts";
import { defaultWorkspaceDir, Workspace } from "../src/core/store.ts";
import { startViewer } from "../src/viewer/server.ts";
import {
  BLOB_MASKS,
  blobTiles,
  buildTileAtlas,
  E,
  N,
  NE,
  normalizeMask,
  NW,
  renderTilemap,
  S,
  SE,
  validateTileset,
  W as WEST,
} from "../src/core/tileset.ts";

const PAL = PRESETS["sweetie-16"].colors;
const make = (w = 8, h = 8, extra: Partial<Parameters<typeof PixelDoc.create>[0]> = {}) =>
  PixelDoc.create({ width: w, height: h, palette: PAL, ...extra });
const rows = (doc: PixelDoc, f = 0) => encodeRows(doc.composite(f), doc.width, doc.height);

test("rows round-trip through the file format", () => {
  const doc = make(4, 3, { layers: ["a", "b"], frames: 2 });
  writeRows(doc, 0, "a", ["0123", "4567", "89af"]);
  writeRows(doc, 1, "b", ["....", ".cc.", "...."]);
  doc.tags.push({ name: "idle", from: 0, to: 1, direction: "forward" });
  const back = PixelDoc.fromJSON(JSON.parse(JSON.stringify(doc.toJSON())));
  assert.deepEqual(rows(back, 0), ["0123", "4567", "89af"]);
  assert.deepEqual(rows(back, 1), ["....", ".cc.", "...."]);
  assert.equal(back.tags[0].name, "idle");
  assert.deepEqual(back.layers.map((l) => l.name), ["a", "b"]);
});

test("writeRows: skip, transparent, clipping and validation", () => {
  const doc = make(4, 2);
  writeRows(doc, 0, "main", ["1111", "1111"]);
  // At (2,1): "_" keeps x2, "." clears x3, "2" falls off the right edge; the second row is below the canvas.
  const r = writeRows(doc, 0, "main", ["_.2", "333"], 2, 1);
  assert.deepEqual(rows(doc), ["1111", "111."]);
  assert.equal(r.clipped, 4);
  assert.throws(() => writeRows(doc, 0, "main", ["1 1"]), /not a pixel character/);
  assert.throws(() => writeRows(doc, 0, "main", ["z"]), /beyond the palette/);
});

test("resolveColor accepts chars, indices, palette hex and transparent", () => {
  assert.equal(resolveColor("a", PAL), 10);
  assert.equal(resolveColor(3, PAL), 3);
  assert.equal(resolveColor("#1A1C2C", PAL), 0);
  assert.equal(resolveColor(".", PAL), -1);
  assert.throws(() => resolveColor("#123456", PAL), /not in the palette.*Nearest/);
});

test("line is pixel-perfect and ellipse sizes look right", () => {
  const doc = make(6, 3);
  applyOps(doc, 0, "main", [{ op: "line", points: [[0, 0], [5, 2]], color: "1" }]);
  assert.deepEqual(rows(doc), ["11....", "..11..", "....11"]);
  const plus = ellipseMask(3, 3);
  assert.deepEqual([...plus], [0, 1, 0, 1, 1, 1, 0, 1, 0]);
  const doc5 = make(5, 5);
  applyOps(doc5, 0, "main", [{ op: "ellipse", x: 0, y: 0, w: 5, h: 5, color: "2" }]);
  assert.deepEqual(rows(doc5), [".222.", "2...2", "2...2", "2...2", ".222."]);
});

test("fill, outline, mirror, shift, copy and onlyOn masks", () => {
  const doc = make(5, 5);
  applyOps(doc, 0, "main", [
    { op: "rect", x: 1, y: 1, w: 3, h: 3, color: "6", fill: true },
    { op: "outline", color: "0" },
  ]);
  assert.deepEqual(rows(doc), [".000.", "06660", "06660", "06660", ".000."]);
  applyOps(doc, 0, "main", [{ op: "rect", x: 0, y: 0, w: 5, h: 2, color: "5", fill: true, onlyOn: ["6"] }]);
  assert.deepEqual(rows(doc)[1], "05550");
  applyOps(doc, 0, "main", [{ op: "fill", x: 0, y: 0, color: "c" }]);
  assert.equal(rows(doc)[0], "c000.");

  const m = make(4, 1);
  writeRows(m, 0, "main", ["12.."]);
  applyOps(m, 0, "main", [{ op: "mirror", axis: "x" }]);
  assert.deepEqual(rows(m), ["1221"]);
  applyOps(m, 0, "main", [{ op: "shift", dx: 1, dy: 0, wrap: true }]);
  assert.deepEqual(rows(m), ["1122"]);
  applyOps(m, 0, "main", [{ op: "copy", x: 0, y: 0, w: 2, h: 1, toX: 2, toY: 0, cut: true }]);
  assert.deepEqual(rows(m), ["..11"]);
});

test("preview renders a valid PNG", () => {
  const doc = make(16, 16, { frames: 2 });
  writeRows(doc, 0, "main", ["0123456789abcdef"]);
  const p = renderPreview(doc);
  const img = readPNG(p.png);
  assert.ok(img.width > 16 * p.zoom * 2 && img.height > 16 * p.zoom);
  assert.match(p.description, /Frames 0, 1/);
  const tiled = renderPreview(doc, { tile: true, frames: [0] });
  assert.match(tiled.description, /tiled 3×3/);
});

test("exports: png pixels, sheet JSON and GIF header", () => {
  const doc = make(2, 2, { frames: 3, frameDuration: 120 });
  writeRows(doc, 0, "main", ["c.", ".c"]);
  doc.tags.push({ name: "spin", from: 1, to: 2, direction: "forward" });
  const [png] = buildExport(doc, "chars/dot", { format: "png", scale: 2 });
  assert.equal(png.path, "chars/dot_0@2x.png");
  const img = readPNG(png.data);
  assert.equal(img.width, 4);
  assert.deepEqual([...img.data.subarray(0, 4)], [0xf4, 0xf4, 0xf4, 255]);
  assert.equal(img.data[(0 * 4 + 2) * 4 + 3], 0);

  const [sheet, json] = buildExport(doc, "chars/dot", { format: "sheet" });
  const meta = JSON.parse(json.data.toString());
  assert.equal(meta.frames.length, 3);
  assert.equal(meta.frames[2].frame.x, 4);
  assert.equal(meta.frames[0].duration, 120);
  assert.equal(meta.meta.frameTags[0].name, "spin");
  assert.equal(readPNG(sheet.data).width, 6);

  const tagged = buildExport(doc, "dot", { format: "sheet", tag: "spin" });
  assert.equal(JSON.parse(tagged[1].data.toString()).frames.length, 2);

  const [gif] = buildExport(doc, "dot", { format: "gif", scale: 3 });
  assert.equal(gif.data.subarray(0, 6).toString("ascii"), "GIF89a");
});

test("import: PNG export round-trips; sheets slice into frames", () => {
  const doc = make(3, 2, { frames: 2 });
  writeRows(doc, 0, "main", ["012", "..3"]);
  writeRows(doc, 1, "main", ["456", "7.."]);
  const [sheet] = buildExport(doc, "x", { format: "sheet", scale: 4 });
  const { doc: back } = imageToDoc(readPNG(sheet.data), { downscale: 4, frameWidth: 3, palette: { colors: PAL } });
  assert.equal(back.frames.length, 2);
  assert.deepEqual(rows(back, 0), ["012", "..3"]);
  assert.deepEqual(rows(back, 1), ["456", "7.."]);
  const own = imageToDoc(readPNG(sheet.data), { downscale: 4 });
  assert.equal(own.doc.palette.length, 8);
});

test("audit flags stray pixels and edge contact", () => {
  const doc = make(8, 8);
  writeRows(doc, 0, "main", ["........", "........", "..00....", "..00....", "........", "......1.", "........", "........"]);
  const report = audit(doc, "t");
  assert.match(report, /Stray pixels.*\(6,5\)/);
  assert.doesNotMatch(report, /canvas edge/);
  writeRows(doc, 0, "main", ["0"]);
  assert.match(audit(doc, "t"), /canvas edge/);
});

test("default workspace: dotquill-art, or an existing older pixel-art workspace", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dotquill-default-"));
  try {
    assert.equal(defaultWorkspaceDir(dir), path.join(dir, "dotquill-art"));
    await mkdir(path.join(dir, "pixel-art"));
    assert.equal(defaultWorkspaceDir(dir), path.join(dir, "dotquill-art"), "a pixel-art folder of another tool is ignored");
    await mkdir(path.join(dir, "pixel-art", ".dotquill"));
    assert.equal(defaultWorkspaceDir(dir), path.join(dir, "pixel-art"));
    await mkdir(path.join(dir, "dotquill-art"));
    assert.equal(defaultWorkspaceDir(dir), path.join(dir, "dotquill-art"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("workspace: save, list, undo, rename, delete", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dotquill-test-"));
  try {
    const ws = new Workspace(dir);
    const doc = make(2, 1);
    writeRows(doc, 0, "main", ["11"]);
    await ws.save("chars/a", doc);
    writeRows(doc, 0, "main", ["22"]);
    await ws.save("chars/a", doc);
    assert.deepEqual(rows(await ws.load("chars/a")), ["22"]);
    assert.equal(await ws.undo("chars/a"), true);
    assert.deepEqual(rows(await ws.load("chars/a")), ["11"]);
    assert.equal((await ws.list())[0].name, "chars/a");
    await ws.rename("chars/a", "b");
    assert.equal(await ws.exists("b"), true);
    await ws.remove("b");
    assert.equal((await ws.list()).length, 0);
    assert.throws(() => ws.file("../evil"), /Invalid asset name/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("outline refresh rebuilds the ring after a part moves and keeps interior pixels", () => {
  const block = (doc: PixelDoc, x: number) => {
    applyOps(doc, 0, "main", [{ op: "rect", x, y: 1, w: 3, h: 3, color: "6", fill: true }]);
    writeRows(doc, 0, "main", ["1"], x + 1, 2); // interior pixel in the outline color
  };
  const moved = make(9, 5);
  block(moved, 2);
  applyOps(moved, 0, "main", [{ op: "outline", color: "1" }]);
  // Move only the block, not its outline: leaves a detached ring on the left and no outline on the right.
  applyOps(moved, 0, "main", [{ op: "copy", x: 2, y: 1, w: 3, h: 3, toX: 3, toY: 1, cut: true }]);
  applyOps(moved, 0, "main", [{ op: "outline", color: "1", refresh: true }]);

  const fresh = make(9, 5);
  block(fresh, 3);
  applyOps(fresh, 0, "main", [{ op: "outline", color: "1" }]);
  assert.deepEqual(rows(moved), rows(fresh));
  assert.equal(rows(moved)[2], "..16161..");
  assert.throws(() => applyOps(moved, 0, "main", [{ op: "outline", color: "1", mode: "inner", refresh: true }]), /outer/);
});

test("audit separates highlights from suspicious lone pixels and dedupes frames", () => {
  const doc = make(10, 10, { frames: 2 });
  for (const f of [0, 1]) {
    writeRows(doc, f, "main", ["ccc.000", "090.0c0", "000.000"], 1, 1); // (2,2) mid-tone suspect, (6,2) highlight
    writeRows(doc, f, "main", ["4"], 8, 8); // stray
  }
  const report = audit(doc, "t");
  assert.match(report, /Stray pixels.*: 1: \(8,8\) \[all frames\]/);
  assert.match(report, /Lone mid-tone pixels.*: 1: \(2,2\)="9" \[all frames\]/);
  assert.match(report, /1 lone highlight\(s\)/);
  assert.match(report, /Bounding box is the same in every frame/);
});

test("preview diff counts pixels changed since the previous frame", () => {
  const doc = make(4, 4, { frames: 3 });
  for (const f of [0, 1, 2]) writeRows(doc, f, "main", ["1111"]);
  writeRows(doc, 1, "main", ["22"], 0, 2);
  const p = renderPreview(doc, { diff: true });
  assert.match(p.description, /f0 0 px, f1 2 px, f2 2 px/);
  assert.match(renderPreview(make(), { diff: true }).description, /single frame/);
});

test("9-slice: stretch and tile keep corners, validation catches bad margins", () => {
  const doc = make(4, 3);
  writeRows(doc, 0, "main", ["0ab9", "1cd8", "2ef7"]);
  const s = sliceFromMargins("bar", { x: 0, y: 0, w: 4, h: 3 }, { left: 1, top: 1, right: 1, bottom: 1 });
  const stretched = encodeRows(nineSlice(doc.composite(0), 4, s, 7, 4), 7, 4);
  assert.deepEqual(stretched, ["0aaabb9", "1cccdd8", "1cccdd8", "2eeeff7"]);
  const tiled = encodeRows(nineSlice(doc.composite(0), 4, { ...s, mode: "tile" }, 7, 3), 7, 3);
  assert.deepEqual(tiled, ["0ababa9", "1cdcdc8", "2efefe7"]);
  assert.throws(() => nineSlice(doc.composite(0), 4, s, 2, 3), /Stretch size/);
  assert.throws(() => sliceFromMargins("x", { x: 0, y: 0, w: 4, h: 3 }, { left: 2, top: 0, right: 2, bottom: 0 }), /no center/);
  assert.throws(() => validateSlice({ name: "big", bounds: { x: 2, y: 0, w: 4, h: 3 } }, 4, 3), /outside/);
});

test("slices survive the file format and reach the exports", async () => {
  const doc = make(8, 8, { frames: 2 });
  for (const f of [0, 1]) applyOps(doc, f, "main", [{ op: "rect", x: 0, y: 0, w: 8, h: 8, color: String(f + 1), fill: true }]);
  doc.slices.push(sliceFromMargins("panel", { x: 0, y: 0, w: 8, h: 8 }, { left: 3, top: 2, right: 3, bottom: 2 }, "tile"));
  doc.tags.push({ name: "Hover", from: 1, to: 1, direction: "forward" });
  const back = PixelDoc.fromJSON(JSON.parse(JSON.stringify(doc.toJSON())));
  assert.deepEqual(back.slices, doc.slices);

  const [, json] = buildExport(back, "ui/panel", { format: "sheet", scale: 2 });
  const slice = JSON.parse(json.data.toString()).meta.slices[0];
  assert.deepEqual(slice.keys[0].center, { x: 6, y: 4, w: 4, h: 8 });

  const files = buildExport(back, "ui/panel", { format: "godot-stylebox", scale: 2 });
  assert.deepEqual(files.map((f) => f.path), ["ui/panel_sheet@2x.png", "ui/panel_0@2x.tres", "ui/panel_hover@2x.tres"]);
  const hover = files[2].data.toString();
  assert.match(hover, /path="panel_sheet@2x.png"/);
  assert.match(hover, /texture_margin_left = 6\.0[\s\S]*texture_margin_bottom = 4\.0/);
  assert.match(hover, /axis_stretch_horizontal = 1/);
  assert.match(hover, /region_rect = Rect2\(16, 0, 16, 16\)/);
  const res = buildExport(back, "ui/panel", { format: "godot-stylebox", resDir: "res://art/" });
  assert.match(res[1].data.toString(), /path="res:\/\/art\/ui\/panel_sheet.png"/);
  assert.throws(() => buildExport(make(), "x", { format: "godot-stylebox" }), /no 9-slice/);

  const p = renderPreview(back, { stretch: [20, 12] });
  assert.match(p.description, /stretched to 20×12 through 9-slice "panel" \(tile\)/);
  assert.match(renderPreview(back).description, /Yellow dashed lines/);

  const dir = await mkdtemp(path.join(os.tmpdir(), "dotquill-godot-"));
  try {
    await writeFile(path.join(dir, "project.godot"), "");
    await mkdir(path.join(dir, "assets", "ui"), { recursive: true });
    assert.equal(await findGodotResDir(path.join(dir, "assets", "ui")), "res://assets/ui/");
    assert.equal(await findGodotResDir(dir), "res://");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("godot-spriteframes: one animation per tag with relative durations", () => {
  const doc = make(2, 2, { frames: 4, frameDuration: 100 });
  doc.frames[1].duration = 200;
  doc.tags.push(
    { name: "idle", from: 0, to: 1, direction: "forward" },
    { name: "swing", from: 1, to: 3, direction: "pingpong" },
  );
  const anims = godotAnimations(doc);
  assert.deepEqual(anims.map((a) => [a.name, a.frames, a.speed, a.durations]), [
    ["idle", [0, 1], 10, [1, 2]],
    ["swing", [1, 2, 3, 2], 10, [2, 1, 1, 1]],
  ]);
  const [png, tres] = buildExport(doc, "chars/hero", { format: "godot-spriteframes", scale: 3 });
  assert.equal(png.path, "chars/hero_sheet@3x.png");
  assert.equal(readPNG(png.data).width, 24);
  assert.equal(tres.path, "chars/hero_frames@3x.tres");
  const t = tres.data.toString();
  assert.match(t, /\[gd_resource type="SpriteFrames" load_steps=6 format=3\]/);
  assert.match(t, /path="hero_sheet@3x.png"/);
  assert.match(t, /id="AtlasTexture_f3"\]\natlas = ExtResource\("1_tex"\)\nregion = Rect2\(18, 0, 6, 6\)/);
  assert.match(t, /"duration": 2\.0,\n"texture": SubResource\("AtlasTexture_f1"\)/);
  assert.match(t, /"name": &"swing",\n"speed": 10\.0/);
  const def = godotAnimations(make(2, 2, { frames: 2 }));
  assert.deepEqual([def[0].name, def[0].frames], ["default", [0, 1]]);
  assert.equal(godotAnimations(doc, "idle").length, 1);
});

/**
 * Blob template with 4 px tiles; template cell (col,row) is filled with color col + 7·row.
 * The hole (4,1) and the variant cells (6,1), (6,2) stay empty, so (6,0) is the only variant.
 */
function blobTemplate(): PixelDoc {
  const T = 4;
  const doc = make(7 * T, 3 * T, { palette: PRESETS["endesga-32"].colors, tileset: { tile: T, layout: "blob", terrain: "grass" } });
  const cel = doc.cel(0, "main");
  for (let y = 0; y < doc.height; y++) {
    for (let x = 0; x < doc.width; x++) {
      const c = Math.floor(x / T) + 7 * Math.floor(y / T);
      if (![11, 13, 20].includes(c)) cel[y * doc.width + x] = c;
    }
  }
  return doc;
}
/** Color of each quarter (TL, TR, BL, BR) of a 4 px tile. */
const quarters = (px: Int16Array) => [px[0], px[2], px[8], px[10]];

test("tileset: 47 blob masks, validation and the file format", () => {
  assert.equal(BLOB_MASKS.length, 47);
  assert.equal(normalizeMask(NE | N), N, "a corner without both sides does not count");
  assert.throws(() => validateTileset({ tile: 5 }, 25, 15), /even size/);
  assert.throws(() => validateTileset({ tile: 16 }, 80, 48), /112×48/);
  assert.throws(() => validateTileset({ tile: 16, layout: "grid" }, 40, 32), /whole number/);
  assert.deepEqual(validateTileset({ tile: 8, layout: "grid", terrain: " rock " }, 32, 16), { tile: 8, layout: "grid", terrain: "rock" });
  const back = PixelDoc.fromJSON(JSON.parse(JSON.stringify(blobTemplate().toJSON())));
  assert.deepEqual(back.tileset, { tile: 4, layout: "blob", terrain: "grass" });
  assert.equal(make(4, 4).toJSON().tileset, undefined);
});

test("blob tiles: drawn template tiles are kept, the rest are built from the right quarters", () => {
  const tiles = blobTiles(blobTemplate());
  assert.equal(tiles.length, 48, "47 tiles + 1 center variant");
  const get = (mask: number, variant = 0) => tiles.find((t) => t.mask === mask && t.variant === variant)!;
  assert.deepEqual(quarters(get(E | S | SE).pixels), [0, 0, 0, 0]);
  assert.equal(get(E | S | SE).source, "drawn");
  // Isolated cell: the four outer corners.
  assert.deepEqual(quarters(get(0).pixels), [0, 2, 14, 16]);
  assert.equal(get(0).source, "composed");
  // Vertical strip: left and right edges; horizontal strip: top and bottom edges.
  assert.deepEqual(quarters(get(N | S).pixels), [7, 9, 7, 9]);
  assert.deepEqual(quarters(get(E | WEST).pixels), [1, 1, 15, 15]);
  // All sides, only NW and SE diagonals: inner corners at top-right and bottom-left.
  assert.deepEqual(quarters(get(N | E | S | WEST | NW | SE).pixels), [8, 17, 5, 8]);
  assert.deepEqual(quarters(get(255, 1).pixels), [6, 6, 6, 6]);
});

test("tilemap: each cell gets the tile of its neighbors; the sample map uses all 47", () => {
  const doc = blobTemplate();
  assert.equal(renderTilemap(doc).distinct, 47);
  const tm = renderTilemap(doc, ["##", ".#"]);
  assert.deepEqual([tm.width, tm.height, tm.cols, tm.rows], [8, 8, 2, 2]);
  const tile = (cx: number, cy: number) =>
    Int16Array.from({ length: 16 }, (_, i) => tm.pixels[(cy * 4 + Math.floor(i / 4)) * tm.width + cx * 4 + (i % 4)]);
  assert.deepEqual(quarters(tile(0, 0)), [0, 1, 14, 15], "left end of a strip");
  assert.deepEqual(quarters(tile(1, 0)), [1, 2, 5, 9], "corner of an L: inner corner toward the empty diagonal");
  assert.deepEqual(quarters(tile(0, 1)), [-1, -1, -1, -1]);
  assert.throws(() => renderTilemap(doc, ["#x"]), /use "#" for terrain/);
  const p = renderTilemapPreview(doc);
  assert.equal(readPNG(p.png).width > 0, true);
  assert.match(p.description, /47 of the 47 tiles appear/);
  assert.match(renderPreview(doc).description, /Orange lines = 4 px tile boundaries\. Blob template/);
});

test("godot-tileset: terrain peering bits, variants, collision and grid tilesets", () => {
  const [png, tres] = buildExport(blobTemplate(), "tiles/grass", { format: "godot-tileset", scale: 2, collision: true });
  assert.equal(png.path, "tiles/grass_tiles@2x.png");
  assert.equal(tres.path, "tiles/grass_tileset@2x.tres");
  const img = readPNG(png.data);
  assert.deepEqual([img.width, img.height], [8 * 8, 6 * 8]);
  const t = tres.data.toString();
  assert.match(t, /\[gd_resource type="TileSet" load_steps=3 format=3\]/);
  assert.match(t, /texture_region_size = Vector2i\(8, 8\)/);
  assert.equal(t.match(/\/0\/terrain = 0/g)?.length, 48);
  assert.equal(t.match(/polygon_0\/points = PackedVector2Array\(-4, -4, 4, -4, 4, 4, -4, 4\)/g)?.length, 48);
  assert.equal(t.match(/probability = 0\.25/g)?.length, 1);
  // Tile 0 (mask 0) has no peering bits; tile 1 (mask N) has only top_side.
  assert.match(t, /0:0\/0\/physics_layer_0\/polygon_0\/points = [^\n]+\n1:0\/0 = 0/);
  assert.match(t, /1:0\/0\/physics_layer_0\/polygon_0\/points = [^\n]+\n1:0\/0\/terrains_peering_bit\/top_side = 0\n2:0\/0 = 0/);
  assert.match(t, /terrain_set_0\/mode = 0\nterrain_set_0\/terrain_0\/name = "grass"/);
  assert.match(t, /physics_layer_0\/collision_layer = 1/);

  const grid = make(16, 8, { tileset: { tile: 8, layout: "grid" } });
  writeRows(grid, 0, "main", ["........11111111"]);
  const [gpng, gtres] = buildExport(grid, "props", { format: "godot-tileset" });
  assert.deepEqual([readPNG(gpng.data).width, readPNG(gpng.data).height], [16, 8]);
  const g = gtres.data.toString();
  assert.match(g, /\n1:0\/0 = 0\n/);
  assert.doesNotMatch(g, /0:0\/0 = 0|terrain/);
  assert.throws(() => buildExport(make(), "x", { format: "godot-tileset" }), /not a tileset/);
});

test("audit: tileset template checks replace the edge-contact warning", () => {
  const doc = blobTemplate();
  const ok = audit(doc, "grass");
  assert.doesNotMatch(ok, /canvas edge/);
  assert.match(ok, /Blob tileset: 47 tiles \(13 drawn, 34 composed\) \+ 1 center variant/);
  assert.match(ok, /quarter\(s\) differ/);
  applyOps(doc, 0, "main", [{ op: "clear", region: { x: 12, y: 0, w: 4, h: 4 } }]);
  assert.match(audit(doc, "grass"), /Empty template tile\(s\): \(3,0\) inner corner \(hole at bottom-right\)/);
});

/** Minimal .aseprite reader written from the spec, to check the writer independently. */
function readAseprite(buf: Buffer) {
  let o = 0;
  const u8 = () => buf.readUInt8(o++);
  const u16 = () => ((o += 2), buf.readUInt16LE(o - 2));
  const i16 = () => ((o += 2), buf.readInt16LE(o - 2));
  const u32 = () => ((o += 4), buf.readUInt32LE(o - 4));
  const i32 = () => ((o += 4), buf.readInt32LE(o - 4));
  const str = () => {
    const n = u16();
    o += n;
    return buf.toString("utf8", o - n, o);
  };
  const size = u32();
  const magic = u16();
  const frameCount = u16();
  const width = u16();
  const height = u16();
  const depth = u16();
  o = 28;
  const transparent = u8();
  o = 32;
  const colorCount = u16();
  o = 40;
  const grid = [u16(), u16()];
  o = 128;
  const palette: string[] = [];
  const layers: { name: string; visible: boolean }[] = [];
  const tags: { name: string; from: number; to: number; dir: number }[] = [];
  const slices: { name: string; bounds: number[]; center?: number[] }[] = [];
  const frames: { duration: number; cels: { layer: number; x: number; y: number; w: number; h: number; px: Buffer }[] }[] = [];
  for (let f = 0; f < frameCount; f++) {
    const start = o;
    const bytes = u32();
    assert.equal(u16(), 0xf1fa, "frame magic");
    u16();
    const duration = u16();
    o += 2;
    const chunks = u32();
    const frame = { duration, cels: [] as (typeof frames)[number]["cels"] };
    for (let c = 0; c < chunks; c++) {
      const cs = o;
      const len = u32();
      const type = u16();
      if (type === 0x2019) {
        const n = u32();
        const from = u32();
        const to = u32();
        o += 8;
        for (let i = from; i <= to; i++) {
          u16();
          const [r, g, b, a] = [u8(), u8(), u8(), u8()];
          palette[i] = a ? `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}` : "transparent";
        }
        assert.equal(palette.length, n);
      } else if (type === 0x2004) {
        const flags = u16();
        o += 2 * 5 + 1 + 3;
        layers.push({ name: str(), visible: !!(flags & 1) });
      } else if (type === 0x2005) {
        const layer = u16();
        const x = i16();
        const y = i16();
        o += 1;
        assert.equal(u16(), 2, "compressed cel");
        o += 2 + 5;
        const w = u16();
        const h = u16();
        frame.cels.push({ layer, x, y, w, h, px: inflateSync(buf.subarray(o, cs + len)) });
      } else if (type === 0x2018) {
        const n = u16();
        o += 8;
        for (let i = 0; i < n; i++) {
          const from = u16();
          const to = u16();
          const dir = u8();
          o += 2 + 6 + 3 + 1;
          tags.push({ name: str(), from, to, dir });
        }
      } else if (type === 0x2022) {
        u32();
        const flags = u32();
        u32();
        const name = str();
        u32();
        const bounds = [i32(), i32(), u32(), u32()];
        slices.push(flags & 1 ? { name, bounds, center: [i32(), i32(), u32(), u32()] } : { name, bounds });
      }
      o = cs + len;
    }
    assert.equal(o - start, bytes, `frame ${f} size`);
    frames.push(frame);
  }
  assert.equal(o, size, "file size");
  return { magic, frameCount, width, height, depth, transparent, colorCount, grid, palette, layers, tags, slices, frames };
}

test("aseprite export: header, palette, layers, cels, tags and slices read back per the spec", () => {
  const doc = make(6, 4, { layers: ["body", "fx"], frames: 2, frameDuration: 120 });
  writeRows(doc, 0, "body", ["......", ".0123.", ".4567.", "......"]);
  writeRows(doc, 1, "body", ["..12..", "......", "......", "......"]);
  writeRows(doc, 0, "fx", ["f.....", "......", "......", ".....e"]);
  doc.layers[1].visible = false;
  doc.frames[1].duration = 300;
  doc.tags.push({ name: "idle", from: 0, to: 1, direction: "pingpong" });
  doc.slices.push(sliceFromMargins("box", { x: 0, y: 0, w: 6, h: 4 }, { left: 1, top: 1, right: 2, bottom: 1 }));
  const [file] = buildExport(doc, "chars/thing", { format: "aseprite", scale: 4 });
  assert.equal(file.path, "chars/thing.aseprite");
  const a = readAseprite(file.data);
  assert.deepEqual([a.magic, a.frameCount, a.width, a.height, a.depth, a.transparent], [0xa5e0, 2, 6, 4, 8, 0]);
  assert.equal(a.colorCount, PAL.length + 1);
  assert.deepEqual(a.palette, ["transparent", ...PAL]);
  assert.deepEqual(a.layers, [
    { name: "body", visible: true },
    { name: "fx", visible: false },
  ]);
  assert.deepEqual(a.frames.map((f) => f.duration), [120, 300]);
  // Cels are cropped to their pixels; index i is stored as i + 1.
  const body0 = a.frames[0].cels.find((c) => c.layer === 0)!;
  assert.deepEqual([body0.x, body0.y, body0.w, body0.h], [1, 1, 4, 2]);
  assert.deepEqual([...body0.px], [1, 2, 3, 4, 5, 6, 7, 8]);
  const fx0 = a.frames[0].cels.find((c) => c.layer === 1)!;
  assert.deepEqual([fx0.x, fx0.y, fx0.w, fx0.h, fx0.px[0], fx0.px[fx0.px.length - 1]], [0, 0, 6, 4, 16, 15]);
  assert.deepEqual(a.frames[1].cels.map((c) => [c.layer, c.x, c.y, c.w, c.h]), [[0, 2, 0, 2, 1]]);
  assert.deepEqual(a.tags, [{ name: "idle", from: 0, to: 1, dir: 2 }]);
  assert.deepEqual(a.slices, [{ name: "box", bounds: [0, 0, 6, 4], center: [1, 1, 3, 2] }]);
  assert.deepEqual(a.grid, [0, 0]);
  assert.deepEqual(readAseprite(buildExport(blobTemplate(), "t", { format: "aseprite" })[0].data).grid, [4, 4]);
});

test("pattern op repeats a tile of rows over a box", () => {
  const doc = make(7, 3);
  applyOps(doc, 0, "main", [
    { op: "rect", x: 0, y: 0, w: 7, h: 3, color: "1", fill: true },
    { op: "pattern", x: 1, y: 0, w: 6, h: 3, rows: ["23_", "4.5"] },
  ]);
  assert.deepEqual(rows(doc), ["1231231", "14.54.5", "1231231"]);
  assert.throws(() => applyOps(doc, 0, "main", [{ op: "pattern", x: 0, y: 0, w: 2, h: 2, rows: ["12", "3"] }]), /same length/);
});

test("viewer: paint strokes and undo over HTTP; foreign origins are refused", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dotquill-viewer-"));
  const ws = new Workspace(dir);
  const viewer = await startViewer(ws, { port: 7480 + Math.floor(Math.random() * 400) });
  try {
    const doc = make(4, 2);
    writeRows(doc, 0, "main", ["1111", "...."]);
    await ws.save("pic", doc);
    const post = (p: string, body: unknown, headers: Record<string, string> = {}) =>
      fetch(new URL(p, viewer.url), { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
    const stroke = { name: "pic", frame: 0, layer: "main", color: 2, points: [[0, 1], [1, 1], [9, 9]] };
    assert.equal((await post("/api/paint", stroke, { Origin: "http://evil.example" })).status, 403);
    assert.equal((await post("/api/paint", { ...stroke, color: 99 })).status, 400);
    assert.equal((await post("/api/paint", stroke)).status, 200);
    assert.deepEqual(rows(await ws.load("pic")), ["1111", "22.."]);
    await post("/api/paint", { ...stroke, color: -1, points: [[0, 0]] });
    assert.deepEqual(rows(await ws.load("pic")), [".111", "22.."]);
    const undo = (await (await post("/api/undo", { name: "pic" })).json()) as { undone: boolean };
    assert.equal(undo.undone, true);
    assert.deepEqual(rows(await ws.load("pic")), ["1111", "22.."]);
  } finally {
    await viewer.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("animated tiles: frames that change become tile animations in Godot and Tiled", () => {
  const doc = blobTemplate();
  doc.frames[0].duration = 150;
  const f1 = new Map([["main", doc.cel(0, "main").slice()]]);
  f1.get("main")![1 * 4 * doc.width + 5] = 30; // one pixel of the center tile (1,1) changes in frame 1
  doc.frames.push({ duration: 250, cels: f1 });
  const atlas = buildTileAtlas(doc);
  assert.deepEqual([atlas.cols, atlas.rows, atlas.durations], [16, 6, [150, 250]]);
  assert.deepEqual([atlas.tiles[1].col, atlas.tiles[1].row, atlas.tiles[1].frames.length], [2, 0, 2]);

  const [png, tres] = buildExport(doc, "water", { format: "godot-tileset" });
  assert.deepEqual([readPNG(png.data).width, readPNG(png.data).height], [16 * 4, 6 * 4]);
  const t = tres.data.toString();
  assert.equal(t.match(/animation_frame_0\/duration = 0\.15/g)?.length, 48);
  assert.match(t, /2:0\/animation_frame_0\/duration = 0\.15\n2:0\/animation_frame_1\/duration = 0\.25\n2:0\/0 = 0/);

  const [, tsx] = buildExport(doc, "water", { format: "tiled-tileset", collision: true });
  const x = tsx.data.toString();
  assert.equal(tsx.path, "water.tsx");
  assert.match(x, /<tileset version="1\.10" name="grass" tilewidth="4" tileheight="4" tilecount="96" columns="16">/);
  assert.match(x, /<tile id="2">\n  <objectgroup draworder="index" id="2">\n   <object id="1" x="0" y="0" width="4" height="4"\/>\n  <\/objectgroup>\n  <animation>\n   <frame tileid="2" duration="150"\/>\n   <frame tileid="3" duration="250"\/>/);

  // Static: no animation; the wang set skips the lone tile; wangid order is top, top-right, right, …, top-left.
  const still = buildExport(blobTemplate(), "g", { format: "tiled-tileset" })[1].data.toString();
  assert.doesNotMatch(still, /<animation>/);
  assert.equal(still.match(/<wangtile /g)?.length, 47);
  assert.match(still, /<wangset name="grass" type="mixed" tile="46">/);
  assert.match(still, /<wangtile tileid="1" wangid="1,0,0,0,0,0,0,0"\/>/);
  assert.match(still, /<tile id="47" probability="0\.25"\/>/);

  // Grid tilesets animate the same way, keeping their cell layout (each cell N tiles wide).
  const grid = make(8, 4, { frames: 2, tileset: { tile: 4, layout: "grid" } });
  writeRows(grid, 0, "main", ["1111....", "1111....", "1111....", "1111...."]);
  writeRows(grid, 1, "main", ["1112....", "1111....", "1111....", "1111...."]);
  const ga = buildTileAtlas(grid);
  assert.deepEqual([ga.cols, ga.tiles.length, ga.tiles[0].frames.length], [4, 1, 2]);
  assert.deepEqual(buildTileAtlas(make(8, 4, { frames: 2, tileset: { tile: 4, layout: "grid" } })).durations.length, 1);

  const p = renderTilemapPreview(doc, { frames: [0, 1], diff: true });
  assert.match(p.description, /Maps of frames 0, 1 \(left→right\)/);
  assert.match(p.description, /Magenta squares/);
  assert.match(renderTilemapPreview(doc).description, /The tileset has 2 frames/);
});

test("re-exporting a Godot resource keeps the uid Godot gave it", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dotquill-uid-"));
  try {
    const files = buildExport(blobTemplate(), "tiles/water", { format: "godot-tileset" });
    const [, tresPath] = await writeExport(files, dir);
    const first = await readFile(tresPath, "utf8");
    assert.doesNotMatch(first, /uid=/);
    // What Godot does when it first sees the file.
    await writeFile(tresPath, first.replace("format=3]", 'format=3 uid="uid://abc123xyz"]'));
    await writeExport(files, dir);
    assert.match(await readFile(tresPath, "utf8"), /^\[gd_resource type="TileSet" load_steps=3 format=3 uid="uid:\/\/abc123xyz"\]/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("formatGrid adds rulers", () => {
  const g = formatGrid(["0123456789ab"], 12);
  assert.equal(g.split("\n")[0].trim(), "0         1");
  assert.ok(g.endsWith("0  0123456789ab"));
});
