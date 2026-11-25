import type { PixelDoc } from "./doc.ts";
import { indexToChar } from "./grid.ts";

const CAP = 12;

function list(items: string[]): string {
  return items.slice(0, CAP).join(", ") + (items.length > CAP ? `, … (+${items.length - CAP})` : "");
}

/** Heuristic quality checks for pixel art. Returns a short plain-text report. */
export function audit(doc: PixelDoc, name: string): string {
  const W = doc.width;
  const H = doc.height;
  const multi = doc.frames.length > 1;
  const at = (f: number, x: number, y: number) => (multi ? `f${f}(${x},${y})` : `(${x},${y})`);
  const used = new Map<number, number>();
  const strays: string[] = [];
  const lonely: string[] = [];
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
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            const nv = c[ny * W + nx];
            if (nv >= 0) opaque++;
            if (nv === v) same++;
          }
        }
        if (opaque === 0) strays.push(at(f, x, y));
        else if (same === 0 && opaque >= 3) lonely.push(`${at(f, x, y)}="${indexToChar(v)}"`);
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
  if (strays.length) warn.push(`Stray pixels with no neighbors (usually noise): ${strays.length}: ${list(strays)}.`);
  if (lonely.length) {
    info.push(
      `Single pixels whose color differs from all 8 neighbors: ${lonely.length}: ${list(lonely)}. ` +
        `Fine for eyes/highlights; otherwise merge them into clusters.`,
    );
  }
  if (edgeFrames.length) {
    warn.push(
      `Art touches the canvas edge in ${multi ? `frame(s) ${edgeFrames.join(", ")}` : "the frame"}: ` +
        `no room for an outline or motion; may look cropped (ignore for seamless tiles).`,
    );
  }
  if (multi && boxes.length > 1) {
    const ws = boxes.map((b) => b.x1 - b.x0 + 1);
    const hs = boxes.map((b) => b.y1 - b.y0 + 1);
    const bottoms = boxes.map((b) => b.y1);
    info.push(
      `Bounding boxes per frame: ${boxes.map((b) => `f${b.f} ${b.x1 - b.x0 + 1}×${b.y1 - b.y0 + 1}@(${b.x0},${b.y0})`).join(", ")}.`,
    );
    if (Math.max(...bottoms) !== Math.min(...bottoms)) {
      info.push(`Bottom edge moves between frames (y ${Math.min(...bottoms)}..${Math.max(...bottoms)}): intended (jump/bob) or jitter?`);
    }
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
    `Audit of "${name}" (${W}×${H}, ${doc.frames.length} frame${multi ? "s" : ""}):`,
    `Colors used: ${used.size} of ${doc.palette.length} (${unused} unused): ${usage.join(" ")}`,
    ...warn.map((w) => `⚠ ${w}`),
    ...info.map((i) => `• ${i}`),
  ];
  if (!warn.length) lines.push("No problems found by the automatic checks; still compare render_preview against the intent.");
  return lines.join("\n");
}
