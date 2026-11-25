import { spawn } from "node:child_process";
import { watch, promises as fs, type FSWatcher } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { indexedToPNG } from "../core/bitmap.ts";
import { buildExport, EXPORT_FORMATS, findGodotResDir, writeExport, type ExportFormat } from "../core/export.ts";
import { EXT, META_DIR, validateName, type Workspace } from "../core/store.ts";
import { renderTilemap, SAMPLE_MAP } from "../core/tileset.ts";
import { VERSION } from "../core/version.ts";

const WEB_DIR = fileURLToPath(new URL("../../web/", import.meta.url));
const STATIC: Record<string, [string, string]> = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
  "/favicon.svg": ["favicon.svg", "image/svg+xml"],
};

export interface ViewerHandle {
  url: string;
  reused: boolean;
  close(): Promise<void>;
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function sendJSON(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1_000_000) throw new HttpError(413, "Body too large");
    chunks.push(c as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => path.resolve(p).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}

async function probe(port: number): Promise<{ app?: string; workspace?: string } | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/info`, { signal: AbortSignal.timeout(800) });
    return (await r.json()) as { app?: string; workspace?: string };
  } catch (e) {
    // Connection refused = free port. Anything else answering = taken by something else.
    const code = (e as { cause?: { code?: string } }).cause?.code;
    return code === "ECONNREFUSED" ? null : {};
  }
}

function createServer(ws: Workspace, port: number): { server: http.Server; stop: () => void } {
  const clients = new Set<http.ServerResponse>();
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);

  const broadcast = (event: string, data: unknown) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) c.write(msg);
  };

  // File watching: assets → "change", focus.json → "focus". Debounced per key.
  const timers = new Map<string, NodeJS.Timeout>();
  const schedule = (key: string, fn: () => void) => {
    clearTimeout(timers.get(key));
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        fn();
      }, 60),
    );
  };
  let watcher: FSWatcher | null = null;
  try {
    watcher = watch(ws.root, { recursive: true }, (_evt, filename) => {
      if (!filename) return;
      const rel = filename.toString().replace(/\\/g, "/");
      if (rel === `${META_DIR}/focus.json`) {
        schedule("focus", async () => {
          const name = await ws.getFocus();
          if (name) broadcast("focus", { name });
        });
      } else if (rel.endsWith(EXT) && !rel.startsWith(".") && !rel.includes("/.")) {
        const name = rel.slice(0, -EXT.length);
        schedule(`c:${name}`, () => broadcast("change", { name }));
      }
    });
  } catch (e) {
    console.error("[dotquill] file watching unavailable:", e);
  }
  watcher?.unref();
  const heartbeat = setInterval(() => {
    for (const c of clients) c.write(": ping\n\n");
  }, 25000);
  heartbeat.unref();

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    // Only answer requests addressed to this local server (blocks DNS rebinding).
    if (!allowedHosts.has(req.headers.host ?? "")) throw new HttpError(403, "Forbidden host");
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const p = url.pathname;

    if (req.method === "GET") {
      const file = STATIC[p];
      if (file) {
        const data = await fs.readFile(path.join(WEB_DIR, file[0]));
        res.writeHead(200, { "Content-Type": file[1], "Cache-Control": "no-cache" });
        res.end(data);
        return;
      }
      if (p === "/api/info") {
        return sendJSON(res, 200, { app: "dotquill", version: VERSION, workspace: ws.root, exportsDir: ws.exportsDir });
      }
      if (p === "/api/assets") {
        return sendJSON(res, 200, { workspace: ws.root, assets: await ws.list(), focus: await ws.getFocus() });
      }
      if (p === "/api/asset") {
        const raw = await ws.readRaw(validateName(url.searchParams.get("name") ?? ""));
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(raw);
        return;
      }
      if (p === "/api/thumb") {
        const doc = await ws.load(validateName(url.searchParams.get("name") ?? ""));
        const png = indexedToPNG(doc.composite(0), doc.width, doc.height, doc.palette);
        res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-cache" });
        res.end(png);
        return;
      }
      if (p === "/api/tilemap") {
        // A blob tileset painted on the test map, at 1×.
        const doc = await ws.load(validateName(url.searchParams.get("name") ?? ""));
        const f = Number(url.searchParams.get("frame") ?? 0);
        const tm = renderTilemap(doc, SAMPLE_MAP, Number.isInteger(f) && f >= 0 && f < doc.frames.length ? f : 0);
        res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store" });
        res.end(indexedToPNG(tm.pixels, tm.width, tm.height, doc.palette));
        return;
      }
      if (p === "/api/events") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
        res.write(": connected\n\n");
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
      }
    }

    if (req.method === "POST" && p === "/api/export") {
      // Cross-site pages cannot send JSON here without a preflight we never approve.
      const origin = req.headers.origin;
      if (origin && !allowedHosts.has(origin.replace(/^https?:\/\//, ""))) throw new HttpError(403, "Forbidden origin");
      if (!(req.headers["content-type"] ?? "").startsWith("application/json")) throw new HttpError(415, "JSON only");
      const body = (await readBody(req)) as {
        name?: string;
        format?: string;
        scale?: number;
        frame?: number;
        tag?: string;
        mode?: string;
      };
      const name = validateName(body.name ?? "");
      if (!EXPORT_FORMATS.includes(body.format as ExportFormat)) throw new HttpError(400, "Unknown format");
      const doc = await ws.load(name);
      // Saved Godot resources use res:// paths when the workspace lives inside a Godot project.
      const resDir =
        body.mode === "save" && body.format?.startsWith("godot-") ? await findGodotResDir(ws.exportsDir) : null;
      const files = buildExport(doc, name, {
        format: body.format as ExportFormat,
        ...(body.scale ? { scale: Number(body.scale) } : {}),
        ...(Number.isInteger(body.frame) ? { frame: body.frame } : {}),
        ...(body.tag ? { tag: body.tag } : {}),
        ...(resDir ? { resDir } : {}),
      });
      if (body.mode === "save") {
        const paths = await writeExport(files, ws.exportsDir);
        return sendJSON(res, 200, { paths: paths.map((x) => path.relative(ws.root, x).replace(/\\/g, "/")) });
      }
      return sendJSON(res, 200, {
        files: files.map((f) => ({ name: f.path.split("/").pop(), mime: f.mime, base64: f.data.toString("base64") })),
      });
    }

    throw new HttpError(404, "Not found");
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      const status = e instanceof HttpError ? e.status : 400;
      if (!res.headersSent) sendJSON(res, status, { error: e instanceof Error ? e.message : String(e) });
      else res.end();
    });
  });

  return {
    server,
    stop: () => {
      clearInterval(heartbeat);
      watcher?.close();
      for (const c of clients) c.end();
      clients.clear();
    },
  };
}

/**
 * Starts the viewer on 127.0.0.1, trying ports base..base+9. If a viewer for the same
 * workspace is already running (e.g. `npm run viewer` or another Claude session), reuses it.
 */
export async function startViewer(ws: Workspace, opts: { port?: number; tries?: number } = {}): Promise<ViewerHandle> {
  const base = opts.port ?? 7420;
  const tries = opts.tries ?? 10;
  await ws.ensure();
  for (let port = base; port < base + tries; port++) {
    const existing = await probe(port);
    if (existing) {
      if (existing.app === "dotquill" && existing.workspace && samePath(existing.workspace, ws.root)) {
        return { url: `http://127.0.0.1:${port}/`, reused: true, close: async () => {} };
      }
      continue;
    }
    const { server, stop } = createServer(ws, port);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
    } catch (e) {
      stop();
      if ((e as { code?: string }).code === "EADDRINUSE") continue;
      throw e;
    }
    server.unref();
    return {
      url: `http://127.0.0.1:${port}/`,
      reused: false,
      close: () =>
        new Promise<void>((resolve) => {
          stop();
          server.close(() => resolve());
        }),
    };
  }
  throw new Error(`No free port in ${base}..${base + tries - 1}. Set DOTQUILL_PORT.`);
}

export function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", '""', url.replace(/&/g, "^&")]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args as string[], { stdio: "ignore", detached: true, windowsVerbatimArguments: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // Best effort: the URL is returned to the caller anyway.
  }
}
