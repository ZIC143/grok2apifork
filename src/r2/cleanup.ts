import type { Env } from "../env";
import { getSettings } from "../settings";
import { nowMs } from "../utils/time";
import { deleteCacheRows, getCacheBytesByType, listOldestRows, type CacheType } from "../repo/r2Cache";

function parsePositiveInt(v: string | undefined, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  return i > 0 ? i : fallback;
}

function mbToBytes(mb: number): number {
  if (!Number.isFinite(mb)) return 0;
  if (mb <= 0) return 0;
  return Math.floor(mb * 1024 * 1024);
}

async function deleteKeys(env: Env, keys: string[]): Promise<void> {
  if (!keys.length) return;
  await env.R2_CACHE.delete(keys);
  await deleteCacheRows(env.DB, keys);
}

export async function runR2Cleanup(env: Env): Promise<{ deleted: number; freedBytes: number }> {
  const now = nowMs();
  const batch = Math.min(500, parsePositiveInt(env.R2_CLEANUP_BATCH, 200));
  const ttlDays = parsePositiveInt(env.R2_CACHE_TTL_DAYS, 7);

  let deleted = 0;
  let freedBytes = 0;

  // 1) TTL cleanup (oldest first, across types)
  if (ttlDays > 0) {
    const threshold = now - ttlDays * 24 * 60 * 60 * 1000;
    // limit deletions per run
    for (let i = 0; i < 10; i++) {
      const rows = await listOldestRows(env.DB, null, threshold, batch);
      if (!rows.length) break;
      const keys = rows.map((r) => r.key);
      await deleteKeys(env, keys);
      deleted += keys.length;
      freedBytes += rows.reduce((s, r) => s + (r.size || 0), 0);
      if (keys.length < batch) break;
    }
  }

  // 2) Size-based cleanup (per type)
  const settings = await getSettings(env);
  const limits: Array<{ type: CacheType; maxBytes: number }> = [
    { type: "image", maxBytes: mbToBytes(Number(settings.global.image_cache_max_size_mb ?? 0)) },
    { type: "video", maxBytes: mbToBytes(Number(settings.global.video_cache_max_size_mb ?? 0)) },
  ];

  for (const { type, maxBytes } of limits) {
    if (maxBytes <= 0) continue;
    let current = await getCacheBytesByType(env.DB, type);
    if (current <= maxBytes) continue;

    // delete oldest until within limit, but cap work per run
    for (let i = 0; i < 20 && current > maxBytes; i++) {
      const rows = await listOldestRows(env.DB, type, null, batch);
      if (!rows.length) break;
      const keys = rows.map((r) => r.key);
      await deleteKeys(env, keys);
      const delta = rows.reduce((s, r) => s + (r.size || 0), 0);
      current = Math.max(0, current - delta);
      deleted += keys.length;
      freedBytes += delta;
      if (keys.length < batch) break;
    }
  }

  return { deleted, freedBytes };
}

