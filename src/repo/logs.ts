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

