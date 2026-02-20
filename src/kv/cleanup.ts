import type { Env } from "../env";
import { nowMs } from "../utils/time";
import { deleteCacheRows, listOldestRows } from "../repo/cache";
import { getSettings } from "../settings";
import { deleteExpiredConversations } from "../repo/conversations";
import { deleteRequestLogsBefore } from "../repo/logs";

function parseIntSafe(v: string | undefined, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

async function deleteKeys(env: Env, keys: string[]): Promise<void> {
  if (!keys.length) return;
  await Promise.all(keys.map((k) => env.KV_CACHE.delete(k)));
  await deleteCacheRows(env.DB, keys);
}

export async function runKvDailyClear(env: Env): Promise<{ deleted: number }> {
  const batch = Math.min(500, Math.max(1, parseIntSafe(env.KV_CLEANUP_BATCH, 200)));

  let deleted = 0;
  // Cap work per scheduled run to avoid timeouts
  for (let i = 0; i < 200; i++) {
    const rows = await listOldestRows(env.DB, null, null, batch);
    if (!rows.length) break;
    const keys = rows.map((r) => r.key);
    await deleteKeys(env, keys);
    deleted += keys.length;
    if (keys.length < batch) break;
  }

  const settings = await getSettings(env);
  const now = nowMs();
  const conversationDeleted = await deleteExpiredConversations(env.DB, now);
  const retentionDays = Math.max(1, Number(settings.global.log_retention_days ?? 7));
  const logsDeleted = await deleteRequestLogsBefore(env.DB, now - retentionDays * 24 * 3600 * 1000);

  return { deleted: deleted + conversationDeleted + logsDeleted };
}

export function nextLocalMidnightExpirationSeconds(now = nowMs(), tzOffsetMinutes: number): number {
  const offsetMs = tzOffsetMinutes * 60 * 1000;
  const local = new Date(now + offsetMs);
  const year = local.getUTCFullYear();
  const month = local.getUTCMonth();
  const day = local.getUTCDate();
  const next = Date.UTC(year, month, day + 1, 0, 0, 0);
  // Convert local-midnight back to UTC epoch seconds
  return Math.floor((next - offsetMs) / 1000);
}

