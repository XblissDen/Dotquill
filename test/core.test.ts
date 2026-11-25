import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { audit } from "../src/core/audit.ts";
import { readPNG } from "../src/core/bitmap.ts";
import { PixelDoc } from "../src/core/doc.ts";
import { applyOps, ellipseMask, resolveColor, writeRows } from "../src/core/draw.ts";
import { buildExport, findGodotResDir } from "../src/core/export.ts";
import { encodeRows, formatGrid } from "../src/core/grid.ts";
import { imageToDoc } from "../src/core/importer.ts";
import { PRESETS } from "../src/core/palettes.ts";
import { renderPreview } from "../src/core/render.ts";
import { nineSlice, sliceFromMargins, validateSlice } from "../src/core/slices.ts";
import { Workspace } from "../src/core/store.ts";

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

test("formatGrid adds rulers", () => {
  const g = formatGrid(["0123456789ab"], 12);
  assert.equal(g.split("\n")[0].trim(), "0         1");
  assert.ok(g.endsWith("0  0123456789ab"));
});
