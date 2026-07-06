// src/lib/enemy-lineup.ts
// Builds one transparent PNG containing multiple enemy sprites side-by-side.
// Discord supports one embed thumbnail, so multi-virus art must be composited into one attachment.

import { AttachmentBuilder } from 'discord.js';
import { inflateSync, deflateSync } from 'node:zlib';
import { getVirusArt } from './data';

type EnemyLineupInput = { id: string };
type RgbaImage = { width: number; height: number; data: Uint8Array };

type LineupAttachment = {
  thumbnailUrl: string;
  files: AttachmentBuilder[];
};

const MAX_ENEMIES = 3;
const TARGET_HEIGHT = Math.max(24, Math.min(96, Number(process.env.ENEMY_LINEUP_HEIGHT ?? 56) || 56));
const GAP = Math.max(0, Math.min(32, Number(process.env.ENEMY_LINEUP_GAP ?? 8) || 8));
const CACHE_LIMIT = 80;
const compositeCache = new Map<string, Buffer>();

export async function buildEnemyLineupAttachment(
  enemies: EnemyLineupInput[] | undefined,
  battleId: string,
): Promise<LineupAttachment | null> {
  const ids = (enemies || []).map(e => String(e?.id || '').trim()).filter(Boolean).slice(0, MAX_ENEMIES);
  if (ids.length <= 1) return null;

  const urls = ids
    .map(id => {
      const art = getVirusArt(id) as any;
      return String(art?.image || art?.sprite || '').trim();
    })
    .filter(Boolean);

  if (urls.length <= 1) return null;

  const cacheKey = `${TARGET_HEIGHT}|${GAP}|${urls.join('|')}`;
  let png = compositeCache.get(cacheKey);
  if (!png) {
    const images: RgbaImage[] = [];
    for (const url of urls) {
      const img = await fetchDecodeImage(url).catch(() => null);
      if (img) images.push(scaleToHeight(trimTransparent(img), TARGET_HEIGHT));
    }
    if (images.length <= 1) return null;
    png = encodePng(compositeImages(images, GAP));
    compositeCache.set(cacheKey, png);
    while (compositeCache.size > CACHE_LIMIT) {
      const first = compositeCache.keys().next().value;
      if (!first) break;
      compositeCache.delete(first);
    }
  }

  const safeId = String(battleId || Date.now()).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'battle';
  const filename = `enemy-lineup-${safeId}.png`;
  return {
    thumbnailUrl: `attachment://${filename}`,
    files: [new AttachmentBuilder(png, { name: filename })],
  };
}

async function fetchDecodeImage(url: string): Promise<RgbaImage | null> {
  const res = await fetch(url, {
    headers: {
      'user-agent': 'NetBattlersBot/1.0',
      'accept': 'image/png,image/*;q=0.8,*/*;q=0.5',
    } as any,
  } as any);
  if (!res.ok) return null;
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (isPng(bytes)) return decodePng(bytes);
  // GIF/JPG composition requires a decoder dependency. Skip unsupported formats rather than breaking combat.
  return null;
}

function isPng(bytes: Uint8Array): boolean {
  return bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
}

function decodePng(bytes: Uint8Array): RgbaImage | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < sig.length; i++) if (bytes[i] !== sig[i]) return null;

  let off = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  let palette: Uint8Array | null = null;
  let transparency: Uint8Array | null = null;
  const idat: Uint8Array[] = [];

  while (off + 12 <= bytes.length) {
    const len = readU32(bytes, off); off += 4;
    const type = ascii(bytes, off, 4); off += 4;
    const data = bytes.subarray(off, off + len); off += len;
    off += 4; // crc

    if (type === 'IHDR') {
      width = readU32(data, 0);
      height = readU32(data, 4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') {
      palette = new Uint8Array(data);
    } else if (type === 'tRNS') {
      transparency = new Uint8Array(data);
    } else if (type === 'IDAT') {
      idat.push(new Uint8Array(data));
    } else if (type === 'IEND') {
      break;
    }
  }

  if (!width || !height || bitDepth !== 8 || interlace !== 0 || !idat.length) return null;

  const channels = channelsForColorType(colorType);
  if (!channels) return null;
  if (colorType === 3 && !palette) return null;

  const compressed = concat(idat);
  const raw = new Uint8Array(inflateSync(compressed));
  const bpp = channels;
  const stride = width * channels;
  const recon = new Uint8Array(height * stride);

  let src = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[src++];
    const rowStart = y * stride;
    for (let x = 0; x < stride; x++) {
      const val = raw[src++];
      const left = x >= bpp ? recon[rowStart + x - bpp] : 0;
      const up = y > 0 ? recon[rowStart - stride + x] : 0;
      const upLeft = y > 0 && x >= bpp ? recon[rowStart - stride + x - bpp] : 0;
      let out = val;
      if (filter === 1) out = (val + left) & 255;
      else if (filter === 2) out = (val + up) & 255;
      else if (filter === 3) out = (val + Math.floor((left + up) / 2)) & 255;
      else if (filter === 4) out = (val + paeth(left, up, upLeft)) & 255;
      else if (filter !== 0) return null;
      recon[rowStart + x] = out;
    }
  }

  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0, p = 0, o = 0; i < width * height; i++, o += 4) {
    if (colorType === 6) {
      rgba[o] = recon[p++]; rgba[o + 1] = recon[p++]; rgba[o + 2] = recon[p++]; rgba[o + 3] = recon[p++];
    } else if (colorType === 2) {
      const r = recon[p++], g = recon[p++], b = recon[p++];
      rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = rgbAlphaFromTrns(r, g, b, transparency);
    } else if (colorType === 3) {
      const idx = recon[p++];
      const pi = idx * 3;
      rgba[o] = palette![pi] ?? 0;
      rgba[o + 1] = palette![pi + 1] ?? 0;
      rgba[o + 2] = palette![pi + 2] ?? 0;
      rgba[o + 3] = transparency && idx < transparency.length ? transparency[idx] : 255;
    } else if (colorType === 4) {
      const g = recon[p++], a = recon[p++];
      rgba[o] = g; rgba[o + 1] = g; rgba[o + 2] = g; rgba[o + 3] = a;
    } else if (colorType === 0) {
      const g = recon[p++];
      rgba[o] = g; rgba[o + 1] = g; rgba[o + 2] = g; rgba[o + 3] = grayAlphaFromTrns(g, transparency);
    }
  }

  return { width, height, data: rgba };
}

function channelsForColorType(colorType: number): number {
  if (colorType === 0) return 1;
  if (colorType === 2) return 3;
  if (colorType === 3) return 1;
  if (colorType === 4) return 2;
  if (colorType === 6) return 4;
  return 0;
}

function rgbAlphaFromTrns(r: number, g: number, b: number, trns: Uint8Array | null): number {
  if (!trns || trns.length < 6) return 255;
  const rr = readU16(trns, 0), gg = readU16(trns, 2), bb = readU16(trns, 4);
  return r === rr && g === gg && b === bb ? 0 : 255;
}

function grayAlphaFromTrns(g: number, trns: Uint8Array | null): number {
  if (!trns || trns.length < 2) return 255;
  return g === readU16(trns, 0) ? 0 : 255;
}

function trimTransparent(img: RgbaImage): RgbaImage {
  let minX = img.width, minY = img.height, maxX = -1, maxY = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.data[(y * img.width + x) * 4 + 3] > 0) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < minX || maxY < minY) return img;
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const srcStart = ((minY + y) * img.width + minX) * 4;
    const dstStart = y * w * 4;
    out.set(img.data.subarray(srcStart, srcStart + w * 4), dstStart);
  }
  return { width: w, height: h, data: out };
}

function scaleToHeight(img: RgbaImage, targetHeight: number): RgbaImage {
  const h = Math.max(1, Math.floor(targetHeight));
  const scale = h / Math.max(1, img.height);
  const w = Math.max(1, Math.round(img.width * scale));
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(img.height - 1, Math.floor(y / scale));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.width - 1, Math.floor(x / scale));
      const si = (sy * img.width + sx) * 4;
      const di = (y * w + x) * 4;
      out[di] = img.data[si];
      out[di + 1] = img.data[si + 1];
      out[di + 2] = img.data[si + 2];
      out[di + 3] = img.data[si + 3];
    }
  }
  return { width: w, height: h, data: out };
}

function compositeImages(images: RgbaImage[], gap: number): RgbaImage {
  const width = images.reduce((sum, img) => sum + img.width, 0) + gap * Math.max(0, images.length - 1);
  const height = Math.max(...images.map(img => img.height));
  const out = new Uint8Array(width * height * 4);
  let dx = 0;
  for (const img of images) {
    const dy = Math.floor((height - img.height) / 2);
    blitAlpha(out, width, height, img, dx, dy);
    dx += img.width + gap;
  }
  return { width, height, data: out };
}

function blitAlpha(dst: Uint8Array, dstW: number, dstH: number, src: RgbaImage, dx: number, dy: number) {
  for (let y = 0; y < src.height; y++) {
    const ty = dy + y;
    if (ty < 0 || ty >= dstH) continue;
    for (let x = 0; x < src.width; x++) {
      const tx = dx + x;
      if (tx < 0 || tx >= dstW) continue;
      const si = (y * src.width + x) * 4;
      const di = (ty * dstW + tx) * 4;
      const a = src.data[si + 3] / 255;
      if (a <= 0) continue;
      const inv = 1 - a;
      dst[di] = Math.round(src.data[si] * a + dst[di] * inv);
      dst[di + 1] = Math.round(src.data[si + 1] * a + dst[di + 1] * inv);
      dst[di + 2] = Math.round(src.data[si + 2] * a + dst[di + 2] * inv);
      dst[di + 3] = Math.min(255, Math.round(src.data[si + 3] + dst[di + 3] * inv));
    }
  }
}

function encodePng(img: RgbaImage): Buffer {
  const stride = img.width * 4;
  const raw = new Uint8Array((stride + 1) * img.height);
  for (let y = 0; y < img.height; y++) {
    const dst = y * (stride + 1);
    raw[dst] = 0; // no filter
    raw.set(img.data.subarray(y * stride, y * stride + stride), dst + 1);
  }

  const ihdr = Buffer.alloc(13);
  writeU32(ihdr, 0, img.width);
  writeU32(ihdr, 4, img.height);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type: string, data: Buffer | Uint8Array): Buffer {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const out = Buffer.alloc(8 + body.length + 4);
  writeU32(out, 0, body.length);
  out.write(type, 4, 4, 'ascii');
  body.copy(out, 8);
  writeU32(out, 8 + body.length, crc32(out.subarray(4, 8 + body.length)) >>> 0);
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

function ascii(bytes: Uint8Array, off: number, len: number): string {
  return String.fromCharCode(...bytes.subarray(off, off + len));
}

function readU32(bytes: Uint8Array, off: number): number {
  return ((bytes[off] << 24) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3]) >>> 0;
}

function readU16(bytes: Uint8Array, off: number): number {
  return ((bytes[off] << 8) | bytes[off + 1]) >>> 0;
}

function writeU32(buf: Buffer | Uint8Array, off: number, value: number) {
  buf[off] = (value >>> 24) & 255;
  buf[off + 1] = (value >>> 16) & 255;
  buf[off + 2] = (value >>> 8) & 255;
  buf[off + 3] = value & 255;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
