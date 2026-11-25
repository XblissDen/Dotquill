import { deflateSync } from "node:zlib";
import { parseHex } from "./color.ts";
import type { PixelDoc } from "./doc.ts";

/**
 * Writes an Aseprite file (.aseprite), following docs/ase-file-specs.md of the Aseprite repo:
 * indexed color with palette entry 0 as the transparent color (our index i becomes i + 1),
 * one layer chunk per layer (bottom → top), cels cropped to their pixels and zlib-compressed,
 * tags and slices (9-slice centers) in the first frame.
 */

const HEADER_MAGIC = 0xa5e0;
const FRAME_MAGIC = 0xf1fa;
const CHUNK_OLD_PALETTE = 0x0004;
const CHUNK_LAYER = 0x2004;
const CHUNK_CEL = 0x2005;
const CHUNK_COLOR_PROFILE = 0x2007;
const CHUNK_TAGS = 0x2018;
const CHUNK_PALETTE = 0x2019;
const CHUNK_SLICE = 0x2022;

/** Little-endian byte writer. */
class Bytes {
  private parts: Buffer[] = [];

  private push(size: number, write: (b: Buffer) => void): this {
    const b = Buffer.alloc(size);
    write(b);
    this.parts.push(b);
    return this;
  }
  byte(n: number): this {
    return this.push(1, (b) => b.writeUInt8(n));
  }
  word(n: number): this {
    return this.push(2, (b) => b.writeUInt16LE(n));
  }
  short(n: number): this {
    return this.push(2, (b) => b.writeInt16LE(n));
  }
  dword(n: number): this {
    return this.push(4, (b) => b.writeUInt32LE(n));
  }
  long(n: number): this {
    return this.push(4, (b) => b.writeInt32LE(n));
  }
  zeros(n: number): this {
    return this.push(n, () => {});
  }
  string(s: string): this {
    const b = Buffer.from(s, "utf8");
    this.word(b.length);
    this.parts.push(b);
    return this;
  }
  raw(b: Buffer): this {
    this.parts.push(b);
    return this;
  }
  done(): Buffer {
    return Buffer.concat(this.parts);
  }
}

function chunk(type: number, body: Buffer): Buffer {
  return new Bytes().dword(6 + body.length).word(type).raw(body).done();
}

const TAG_DIRECTION = { forward: 0, reverse: 1, pingpong: 2 } as const;

export function toAseprite(doc: PixelDoc): Buffer {
  const W = doc.width;
  const H = doc.height;
  const colors = doc.palette.length + 1; // entry 0 = transparent
  const rgb = doc.palette.map(parseHex);

  // First-frame chunks: color profile, palettes, layers, tags, slices.
  const head: Buffer[] = [];
  head.push(chunk(CHUNK_COLOR_PROFILE, new Bytes().word(1).word(0).dword(0).zeros(8).done()));
  const old = new Bytes().word(1).byte(0).byte(colors === 256 ? 0 : colors).byte(0).byte(0).byte(0);
  for (const [r, g, b] of rgb) old.byte(r).byte(g).byte(b);
  head.push(chunk(CHUNK_OLD_PALETTE, old.done()));
  const pal = new Bytes().dword(colors).dword(0).dword(colors - 1).zeros(8);
  pal.word(0).byte(0).byte(0).byte(0).byte(0);
  for (const [r, g, b] of rgb) pal.word(0).byte(r).byte(g).byte(b).byte(255);
  head.push(chunk(CHUNK_PALETTE, pal.done()));
  for (const l of doc.layers) {
    const flags = (l.visible ? 1 : 0) | 2;
    head.push(chunk(CHUNK_LAYER, new Bytes().word(flags).word(0).word(0).word(0).word(0).word(0).byte(255).zeros(3).string(l.name).done()));
  }
  if (doc.tags.length) {
    const t = new Bytes().word(doc.tags.length).zeros(8);
    for (const tag of doc.tags) {
      t.word(tag.from).word(tag.to).byte(TAG_DIRECTION[tag.direction]).word(0).zeros(6).byte(0).byte(0).byte(0).byte(0).string(tag.name);
    }
    head.push(chunk(CHUNK_TAGS, t.done()));
  }
  for (const s of doc.slices) {
    const b = new Bytes().dword(1).dword(s.center ? 1 : 0).dword(0).string(s.name);
    b.dword(0).long(s.bounds.x).long(s.bounds.y).dword(s.bounds.w).dword(s.bounds.h);
    if (s.center) b.long(s.center.x).long(s.center.y).dword(s.center.w).dword(s.center.h);
    head.push(chunk(CHUNK_SLICE, b.done()));
  }

  const frames = doc.frames.map((f, fi) => {
    const chunks = fi === 0 ? [...head] : [];
    doc.layers.forEach((l, li) => {
      const cel = f.cels.get(l.name);
      if (!cel) return;
      let x0 = W;
      let y0 = H;
      let x1 = -1;
      let y1 = -1;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          if (cel[y * W + x] < 0) continue;
          x0 = Math.min(x0, x);
          y0 = Math.min(y0, y);
          x1 = Math.max(x1, x);
          y1 = Math.max(y1, y);
        }
      }
      if (x1 < 0) return;
      const cw = x1 - x0 + 1;
      const ch = y1 - y0 + 1;
      const px = Buffer.alloc(cw * ch);
      for (let y = 0; y < ch; y++) {
        for (let x = 0; x < cw; x++) px[y * cw + x] = cel[(y0 + y) * W + x0 + x] + 1;
      }
      const body = new Bytes().word(li).short(x0).short(y0).byte(255).word(2).short(0).zeros(5).word(cw).word(ch).raw(deflateSync(px));
      chunks.push(chunk(CHUNK_CEL, body.done()));
    });
    const size = 16 + chunks.reduce((n, c) => n + c.length, 0);
    const header = new Bytes()
      .dword(size)
      .word(FRAME_MAGIC)
      .word(Math.min(chunks.length, 0xffff))
      .word(f.duration)
      .zeros(2)
      .dword(chunks.length)
      .done();
    return Buffer.concat([header, ...chunks]);
  });

  const grid = doc.tileset?.tile ?? 0;
  const body = Buffer.concat(frames);
  const header = new Bytes()
    .dword(128 + body.length)
    .word(HEADER_MAGIC)
    .word(doc.frames.length)
    .word(W)
    .word(H)
    .word(8)
    .dword(1)
    .word(doc.frames[0].duration)
    .dword(0)
    .dword(0)
    .byte(0)
    .zeros(3)
    .word(colors)
    .byte(1)
    .byte(1)
    .short(0)
    .short(0)
    .word(grid)
    .word(grid)
    .zeros(84)
    .done();
  return Buffer.concat([header, body]);
}
