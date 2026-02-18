import type { Env } from "../env";
import { dbAll, dbFirst, dbRun } from "../db";

export type CacheType = "image" | "video";

export interface R2CacheRow {
  key: string;
  type: CacheType;
  size: number;
  etag: string | null;
  content_type: string | null;
  created_at: number;
  last_access_at: number;
}

export async function upsertCacheRow(
  db: Env["DB"],
  row: Omit<R2CacheRow, "etag" | "content_type"> & { etag?: string | null; content_type?: string | null },
): Promise<void> {
  await dbRun(
    db,
    `INSERT INTO r2_cache(key,type,size,etag,content_type,created_at,last_access_at)
     VALUES(?,?,?,?,?,?,?)
     ON CONFLICT(key) DO UPDATE SET
       type=excluded.type,
       size=excluded.size,
       etag=excluded.etag,
       content_type=excluded.content_type,
       last_access_at=excluded.last_access_at`,
    [
      row.key,
      row.type,
      row.size,
      row.etag ?? null,
      row.content_type ?? null,
      row.created_at,
      row.last_access_at,
    ],
  );
}

export async function touchCacheRow(db: Env["DB"], key: string, at: number): Promise<void> {
  await dbRun(db, "UPDATE r2_cache SET last_access_at = ? WHERE key = ?", [at, key]);
}

export async function deleteCacheRow(db: Env["DB"], key: string): Promise<void> {
  await dbRun(db, "DELETE FROM r2_cache WHERE key = ?", [key]);
}

export async function getCacheRow(db: Env["DB"], key: string): Promise<R2CacheRow | null> {
  return dbFirst<R2CacheRow>(
    db,
    "SELECT key,type,size,etag,content_type,created_at,last_access_at FROM r2_cache WHERE key = ?",
    [key],
  );
}

export async function getCacheSizeBytes(db: Env["DB"]): Promise<{ image: number; video: number; total: number }> {
  const rows = await dbAll<{ type: CacheType; bytes: number }>(
    db,
    "SELECT type, COALESCE(SUM(size),0) as bytes FROM r2_cache GROUP BY type",
  );
  let image = 0;
  let video = 0;
  for (const r of rows) {
    if (r.type === "image") image = r.bytes;
    if (r.type === "video") video = r.bytes;
  }
  return { image, video, total: image + video };
}

export async function listCacheRowsByType(
  db: Env["DB"],
  type: CacheType,
  limit: number,
  offset: number,
): Promise<{ total: number; items: R2CacheRow[] }> {
  const totalRow = await dbFirst<{ c: number }>(db, "SELECT COUNT(1) as c FROM r2_cache WHERE type = ?", [type]);
  const items = await dbAll<R2CacheRow>(
    db,
    "SELECT key,type,size,etag,content_type,created_at,last_access_at FROM r2_cache WHERE type = ? ORDER BY last_access_at DESC LIMIT ? OFFSET ?",
    [type, limit, offset],
  );
  return { total: totalRow?.c ?? 0, items };
}

export async function listOldestRows(
  db: Env["DB"],
  type: CacheType | null,
  beforeMs: number | null,
  limit: number,
): Promise<Pick<R2CacheRow, "key" | "type" | "size" | "last_access_at">[]> {
  if (type && beforeMs !== null) {
    return dbAll(db, "SELECT key,type,size,last_access_at FROM r2_cache WHERE type=? AND last_access_at < ? ORDER BY last_access_at ASC LIMIT ?", [type, beforeMs, limit]);
  }
  if (type) {
    return dbAll(db, "SELECT key,type,size,last_access_at FROM r2_cache WHERE type=? ORDER BY last_access_at ASC LIMIT ?", [type, limit]);
  }
  if (beforeMs !== null) {
    return dbAll(db, "SELECT key,type,size,last_access_at FROM r2_cache WHERE last_access_at < ? ORDER BY last_access_at ASC LIMIT ?", [beforeMs, limit]);
  }
  return dbAll(db, "SELECT key,type,size,last_access_at FROM r2_cache ORDER BY last_access_at ASC LIMIT ?", [limit]);
}

export async function deleteCacheRows(db: Env["DB"], keys: string[]): Promise<void> {
  if (!keys.length) return;
  const placeholders = keys.map(() => "?").join(",");
  await dbRun(db, `DELETE FROM r2_cache WHERE key IN (${placeholders})`, keys);
}

export async function getCacheBytesByType(db: Env["DB"], type: CacheType): Promise<number> {
  const row = await dbFirst<{ bytes: number }>(
    db,
    "SELECT COALESCE(SUM(size),0) as bytes FROM r2_cache WHERE type = ?",
    [type],
  );
  return row?.bytes ?? 0;
}
