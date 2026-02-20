import type { Env } from "../env";
import { dbAll, dbRun } from "../db";
import { nowMs, formatUtcMs } from "../utils/time";

export interface RequestLogRow {
  id: string;
  time: string;
  timestamp: number;
  ip: string;
  model: string;
  duration: number;
  status: number;
  key_name: string;
  token_suffix: string;
  error: string;
}

export async function addRequestLog(
  db: Env["DB"],
  entry: Omit<RequestLogRow, "id" | "time" | "timestamp"> & { id?: string },
  options?: { maxEntries?: number },
): Promise<void> {
  const ts = nowMs();
  const id = entry.id ?? String(ts);
  const time = formatUtcMs(ts);
  await dbRun(
    db,
    "INSERT INTO request_logs(id,time,timestamp,ip,model,duration,status,key_name,token_suffix,error) VALUES(?,?,?,?,?,?,?,?,?,?)",
    [
      id,
      time,
      ts,
      entry.ip,
      entry.model,
      entry.duration,
      entry.status,
      entry.key_name,
      entry.token_suffix,
      entry.error,
    ],
  );

  const maxEntries = Math.max(0, Number(options?.maxEntries ?? 0) || 0);
  if (maxEntries > 0) {
    const overflow = await dbAll<{ id: string }>(
      db,
      "SELECT id FROM request_logs ORDER BY timestamp DESC LIMIT -1 OFFSET ?",
      [maxEntries],
    );
    if (overflow.length) {
      const ids = overflow.map((x) => x.id).filter(Boolean);
      if (ids.length) {
        const placeholders = ids.map(() => "?").join(",");
        await dbRun(db, `DELETE FROM request_logs WHERE id IN (${placeholders})`, ids);
      }
    }
  }
}

export async function getRequestLogs(db: Env["DB"], limit = 1000): Promise<RequestLogRow[]> {
  return dbAll<RequestLogRow>(
    db,
    "SELECT id,time,timestamp,ip,model,duration,status,key_name,token_suffix,error FROM request_logs ORDER BY timestamp DESC LIMIT ?",
    [limit],
  );
}

export async function clearRequestLogs(db: Env["DB"]): Promise<void> {
  await dbRun(db, "DELETE FROM request_logs");
}

export async function deleteRequestLogsBefore(db: Env["DB"], beforeTs: number): Promise<number> {
  const row = await dbAll<{ c: number }>(
    db,
    "SELECT COUNT(1) as c FROM request_logs WHERE timestamp < ?",
    [beforeTs],
  );
  const count = row[0]?.c ?? 0;
  if (count <= 0) return 0;
  await dbRun(db, "DELETE FROM request_logs WHERE timestamp < ?", [beforeTs]);
  return count;
}

export async function getRequestTrend(
  db: Env["DB"],
  args: { windowMs: number; bucket: "hour" | "day" },
): Promise<Array<{ timestamp: number; total: number; success: number; error: number; avg_duration_ms: number }>> {
  const now = nowMs();
  const begin = now - Math.max(60_000, Number(args.windowMs || 24 * 3600 * 1000));
  const bucketMs = args.bucket === "day" ? 24 * 3600 * 1000 : 3600 * 1000;
  const rows = await dbAll<{ timestamp: number; status: number; duration: number }>(
    db,
    "SELECT timestamp, status, duration FROM request_logs WHERE timestamp >= ? ORDER BY timestamp ASC",
    [begin],
  );

  const map = new Map<number, { timestamp: number; total: number; success: number; error: number; durationTotal: number }>();
  for (const row of rows) {
    const ts = Number(row.timestamp || 0);
    const slot = ts - (ts % bucketMs);
    const cur = map.get(slot) ?? { timestamp: slot, total: 0, success: 0, error: 0, durationTotal: 0 };
    cur.total += 1;
    if (Number(row.status || 0) === 200) cur.success += 1;
    else cur.error += 1;
    cur.durationTotal += Number(row.duration || 0);
    map.set(slot, cur);
  }

  return Array.from(map.values())
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((x) => ({
      timestamp: x.timestamp,
      total: x.total,
      success: x.success,
      error: x.error,
      avg_duration_ms: x.total > 0 ? Number((x.durationTotal * 1000 / x.total).toFixed(2)) : 0,
    }));
}

export async function getModelDistribution(
  db: Env["DB"],
  args: { windowMs: number },
): Promise<Array<{ model: string; count: number; success: number; error: number; avg_duration_ms: number }>> {
  const now = nowMs();
  const begin = now - Math.max(60_000, Number(args.windowMs || 24 * 3600 * 1000));
  const rows = await dbAll<{ model: string; status: number; duration: number }>(
    db,
    "SELECT model, status, duration FROM request_logs WHERE timestamp >= ?",
    [begin],
  );

  const map = new Map<string, { model: string; count: number; success: number; error: number; durationTotal: number }>();
  for (const row of rows) {
    const model = String(row.model || "unknown");
    const cur = map.get(model) ?? { model, count: 0, success: 0, error: 0, durationTotal: 0 };
    cur.count += 1;
    if (Number(row.status || 0) === 200) cur.success += 1;
    else cur.error += 1;
    cur.durationTotal += Number(row.duration || 0);
    map.set(model, cur);
  }

  return Array.from(map.values())
    .sort((a, b) => b.count - a.count)
    .map((x) => ({
      model: x.model,
      count: x.count,
      success: x.success,
      error: x.error,
      avg_duration_ms: x.count > 0 ? Number((x.durationTotal * 1000 / x.count).toFixed(2)) : 0,
    }));
}

export async function getKeySummary(
  db: Env["DB"],
  args: { windowMs: number },
): Promise<Array<{ key_name: string; total: number; success: number; error: number; avg_duration_ms: number }>> {
  const now = nowMs();
  const begin = now - Math.max(60_000, Number(args.windowMs || 24 * 3600 * 1000));
  const rows = await dbAll<{ key_name: string; status: number; duration: number }>(
    db,
    "SELECT key_name, status, duration FROM request_logs WHERE timestamp >= ?",
    [begin],
  );

  const map = new Map<string, { key_name: string; total: number; success: number; error: number; durationTotal: number }>();
  for (const row of rows) {
    const keyName = String(row.key_name || "unknown");
    const cur = map.get(keyName) ?? { key_name: keyName, total: 0, success: 0, error: 0, durationTotal: 0 };
    cur.total += 1;
    if (Number(row.status || 0) === 200) cur.success += 1;
    else cur.error += 1;
    cur.durationTotal += Number(row.duration || 0);
    map.set(keyName, cur);
  }

  return Array.from(map.values())
    .sort((a, b) => b.total - a.total)
    .map((x) => ({
      key_name: x.key_name,
      total: x.total,
      success: x.success,
      error: x.error,
      avg_duration_ms: x.total > 0 ? Number((x.durationTotal * 1000 / x.total).toFixed(2)) : 0,
    }));
}

export async function getKeyTrend24h(
  db: Env["DB"],
): Promise<Array<{ key_name: string; timestamp: number; total: number; success: number; error: number; avg_duration_ms: number }>> {
  const now = nowMs();
  const begin = now - 24 * 3600 * 1000;
  const bucketMs = 3600 * 1000;
  const rows = await dbAll<{ key_name: string; timestamp: number; status: number; duration: number }>(
    db,
    "SELECT key_name, timestamp, status, duration FROM request_logs WHERE timestamp >= ? ORDER BY timestamp ASC",
    [begin],
  );

  const map = new Map<string, { key_name: string; timestamp: number; total: number; success: number; error: number; durationTotal: number }>();
  for (const row of rows) {
    const keyName = String(row.key_name || "unknown");
    const ts = Number(row.timestamp || 0);
    const slot = ts - (ts % bucketMs);
    const key = `${keyName}@@${slot}`;
    const cur = map.get(key) ?? { key_name: keyName, timestamp: slot, total: 0, success: 0, error: 0, durationTotal: 0 };
    cur.total += 1;
    if (Number(row.status || 0) === 200) cur.success += 1;
    else cur.error += 1;
    cur.durationTotal += Number(row.duration || 0);
    map.set(key, cur);
  }

  return Array.from(map.values())
    .sort((a, b) => a.timestamp - b.timestamp || a.key_name.localeCompare(b.key_name))
    .map((x) => ({
      key_name: x.key_name,
      timestamp: x.timestamp,
      total: x.total,
      success: x.success,
      error: x.error,
      avg_duration_ms: x.total > 0 ? Number((x.durationTotal * 1000 / x.total).toFixed(2)) : 0,
    }));
}

