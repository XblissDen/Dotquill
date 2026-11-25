import { lightness } from "./color.ts";
import type { PixelDoc } from "./doc.ts";
import { indexToChar } from "./grid.ts";

const CAP = 12;

function list(items: string[]): string {
  return items.slice(0, CAP).join(", ") + (items.length > CAP ? `, … (+${items.length - CAP})` : "");
}

/** "all frames", or compact ranges like "f0–3,6". */
function framesLabel(frames: number[], total: number): string {
  if (frames.length === total) return total > 1 ? "all frames" : "";
  const parts: string[] = [];
  for (let i = 0; i < frames.length; i++) {
    let j = i;
    while (j + 1 < frames.length && frames[j + 1] === frames[j] + 1) j++;
    parts.push(j > i ? `${frames[i]}–${frames[j]}` : `${frames[i]}`);
    i = j;
  }
  return `f${parts.join(",")}`;
}

/** Findings keyed by position+color so a pixel repeated in every frame is reported once. */
class Findings {
  private readonly map = new Map<string, { x: number; y: number; v: number; frames: number[] }>();

  add(x: number, y: number, v: number, f: number): void {
    const key = `${x},${y},${v}`;
    const e = this.map.get(key);
    if (e) e.frames.push(f);
    else this.map.set(key, { x, y, v, frames: [f] });
  }

  get size(): number {
    return this.map.size;
  }

  describe(total: number, withColor: boolean): string[] {
    return [...this.map.values()].map((e) => {
      const label = framesLabel(e.frames, total);
      return `(${e.x},${e.y})${withColor ? `="${indexToChar(e.v)}"` : ""}${label ? ` [${label}]` : ""}`;
    });
  }
}

/** Heuristic quality checks for pixel art. Returns a short plain-text report. */
export function audit(doc: PixelDoc, name: string): string {
  const W = doc.width;
  const H = doc.height;
  const total = doc.frames.length;
  const multi = total > 1;
  const L = doc.palette.map(lightness);
  const used = new Map<number, number>();
  const strays = new Findings();
  const suspects = new Findings();
  const highlights = new Findings();
  const accents = new Findings();
  const edgeFrames: number[] = [];
  const emptyFrames: number[] = [];
  const boxes: { f: number; x0: number; y0: number; x1: number; y1: number }[] = [];

  doc.frames.forEach((_, f) => {
    const c = doc.composite(f);
    let x0 = W;
    let y0 = H;
    let x1 = -1;
    let y1 = -1;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const v = c[y * W + x];
        if (v < 0) continue;
        used.set(v, (used.get(v) ?? 0) + 1);
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
        let opaque = 0;
        let same = 0;
        let minL = Infinity;
        let maxL = -Infinity;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            const nv = c[ny * W + nx];
            if (nv < 0) continue;
            opaque++;
            if (nv === v) same++;
            minL = Math.min(minL, L[nv]);
            maxL = Math.max(maxL, L[nv]);
          }
        }
        if (opaque === 0) strays.add(x, y, v, f);
        else if (same === 0 && opaque >= 3) {
          // Lighter or darker than everything around = a deliberate highlight/accent (eyes, specular, glints).
          if (L[v] > maxL) highlights.add(x, y, v, f);
          else if (L[v] < minL) accents.add(x, y, v, f);
          else suspects.add(x, y, v, f);
        }
      }
    }
    if (x1 < 0) emptyFrames.push(f);
    else {
      boxes.push({ f, x0, y0, x1, y1 });
      if (x0 === 0 || y0 === 0 || x1 === W - 1 || y1 === H - 1) edgeFrames.push(f);
    }
  });

  const warn: string[] = [];
  const info: string[] = [];
  if (emptyFrames.length) warn.push(`Empty frame(s): ${emptyFrames.join(", ")}.`);
  if (strays.size) warn.push(`Stray pixels with no neighbors (usually noise): ${strays.size}: ${list(strays.describe(total, false))}.`);
  if (suspects.size) {
    info.push(
      `Lone mid-tone pixels (differ from all 8 neighbors but are neither lighter nor darker than all of them; often noise): ` +
        `${suspects.size}: ${list(suspects.describe(total, true))}.`,
    );
  }
  if (highlights.size || accents.size) {
    info.push(
      `${highlights.size} lone highlight(s) and ${accents.size} dark accent(s) (lighter/darker than every neighbor): ` +
        `normal for eyes, specular dots and glints, not listed.`,
    );
  }
  if (edgeFrames.length) {
    warn.push(
      `Art touches the canvas edge in ${multi ? `frame(s) ${framesLabel(edgeFrames, total) || "all"}` : "the frame"}: ` +
        `no room for an outline or motion; may look cropped (ignore for seamless tiles).`,
    );
  }
  if (multi && boxes.length > 1) {
    const groups = new Map<string, number[]>();
    for (const b of boxes) {
      const key = `${b.x1 - b.x0 + 1}×${b.y1 - b.y0 + 1}@(${b.x0},${b.y0})`;
      groups.set(key, [...(groups.get(key) ?? []), b.f]);
    }
    info.push(
      groups.size === 1
        ? `Bounding box is the same in every frame: ${[...groups.keys()][0]}.`
        : `Bounding boxes: ${[...groups].map(([k, fs]) => `${framesLabel(fs, total)} ${k}`).join("; ")}.`,
    );
    const bottoms = boxes.map((b) => b.y1);
    if (Math.max(...bottoms) !== Math.min(...bottoms)) {
      info.push(`Bottom edge moves between frames (y ${Math.min(...bottoms)}..${Math.max(...bottoms)}): intended (jump/bob) or jitter?`);
    }
    const ws = boxes.map((b) => b.x1 - b.x0 + 1);
    const hs = boxes.map((b) => b.y1 - b.y0 + 1);
    if (Math.max(...ws) - Math.min(...ws) > 2 || Math.max(...hs) - Math.min(...hs) > 2) {
      info.push("Size changes by more than 2 px between frames: check that volume stays consistent.");
    }
  }
  const unused = doc.palette.length - used.size;
  if (used.size > 24 && W * H <= 32 * 32) info.push(`${used.size} colors on a ${W}×${H} canvas is a lot; fewer, stronger ramps usually read better.`);
  const hidden = doc.layers.filter((l) => !l.visible).map((l) => l.name);
  if (hidden.length) info.push(`Hidden layers not checked: ${hidden.join(", ")}.`);

  const usage = [...used.entries()].sort((a, b) => b[1] - a[1]).map(([i, n]) => `${indexToChar(i)}×${n}`);
  const lines = [
    `Audit of "${name}" (${W}×${H}, ${total} frame${multi ? "s" : ""}):`,
    `Colors used: ${used.size} of ${doc.palette.length} (${unused} unused): ${usage.join(" ")}`,
    ...warn.map((w) => `⚠ ${w}`),
    ...info.map((i) => `• ${i}`),
  ];
  if (!warn.length) lines.push("No problems found by the automatic checks; still compare render_preview against the intent.");
  return lines.join("\n");
}
