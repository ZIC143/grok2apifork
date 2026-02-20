import type { Env } from "../env";
import { dbAll, dbFirst, dbRun } from "../db";

export interface ConversationRow {
  conversation_id: string;
  upstream_conversation_id: string | null;
  response_id: string | null;
  share_link_id: string | null;
  token: string | null;
  full_hash: string | null;
  updated_at: number;
  expires_at: number;
}

export async function getConversationById(db: Env["DB"], conversationId: string): Promise<ConversationRow | null> {
  return dbFirst<ConversationRow>(
    db,
    "SELECT conversation_id, upstream_conversation_id, response_id, share_link_id, token, full_hash, updated_at, expires_at FROM conversations WHERE conversation_id = ?",
    [conversationId],
  );
}

export async function getConversationByFullHash(db: Env["DB"], fullHash: string): Promise<ConversationRow | null> {
  return dbFirst<ConversationRow>(
    db,
    "SELECT conversation_id, upstream_conversation_id, response_id, share_link_id, token, full_hash, updated_at, expires_at FROM conversations WHERE full_hash = ? ORDER BY updated_at DESC LIMIT 1",
    [fullHash],
  );
}

export async function upsertConversation(
  db: Env["DB"],
  row: {
    conversation_id: string;
    upstream_conversation_id?: string | null;
    response_id?: string | null;
    share_link_id?: string | null;
    token?: string | null;
    full_hash?: string | null;
    updated_at: number;
    expires_at: number;
    max_per_token?: number;
  },
): Promise<void> {
  await dbRun(
    db,
    `INSERT INTO conversations(conversation_id, upstream_conversation_id, response_id, share_link_id, token, full_hash, updated_at, expires_at)
     VALUES(?,?,?,?,?,?,?,?)
     ON CONFLICT(conversation_id) DO UPDATE SET
       upstream_conversation_id=excluded.upstream_conversation_id,
       response_id=excluded.response_id,
       share_link_id=excluded.share_link_id,
       token=excluded.token,
       full_hash=excluded.full_hash,
       updated_at=excluded.updated_at,
       expires_at=excluded.expires_at`,
    [
      row.conversation_id,
      row.upstream_conversation_id ?? null,
      row.response_id ?? null,
      row.share_link_id ?? null,
      row.token ?? null,
      row.full_hash ?? null,
      row.updated_at,
      row.expires_at,
    ],
  );

  const token = String(row.token ?? "").trim();
  const maxPerToken = Math.max(1, Math.min(5000, Number(row.max_per_token ?? 0) || 0));
  if (!token || maxPerToken <= 0) return;

  const overflow = await dbAll<{ conversation_id: string }>(
    db,
    "SELECT conversation_id FROM conversations WHERE token = ? ORDER BY updated_at DESC LIMIT -1 OFFSET ?",
    [token, maxPerToken],
  );
  if (!overflow.length) return;

  const ids = overflow.map((x) => x.conversation_id).filter(Boolean);
  if (!ids.length) return;
  const placeholders = ids.map(() => "?").join(",");
  await dbRun(db, `DELETE FROM conversations WHERE conversation_id IN (${placeholders})`, ids);
}

export async function deleteExpiredConversations(db: Env["DB"], nowMs: number): Promise<number> {
  const nowSec = Math.floor(nowMs / 1000);
  const rows = await dbAll<{ conversation_id: string }>(
    db,
    "SELECT conversation_id FROM conversations WHERE (expires_at >= 1000000000000 AND expires_at <= ?) OR (expires_at > 0 AND expires_at < 1000000000000 AND expires_at <= ?)",
    [nowMs, nowSec],
  );
  if (!rows.length) return 0;
  await dbRun(
    db,
    "DELETE FROM conversations WHERE (expires_at >= 1000000000000 AND expires_at <= ?) OR (expires_at > 0 AND expires_at < 1000000000000 AND expires_at <= ?)",
    [nowMs, nowSec],
  );
  return rows.length;
}

export async function listConversations(
  db: Env["DB"],
  args: { limit: number; offset: number; token?: string },
): Promise<{ total: number; items: ConversationRow[] }> {
  const limit = Math.max(1, Math.min(2000, Number(args.limit || 100)));
  const offset = Math.max(0, Number(args.offset || 0));
  const token = String(args.token ?? "").trim();

  if (token) {
    const totalRow = await dbFirst<{ c: number }>(
      db,
      "SELECT COUNT(1) as c FROM conversations WHERE token = ?",
      [token],
    );
    const items = await dbAll<ConversationRow>(
      db,
      "SELECT conversation_id, upstream_conversation_id, response_id, share_link_id, token, full_hash, updated_at, expires_at FROM conversations WHERE token = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?",
      [token, limit, offset],
    );
    return { total: totalRow?.c ?? 0, items };
  }

  const totalRow = await dbFirst<{ c: number }>(db, "SELECT COUNT(1) as c FROM conversations");
  const items = await dbAll<ConversationRow>(
    db,
    "SELECT conversation_id, upstream_conversation_id, response_id, share_link_id, token, full_hash, updated_at, expires_at FROM conversations ORDER BY updated_at DESC LIMIT ? OFFSET ?",
    [limit, offset],
  );
  return { total: totalRow?.c ?? 0, items };
}

export async function deleteConversationById(db: Env["DB"], conversationId: string): Promise<void> {
  await dbRun(db, "DELETE FROM conversations WHERE conversation_id = ?", [conversationId]);
}

export async function deleteConversationsByToken(db: Env["DB"], token: string): Promise<number> {
  const rows = await dbAll<{ conversation_id: string }>(
    db,
    "SELECT conversation_id FROM conversations WHERE token = ?",
    [token],
  );
  if (!rows.length) return 0;
  await dbRun(db, "DELETE FROM conversations WHERE token = ?", [token]);
  return rows.length;
}
