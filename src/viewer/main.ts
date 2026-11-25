#!/usr/bin/env node
/**
 * Standalone viewer, useful when Claude is not running:
 *   node src/viewer/main.ts [--dir <workspace>] [--port 7420] [--open]
 */
import path from "node:path";
import { Workspace } from "../core/store.ts";
import { openBrowser, startViewer } from "./server.ts";

const argv = process.argv.slice(2);
const arg = (flag: string) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : argv.find((a) => a.startsWith(`${flag}=`))?.slice(flag.length + 1);
};

const ws = new Workspace(arg("--dir") ?? process.env.DOTQUILL_DIR ?? path.join(process.cwd(), "pixel-art"));
const port = Number(arg("--port") ?? process.env.DOTQUILL_PORT) || 7420;
const viewer = await startViewer(ws, { port });

console.log(`Dotquill viewer: ${viewer.url}`);
console.log(`Workspace: ${ws.root}`);
if (viewer.reused) {
  console.log("(A viewer for this workspace is already running; nothing else to do.)");
} else {
  // startViewer unrefs the server so the MCP process can exit; keep this process alive.
  setInterval(() => {}, 1 << 30);
  process.on("SIGINT", () => viewer.close().then(() => process.exit(0)));
}
if (argv.includes("--open")) openBrowser(viewer.url);
