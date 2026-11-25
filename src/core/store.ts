import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { PixelDoc } from "./doc.ts";

export const EXT = ".pixel.json";
export const META_DIR = ".dotquill";
export const EXPORTS_DIR = "exports";
/** Workspace folder name when none is given. */
export const DEFAULT_DIR = "dotquill-art";
/** The older default; an existing Dotquill workspace there is still used. */
export const LEGACY_DIR = "pixel-art";

/** <cwd>/dotquill-art, or <cwd>/pixel-art when that is an existing Dotquill workspace and dotquill-art is not there yet. */
export function defaultWorkspaceDir(cwd: string): string {
  const dir = path.join(cwd, DEFAULT_DIR);
  const legacy = path.join(cwd, LEGACY_DIR);
  return !existsSync(dir) && existsSync(path.join(legacy, META_DIR)) ? legacy : dir;
}
const NAME_RE = /^[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_-]*)*$/i;
const HISTORY_LIMIT = 50;

export function validateName(name: string): string {
  const n = String(name)
    .trim()
    .replace(/\\/g, "/")
    .replace(/\.pixel\.json$/i, "");
  if (n.length === 0 || n.length > 120 || !NAME_RE.test(n)) {
    throw new Error(
      `Invalid asset name "${name}". Use letters, digits, "-" and "_", optionally in folders like "characters/hero".`,
    );
  }
  return n;
}

export interface AssetSummary {
  name: string;
  width?: number;
  height?: number;
  frames?: number;
  layers?: number;
  colors?: number;
  paletteName?: string;
  updated?: string;
  error?: string;
}

function isCode(e: unknown, ...codes: string[]): boolean {
  return typeof e === "object" && e !== null && codes.includes((e as { code?: string }).code ?? "");
}

async function retry<T>(fn: () => Promise<T>): Promise<T> {
  // Windows may briefly lock a file that a viewer is reading.
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= 8 || !isCode(e, "EPERM", "EBUSY", "EACCES")) throw e;
      await new Promise((r) => setTimeout(r, 25 * (attempt + 1)));
    }
  }
}

async function atomicWrite(file: string, data: string | Buffer): Promise<void> {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await fs.writeFile(tmp, data);
  try {
    await retry(() => fs.rename(tmp, file));
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
}

/** A folder of `*.pixel.json` assets plus a hidden `.dotquill/` dir for history, trash and viewer focus. */
export class Workspace {
  readonly root: string;
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  get metaDir(): string {
    return path.join(this.root, META_DIR);
  }

  get exportsDir(): string {
    return path.join(this.root, EXPORTS_DIR);
  }

  file(name: string): string {
    return path.join(this.root, ...validateName(name).split("/")) + EXT;
  }

  private historyDir(name: string): string {
    return path.join(this.metaDir, "history", ...validateName(name).split("/"));
  }

  async ensure(): Promise<void> {
    await fs.mkdir(this.metaDir, { recursive: true });
    const gi = path.join(this.metaDir, ".gitignore");
    try {
      await fs.writeFile(gi, "*\n", { flag: "wx" });
    } catch (e) {
      if (!isCode(e, "EEXIST")) throw e;
    }
  }

  /** Serializes async work per asset so parallel tool calls cannot clobber each other. */
  async withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const key = validateName(name).toLowerCase();
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.locks.set(key, tail);
    try {
      return await next;
    } finally {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }

  async exists(name: string): Promise<boolean> {
    try {
      await fs.access(this.file(name));
      return true;
    } catch {
      return false;
    }
  }

  async readRaw(name: string): Promise<string> {
    try {
      return await retry(() => fs.readFile(this.file(name), "utf8"));
    } catch (e) {
      if (isCode(e, "ENOENT")) throw new Error(`Asset "${validateName(name)}" not found. Use list_assets to see what exists.`);
      throw e;
    }
  }

  async load(name: string): Promise<PixelDoc> {
    const raw = await this.readRaw(name);
    try {
      return PixelDoc.fromJSON(JSON.parse(raw));
    } catch (e) {
      throw new Error(`Asset "${validateName(name)}" is not readable: ${(e as Error).message}`);
    }
  }

  async save(name: string, doc: PixelDoc, opts: { history?: boolean } = {}): Promise<void> {
    await this.ensure();
    const file = this.file(name);
    if (opts.history !== false) {
      try {
        await this.pushHistory(name, await fs.readFile(file));
      } catch (e) {
        if (!isCode(e, "ENOENT")) throw e;
      }
    }
    doc.touch();
    await fs.mkdir(path.dirname(file), { recursive: true });
    await atomicWrite(file, JSON.stringify(doc.toJSON(), null, 2) + "\n");
  }

  private async pushHistory(name: string, content: Buffer): Promise<void> {
    const dir = this.historyDir(name);
    await fs.mkdir(dir, { recursive: true });
    const stamp = `${Date.now()}-${process.hrtime.bigint().toString().slice(-6)}`;
    await fs.writeFile(path.join(dir, `${stamp}${EXT}`), content);
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith(EXT)).sort();
    for (const f of files.slice(0, Math.max(0, files.length - HISTORY_LIMIT))) await fs.rm(path.join(dir, f), { force: true });
  }

  /** Restores the previous saved version. Returns false when there is no history. */
  async undo(name: string): Promise<boolean> {
    const dir = this.historyDir(name);
    let files: string[];
    try {
      files = (await fs.readdir(dir)).filter((f) => f.endsWith(EXT)).sort();
    } catch {
      return false;
    }
    const last = files.at(-1);
    if (!last) return false;
    const snap = path.join(dir, last);
    const content = await fs.readFile(snap);
    PixelDoc.fromJSON(JSON.parse(content.toString("utf8")));
    await fs.mkdir(path.dirname(this.file(name)), { recursive: true });
    await atomicWrite(this.file(name), content);
    await fs.rm(snap, { force: true });
    return true;
  }

  async historyCount(name: string): Promise<number> {
    try {
      return (await fs.readdir(this.historyDir(name))).filter((f) => f.endsWith(EXT)).length;
    } catch {
      return 0;
    }
  }

  /** Moves the asset into `.dotquill/trash` (recoverable by hand). */
  async remove(name: string): Promise<string> {
    const n = validateName(name);
    await this.ensure();
    const trash = path.join(this.metaDir, "trash");
    await fs.mkdir(trash, { recursive: true });
    const dest = path.join(trash, `${n.replace(/\//g, "__")}.${Date.now()}${EXT}`);
    await retry(() => fs.rename(this.file(n), dest));
    // A later asset with the same name must not "undo" into this one.
    await fs.rm(this.historyDir(n), { recursive: true, force: true });
    await this.pruneEmptyDirs(path.dirname(this.file(n)));
    return dest;
  }

  private async pruneEmptyDirs(dir: string): Promise<void> {
    while (dir.startsWith(this.root + path.sep)) {
      try {
        await fs.rmdir(dir);
      } catch {
        return;
      }
      dir = path.dirname(dir);
    }
  }

  async rename(from: string, to: string): Promise<void> {
    if (await this.exists(to)) throw new Error(`Asset "${validateName(to)}" already exists.`);
    await fs.mkdir(path.dirname(this.file(to)), { recursive: true });
    await retry(() => fs.rename(this.file(from), this.file(to)));
    await this.pruneEmptyDirs(path.dirname(this.file(from)));
    try {
      await fs.mkdir(path.dirname(this.historyDir(to)), { recursive: true });
      await fs.rename(this.historyDir(from), this.historyDir(to));
    } catch {
      // No history to move.
    }
  }

  async setFocus(name: string): Promise<void> {
    await this.ensure();
    await atomicWrite(
      path.join(this.metaDir, "focus.json"),
      JSON.stringify({ name: validateName(name), at: new Date().toISOString() }),
    );
  }

  async getFocus(): Promise<string | null> {
    try {
      const j = JSON.parse(await fs.readFile(path.join(this.metaDir, "focus.json"), "utf8")) as { name?: string };
      return typeof j.name === "string" ? j.name : null;
    } catch {
      return null;
    }
  }

  async list(): Promise<AssetSummary[]> {
    const out: AssetSummary[] = [];
    const walk = async (dir: string, prefix: string): Promise<void> => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.isDirectory()) {
          if (e.name.startsWith(".") || e.name === "node_modules" || (!prefix && e.name === EXPORTS_DIR)) continue;
          await walk(path.join(dir, e.name), `${prefix}${e.name}/`);
        } else if (e.isFile() && e.name.endsWith(EXT)) {
          const name = prefix + e.name.slice(0, -EXT.length);
          try {
            validateName(name);
          } catch {
            continue;
          }
          try {
            const j = JSON.parse(await fs.readFile(path.join(dir, e.name), "utf8"));
            out.push({
              name,
              width: j.width,
              height: j.height,
              frames: j.frames?.length,
              layers: j.layers?.length,
              colors: j.palette?.length,
              paletteName: j.paletteName,
              updated: j.updated,
            });
          } catch (err) {
            out.push({ name, error: (err as Error).message });
          }
        }
      }
    };
    await walk(this.root, "");
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }
}
