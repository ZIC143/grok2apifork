import type { OpenAIChatMessage } from "./conversation";
import type { Env } from "../env";
import { getConversationByFullHash, getConversationById, upsertConversation } from "../repo/conversations";

export interface ConversationState {
  conversationId: string;
  upstreamConversationId: string;
  responseId: string;
  shareLinkId: string;
  token: string;
  fullHash: string;
}

function extractText(content: OpenAIChatMessage["content"]): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    const pieces: string[] = [];
    for (const it of content) {
      if (it?.type === "text" && typeof it.text === "string") {
        const v = it.text.trim();
        if (v) pieces.push(v);
      }
    }
    return pieces.join("\n");
  }
  return "";
}

function hashMessages(messages: OpenAIChatMessage[], excludeLastUser: boolean): string {
  const normalized = messages
    .map((m) => ({ role: String(m.role ?? "user"), text: extractText(m.content) }))
    .filter((m) => m.text.length > 0);

  if (excludeLastUser) {
    for (let i = normalized.length - 1; i >= 0; i--) {
      if (normalized[i]?.role === "user") {
        normalized.splice(i, 1);
        break;
      }
    }
  }

  const system: string[] = [];
  const user: string[] = [];
  for (const item of normalized) {
    if (item.role === "system") system.push(item.text);
    if (item.role === "user") user.push(item.text);
  }

  const raw = JSON.stringify({ system: system.join("\n"), user: user.join("\n") });
  let h1 = 2166136261;
  let h2 = 16777619;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 16777619);
    h2 ^= c + ((i * 131) % 251);
    h2 = Math.imul(h2, 2246822519);
  }
  const p1 = (h1 >>> 0).toString(16).padStart(8, "0");
  const p2 = (h2 >>> 0).toString(16).padStart(8, "0");
  return `${p1}${p2}${p1}${p2}`;
}

function nowMs(): number {
  return Date.now();
}

function ttlMs(): number {
  return 20 * 60 * 60 * 1000;
}

export async function resolveConversation(args: {
  env: Env;
  conversationIdFromReq?: string;
  messages: OpenAIChatMessage[];
}): Promise<{ conversationId: string; state: ConversationState | null; fullHash: string }> {
  const { env, conversationIdFromReq, messages } = args;
  const requestId = (conversationIdFromReq ?? "").trim();
  const fullHash = hashMessages(messages, false);
  const historyHash = hashMessages(messages, true);

  if (requestId) {
    const row = await getConversationById(env.DB, requestId);
    if (row && row.expires_at > nowMs()) {
      return {
        conversationId: requestId,
        state: {
          conversationId: row.conversation_id,
          upstreamConversationId: row.upstream_conversation_id ?? "",
          responseId: row.response_id ?? "",
          shareLinkId: row.share_link_id ?? "",
          token: row.token ?? "",
          fullHash: row.full_hash ?? "",
        },
        fullHash,
      };
    }
    return { conversationId: requestId, state: null, fullHash };
  }

  if (historyHash) {
    const row = await getConversationByFullHash(env.DB, historyHash);
    if (row && row.expires_at > nowMs()) {
      return {
        conversationId: row.conversation_id,
        state: {
          conversationId: row.conversation_id,
          upstreamConversationId: row.upstream_conversation_id ?? "",
          responseId: row.response_id ?? "",
          shareLinkId: row.share_link_id ?? "",
          token: row.token ?? "",
          fullHash: row.full_hash ?? "",
        },
        fullHash,
      };
    }
  }

  return {
    conversationId: `conv_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`,
    state: null,
    fullHash,
  };
}

export async function saveConversationState(args: {
  env: Env;
  conversationId: string;
  upstreamConversationId?: string;
  responseId?: string;
  shareLinkId?: string;
  token: string;
  fullHash: string;
}): Promise<void> {
  await upsertConversation(args.env.DB, {
    conversation_id: args.conversationId,
    upstream_conversation_id: args.upstreamConversationId ?? null,
    response_id: args.responseId ?? null,
    share_link_id: args.shareLinkId ?? null,
    token: args.token,
    full_hash: args.fullHash,
    updated_at: nowMs(),
    expires_at: nowMs() + ttlMs(),
  });
}
