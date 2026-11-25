/**
 * Renders the README images in docs/ from the example assets in examples/.
 *
 *   node scripts/docs.ts
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Bitmap, paletteRGB, type RGBA } from "../src/core/bitmap.ts";
import type { PixelDoc } from "../src/core/doc.ts";
import { buildExport } from "../src/core/export.ts";
import { renderPreview } from "../src/core/render.ts";
import { nineSlice } from "../src/core/slices.ts";
import { Workspace } from "../src/core/store.ts";
import { renderTilemap } from "../src/core/tileset.ts";

const repo = fileURLToPath(new URL("..", import.meta.url));
const ws = new Workspace(path.join(repo, "examples"));
const outDir = path.join(repo, "docs");
await mkdir(outDir, { recursive: true });

const SKY: RGBA = [75, 136, 201, 255];
const NIGHT: RGBA = [30, 32, 48, 255];
const LINE: RGBA = [255, 255, 255, 60];

async function save(file: string, data: Buffer): Promise<void> {
  await writeFile(path.join(outDir, file), data);
  console.log(`docs/${file} (${data.length} bytes)`);
}

function draw(b: Bitmap, doc: PixelDoc, px: Int16Array, w: number, h: number, x: number, y: number, s: number): void {
  b.drawIndexed(px, w, h, paletteRGB(doc.palette), x, y, s);
}

// Animated character.
const knight = await ws.load("characters/dark-knight");
await save("knight-idle.gif", buildExport(knight, "knight", { format: "gif", scale: 6 })[0].data);

// What Claude looks at while drawing: zoom, rulers, grid and actual-size copies.
await save("claude-preview.png", renderPreview(knight, { frames: [0, 6], zoom: 12 }).png);

// Tileset: the template Claude draws, and the 47 generated tiles painted on a test map.
const ground = await ws.load("tiles/ground");
{
  const s = 4;
  const T = ground.tileset!.tile;
  const pad = 16;
  const b = new Bitmap(ground.width * s + pad * 2, ground.height * s + pad * 2, NIGHT);
  draw(b, ground, ground.composite(0), ground.width, ground.height, pad, pad, s);
  for (let x = T; x < ground.width; x += T) b.fillRect(pad + x * s, pad, 1, ground.height * s, LINE);
  for (let y = T; y < ground.height; y += T) b.fillRect(pad, pad + y * s, ground.width * s, 1, LINE);
  await save("tileset-template.png", b.toPNG());
}
{
  const s = 2;
  const tm = renderTilemap(ground);
  const b = new Bitmap(tm.width * s, tm.height * s, SKY);
  draw(b, ground, tm.pixels, tm.width, tm.height, 0, 0, s);
  await save("tileset-map.png", b.toPNG());
}

// UI: a panel and the three button states, resized through their 9-slices.
{
  const panel = await ws.load("ui/panel");
  const button = await ws.load("ui/button");
  const s = 4;
  const pad = 24;
  const gap = 16;
  const [pw, ph] = [112, 60];
  const [bw, bh] = [56, 16];
  const b = new Bitmap(pad * 2 + pw * s + gap * 2 + bw * s, pad * 2 + ph * s, NIGHT);
  draw(b, panel, nineSlice(panel.composite(0), panel.width, panel.nineSlice(), pw, ph), pw, ph, pad, pad, s);
  const bx = pad + pw * s + gap * 2;
  const by = pad + Math.floor((ph * s - (3 * bh * s + 2 * gap)) / 2);
  for (let f = 0; f < 3; f++) {
    draw(b, button, nineSlice(button.composite(f), button.width, button.nineSlice(), bw, bh), bw, bh, bx, by + f * (bh * s + gap), s);
  }
  await save("ui.png", b.toPNG());
}
