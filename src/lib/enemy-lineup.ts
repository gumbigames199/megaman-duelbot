// src/lib/enemy-lineup.ts
import { AttachmentBuilder } from 'discord.js';
import sharp from 'sharp';
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

import { getVirusArt } from './data';

export type EnemyLineupRef = {
  virus_id?: string;
  id?: string;
};

export type EnemyLineupAsset = {
  attachment: AttachmentBuilder;
  thumbnailUrl: string;
};

const TILE_SIZE = Math.max(48, Math.min(160, Number(process.env.ENEMY_LINEUP_TILE_SIZE ?? 96) || 96));
const TILE_GAP = Math.max(0, Math.min(32, Number(process.env.ENEMY_LINEUP_TILE_GAP ?? 8) || 8));
const DOWNLOAD_LIMIT_BYTES = Math.max(250_000, Math.min(8_000_000, Number(process.env.ENEMY_LINEUP_MAX_BYTES ?? 3_000_000) || 3_000_000));

export async function buildEnemyLineupAttachment(
  enemies: EnemyLineupRef[],
  battleId: string,
): Promise<EnemyLineupAsset | null> {
  const ids = (enemies || [])
    .map(e => String(e?.virus_id ?? e?.id ?? '').trim())
    .filter(Boolean)
    .slice(0, 3);

  if (!ids.length) return null;

  const tiles: Buffer[] = [];
  for (const id of ids) {
    const url = virusImageUrl(id);
    if (!url) continue;

    const raw = await fetchImageBuffer(url);
    if (!raw) continue;

    const tile = await sharp(raw, { animated: false })
      .resize(TILE_SIZE, TILE_SIZE, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toBuffer();

    tiles.push(tile);
  }

  if (!tiles.length) return null;

  const width = tiles.length * TILE_SIZE + Math.max(0, tiles.length - 1) * TILE_GAP;
  const height = TILE_SIZE;
  const overlays: sharp.OverlayOptions[] = tiles.map((input, i) => ({
    input,
    left: i * (TILE_SIZE + TILE_GAP),
    top: 0,
  }));

  const png = await sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(overlays)
    .png()
    .toBuffer();

  const safeBattleId = String(battleId || Date.now()).replace(/[^a-zA-Z0-9_-]/g, '');
  const filename = `enemy-lineup-${safeBattleId}-${Date.now()}.png`;

  return {
    attachment: new AttachmentBuilder(png, { name: filename }),
    thumbnailUrl: `attachment://${filename}`,
  };
}

function virusImageUrl(virusId: string): string | null {
  const art = getVirusArt(virusId) as any;
  const raw = art?.image || art?.sprite || null;
  const url = String(raw ?? '').trim();
  return url || null;
}

async function fetchImageBuffer(urlText: string, redirects = 0): Promise<Buffer | null> {
  try {
    const url = new URL(urlText);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    const client = url.protocol === 'https:' ? https : http;

    return await new Promise<Buffer | null>((resolve) => {
      const req = client.get(url, {
        headers: {
          'User-Agent': 'NetBattlersBot/1.0',
          'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        },
      }, (res) => {
        const status = Number(res.statusCode || 0);
        const location = String(res.headers.location || '').trim();
        if ([301, 302, 303, 307, 308].includes(status) && location && redirects < 4) {
          res.resume();
          const next = new URL(location, url).toString();
          fetchImageBuffer(next, redirects + 1).then(resolve).catch(() => resolve(null));
          return;
        }

        if (status < 200 || status >= 300) {
          res.resume();
          resolve(null);
          return;
        }

        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > DOWNLOAD_LIMIT_BYTES) {
            req.destroy();
            resolve(null);
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => resolve(Buffer.concat(chunks)));
      });

      req.setTimeout(8000, () => {
        req.destroy();
        resolve(null);
      });
      req.on('error', () => resolve(null));
    });
  } catch {
    return null;
  }
}
