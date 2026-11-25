/**
 * End-to-end smoke test: starts the real MCP server over stdio, connects as a client
 * (as Claude Code would) and draws, animates, previews, audits, exports and imports.
 *
 *   node scripts/smoke.ts [workspace-dir]     (default: a temp folder)
 *
 * Preview images are written to <workspace>/.dotquill/smoke/.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repo = fileURLToPath(new URL("..", import.meta.url));
const dir = path.resolve(process.argv[2] ?? (await mkdtemp(path.join(os.tmpdir(), "dotquill-smoke-"))));
const shots = path.join(dir, ".dotquill", "smoke");
await mkdir(shots, { recursive: true });

const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
env.DOTQUILL_NO_VIEWER = "1";

const client = new Client({ name: "dotquill-smoke", version: "0.0.0" });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [path.join(repo, "src", "mcp", "server.ts"), "--dir", dir],
    env,
    stderr: "inherit",
  }),
);

type Item = { type: string; text?: string; data?: string };
let shot = 0;
async function call(name: string, args: Record<string, unknown>, expectError = false): Promise<string> {
  const r = (await client.callTool({ name, arguments: args })) as { content: Item[]; isError?: boolean };
  const text = r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  for (const img of r.content.filter((c) => c.type === "image")) {
    const file = path.join(shots, `${String(++shot).padStart(2, "0")}-${name}.png`);
    await writeFile(file, Buffer.from(img.data!, "base64"));
    console.log(`  [image] ${file}`);
  }
  if (expectError) assert.ok(r.isError, `${name} should have failed`);
  else assert.ok(!r.isError, `${name} failed:\n${text}`);
  console.log(`\n▶ ${name}${expectError ? " (expected error)" : ""}\n${text}`);
  return text;
}

const SCRATCH = ["smoke/shapes", "smoke/shapes-copy", "smoke/imported", "smoke/anim", "smoke/button"];
// Leftovers from an interrupted run (errors ignored).
for (const n of SCRATCH) await client.callTool({ name: "manage_asset", arguments: { action: "delete", name: n } });

const tools = (await client.listTools()).tools.map((t) => t.name);
console.log(`Tools (${tools.length}): ${tools.join(", ")}`);
assert.equal(tools.length, 16);

await call("guide", { topic: "workflow" });

// A 16×16 slime with a 2-frame idle (normal + squash). Sweetie 16:
// 0 outline, 5 highlight, 6 body, 7 shadow, c eye shine.
const idle = [
  "................",
  "................",
  "................",
  "................",
  "......0000......",
  "....00556600....",
  "...0556666660...",
  "..055666666670..",
  "..056666666670..",
  ".05666666666670.",
  ".066c06666c0670.",
  ".06600666600670.",
  ".06666600666770.",
  ".07777777777770.",
  "..000000000000..",
  "................",
];
const squash = [
  "................",
  "................",
  "................",
  "................",
  "................",
  "................",
  ".....000000.....",
  "...0055566600...",
  "..055666666670..",
  ".05566666666670.",
  ".066c06666c0670.",
  ".06600666600670.",
  ".06666600666770.",
  ".07777777777770.",
  "..000000000000..",
  "................",
];
for (const r of [...idle, ...squash]) assert.equal(r.length, 16, `bad row "${r}"`);

await call("create_asset", {
  name: "slime",
  width: 16,
  height: 16,
  palette: { preset: "sweetie-16" },
  frameDuration: 320,
  notes: "Demo: green slime, light from top-left, dark outline.",
  overwrite: true,
});
await call("write_pixels", { name: "slime", rows: idle });
await call("frames", {
  name: "slime",
  ops: [
    { action: "add", copyFrom: 0, duration: 220 },
    { action: "tag", name: "idle", from: 0, to: 1 },
  ],
});
await call("write_pixels", { name: "slime", rows: squash, frame: 1 });
await call("get_asset", { name: "slime", frame: 1 });
await call("render_preview", { name: "slime" });
await call("audit", { name: "slime" });
await call("export", { name: "slime", format: "sheet", scale: 4 });
await call("export", { name: "slime", format: "gif", scale: 6 });

// Tool coverage on a scratch asset.
await call("create_asset", { name: "smoke/shapes", width: 12, height: 12, palette: { preset: "pico-8" }, overwrite: true });
await call("draw", {
  name: "smoke/shapes",
  ops: [
    { op: "ellipse", x: 1, y: 1, w: 10, h: 10, color: "c", fill: true },
    { op: "ellipse", x: 5, y: 5, w: 6, h: 6, color: "1", fill: true, onlyOn: ["c"] },
    { op: "outline", color: "0" },
    { op: "line", points: [[2, 9], [9, 2]], color: "7" },
    { op: "dither", x: 0, y: 0, w: 12, h: 4, color: "6", pattern: "checker", onlyOn: ["c"] },
  ],
  preview: true,
});
await call("write_pixels", { name: "smoke/shapes", rows: ["1 2"] }, true);
await call("draw", { name: "smoke/shapes", ops: [{ op: "pixel", points: [[0, 0]], color: "#123456" }] }, true);
await call("layers", {
  name: "smoke/shapes",
  ops: [
    { action: "add", name: "fx" },
    { action: "rename", name: "fx", to: "sparkle" },
  ],
});
await call("draw", { name: "smoke/shapes", layer: "sparkle", ops: [{ op: "pixel", points: [[3, 3], [4, 3]], color: "7" }] });
await call("layers", { name: "smoke/shapes", ops: [{ action: "merge_down", name: "sparkle" }] });
await call("palette", { action: "presets" });
await call("palette", { action: "edit", name: "smoke/shapes", index: "c", color: "#29adfe" });
await call("palette", { action: "set", name: "smoke/shapes", palette: { fromAsset: "slime" } });
await call("render_preview", { name: "smoke/shapes", tile: true });
await call("manage_asset", { action: "undo", name: "smoke/shapes" });
await call("manage_asset", { action: "duplicate", name: "smoke/shapes", to: "smoke/shapes-copy" });
await call("import_png", {
  path: path.join(dir, "exports", "slime_sheet@4x.png"),
  name: "smoke/imported",
  palette: { fromAsset: "slime" },
  downscale: 4,
  frameWidth: 16,
  overwrite: true,
});
const imported = await call("get_asset", { name: "smoke/imported", frame: 1, rulers: false });
assert.ok(imported.includes(squash.join("\n")), "import should reproduce the squash frame exactly");

// Animation helpers: ops on a list of frames, outline refresh, diff preview, notes.
await call("create_asset", { name: "smoke/anim", width: 10, height: 10, frames: 3, overwrite: true });
await call("draw", {
  name: "smoke/anim",
  allFrames: true,
  ops: [
    { op: "rect", x: 2, y: 2, w: 4, h: 4, color: "m", fill: true },
    { op: "outline", color: "p" },
  ],
});
const multi = await call("draw", {
  name: "smoke/anim",
  frames: [1, 2],
  ops: [
    { op: "copy", x: 2, y: 2, w: 4, h: 4, toX: 3, toY: 2, cut: true },
    { op: "outline", color: "p", refresh: true },
  ],
});
assert.match(multi, /frame 1:.*\nframe 2:/);
const diffed = await call("render_preview", { name: "smoke/anim", diff: true });
assert.match(diffed, /Magenta squares.*f0 \d+ px, f1 \d+ px, f2 0 px/);
await call("manage_asset", { action: "notes", name: "smoke/anim", notes: "Box slides right on frames 1-2." });
assert.match(await call("get_asset", { name: "smoke/anim" }), /Notes: Box slides right/);

// Pixel UI: a 3-state 9-slice button exported into a (fake) Godot project.
await call("create_asset", { name: "smoke/button", width: 12, height: 12, frames: 3, overwrite: true });
await call("draw", {
  name: "smoke/button",
  allFrames: true,
  ops: [
    { op: "rect", x: 0, y: 0, w: 12, h: 12, color: "p", fill: true },
    { op: "rect", x: 1, y: 1, w: 10, h: 10, color: "m", fill: true },
    { op: "line", points: [[1, 1], [10, 1]], color: "k" },
  ],
});
await call("draw", { name: "smoke/button", frame: 2, ops: [{ op: "replace", from: "m", to: "l" }] });
await call("frames", {
  name: "smoke/button",
  ops: [
    { action: "tag", name: "normal", from: 0, to: 0 },
    { action: "tag", name: "hover", from: 1, to: 1 },
    { action: "tag", name: "pressed", from: 2, to: 2 },
  ],
});
assert.match(
  await call("slices", { name: "smoke/button", ops: [{ action: "set", slice: "face", nine: { left: 3, top: 3, right: 3, bottom: 3 } }] }),
  /9-slice margins L3 T3 R3 B3/,
);
assert.match(await call("render_preview", { name: "smoke/button", frames: [0] }), /Yellow dashed lines/);
assert.match(await call("render_preview", { name: "smoke/button", stretch: [40, 16] }), /stretched to 40×16/);
const godotDir = path.join(dir, "godot-game");
await mkdir(path.join(godotDir, "ui"), { recursive: true });
await writeFile(path.join(godotDir, "project.godot"), "");
const exported = await call("export", { name: "smoke/button", format: "godot-stylebox", scale: 4, outDir: path.join(godotDir, "ui") });
assert.match(exported, /button_pressed@4x\.tres/);
assert.match(exported, /textures referenced as res:\/\/ui\//);

// Animations for Godot: the slime's idle tag becomes a SpriteFrames animation.
const sf = await call("export", { name: "slime", format: "godot-spriteframes", scale: 4, outDir: path.join(godotDir, "sprites") });
assert.match(sf, /Animations: idle \(2 frames, 4\.55 fps\)/);
const tres = await readFile(path.join(godotDir, "sprites", "slime_frames@4x.tres"), "utf8");
assert.match(tres, /path="res:\/\/sprites\/slime_sheet@4x\.png"/);
assert.match(tres, /"duration": 1\.45455/);
await call("list_assets", {});
for (const n of SCRATCH) await call("manage_asset", { action: "delete", name: n });

await client.close();
console.log(`\n✅ Smoke test passed. Workspace: ${dir}`);
