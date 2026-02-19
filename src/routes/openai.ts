import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "../env";
import { requireApiAuth } from "../auth";
import { getSettings, normalizeCfCookie, saveSettings } from "../settings";
import { isValidModel, MODEL_CONFIG } from "../grok/models";
import { extractContent, buildConversationPayload, sendConversationRequest } from "../grok/conversation";
import { uploadImage } from "../grok/upload";
import { createPost } from "../grok/create";
import { createOpenAiStreamFromGrokNdjson, parseOpenAiFromGrokNdjson } from "../grok/processor";
import { getDynamicHeaders } from "../grok/headers";
import { checkRateLimits } from "../grok/rateLimits";
import { addRequestLog } from "../repo/logs";
import {
  addTokens,
  applyCooldown,
  deleteTokens,
  listTokens,
  recordTokenFailure,
  selectBestToken,
  updateTokenLimits,
  updateTokenNote,
  updateTokenTags,
} from "../repo/tokens";
import { deleteCacheRow, deleteCacheRows, getCacheSizeBytes, listCacheRowsByType, listOldestRows, type CacheType } from "../repo/cache";
import type { ApiAuthInfo } from "../auth";

function openAiError(message: string, code: string): Record<string, unknown> {
  return { error: { message, type: "invalid_request_error", code } };
}

function getClientIp(req: Request): string {
  return (
    req.headers.get("CF-Connecting-IP") ||
    req.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
    "0.0.0.0"
  );
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  const queue = items.slice();
  const workers = Array.from({ length: Math.max(1, limit) }, async () => {
    while (queue.length) {
      const item = queue.shift() as T;
      results.push(await fn(item));
    }
  });
  await Promise.all(workers);
  return results;
}

function parseBearer(authHeader: string | null): string {
  if (!authHeader) return "";
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim() || "";
}

function parseTags(tagsJson: string): string[] {
  try {
    const data = JSON.parse(tagsJson) as unknown;
    return Array.isArray(data) ? data.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function isSuperPool(pool: string): boolean {
  return String(pool).toLowerCase().includes("super");
}

function toTokenType(pool: string): "sso" | "ssoSuper" {
  return isSuperPool(pool) ? "ssoSuper" : "sso";
}

function toPoolName(tokenType: "sso" | "ssoSuper"): "ssoBasic" | "ssoSuper" {
  return tokenType === "ssoSuper" ? "ssoSuper" : "ssoBasic";
}

async function getLegacyAppKey(env: Env): Promise<string> {
  const settings = await getSettings(env);
  return String(settings.global.admin_password ?? "").trim();
}

async function getLegacyApiKey(env: Env): Promise<string> {
  const settings = await getSettings(env);
  return String(settings.grok.api_key ?? "").trim();
}

async function getLegacyPublicConfig(env: Env): Promise<{ enabled: boolean; key: string }> {
  const settings = await getSettings(env);
  const publicKey = String(settings.global.public_key ?? "").trim();
  const apiKey = await getLegacyApiKey(env);
  return {
    enabled: settings.global.public_enabled !== false,
    key: publicKey || apiKey,
  };
}

async function requireLegacyAdmin(c: any): Promise<Response | null> {
  const bearer = parseBearer(c.req.header("Authorization") ?? null);
  const queryKey = String(c.req.query("app_key") ?? "").trim();
  const provided = bearer || queryKey;
  const expected = await getLegacyAppKey(c.env as Env);
  if (!expected || !provided || provided !== expected) {
    return c.json({ status: "error", detail: "Unauthorized" }, 401);
  }
  return null;
}

function toLegacyConfig(settings: Awaited<ReturnType<typeof getSettings>>): Record<string, any> {
  return {
    app: {
      api_key: settings.grok.api_key ?? "",
      app_key: settings.global.admin_password ?? "",
      public_enabled: settings.global.public_enabled !== false,
      public_key: settings.global.public_key ?? "",
      app_url: settings.global.base_url ?? "",
      image_format: settings.global.image_mode ?? "url",
      temporary: settings.grok.temporary ?? false,
      dynamic_statsig: settings.grok.dynamic_statsig ?? true,
      filter_tags: settings.grok.filtered_tags ?? "",
      thinking: settings.grok.show_thinking ?? true,
    },
    proxy: {
      base_proxy_url: settings.grok.proxy_url ?? "",
      asset_proxy_url: settings.grok.cache_proxy_url ?? "",
      cf_clearance: settings.grok.cf_clearance ?? "",
    },
    retry: {
      retry_status_codes: settings.grok.retry_status_codes ?? [401, 429],
    },
    chat: {
      timeout: settings.grok.stream_total_timeout ?? 600,
      stream_timeout: settings.grok.stream_chunk_timeout ?? 120,
      concurrent: 10,
    },
    image: {
      timeout: settings.grok.stream_total_timeout ?? 600,
      stream_timeout: settings.grok.stream_chunk_timeout ?? 120,
      final_min_bytes: 100000,
      nsfw: false,
    },
    video: {
      timeout: settings.grok.stream_total_timeout ?? 600,
      stream_timeout: settings.grok.stream_chunk_timeout ?? 120,
      concurrent: 5,
    },
    voice: {
      timeout: settings.grok.stream_total_timeout ?? 600,
    },
  };
}

async function clearKvCacheByType(env: Env, type: CacheType | null, batch = 200, maxLoops = 20): Promise<number> {
  let deleted = 0;
  for (let i = 0; i < maxLoops; i++) {
    const rows = await listOldestRows(env.DB, type, null, batch);
    if (!rows.length) break;
    const keys = rows.map((r) => r.key);
    await Promise.all(keys.map((k) => env.KV_CACHE.delete(k)));
    await deleteCacheRows(env.DB, keys);
    deleted += keys.length;
    if (keys.length < batch) break;
  }
  return deleted;
}

async function buildLegacyCacheStats(env: Env, scope: "all" | "selected" | "none" = "none", token = ""): Promise<Record<string, any>> {
  const bytes = await getCacheSizeBytes(env.DB);
  const image = await listCacheRowsByType(env.DB, "image", 1, 0);
  const video = await listCacheRowsByType(env.DB, "video", 1, 0);
  const rows = await listTokens(env.DB);
  const accounts = onlineAccountRows(rows);

  let onlineCount = 0;
  let onlineStatus = "not_loaded";
  let lastClear: number | null = null;
  const details: Array<Record<string, unknown>> = [];

  for (const r of rows) {
    const st = onlineAssetState.get(r.token);
    const clearAt = onlineAssetClearAt.get(r.token) ?? null;
    const status = st?.status ?? "not_loaded";
    const count = st?.count ?? 0;
    onlineCount += count;
    if (status === "ok") onlineStatus = "ok";
    if (status.startsWith("error")) onlineStatus = onlineStatus === "ok" ? "ok" : "error";
    if (typeof clearAt === "number") lastClear = Math.max(lastClear ?? 0, clearAt);
    details.push({
      token: r.token,
      token_masked: maskToken(r.token),
      count,
      status,
      last_asset_clear_at: clearAt,
    });
  }

  const selected = token ? onlineAssetState.get(token) : null;
  return {
    local_image: {
      count: image.total,
      size_mb: Number((bytes.image / 1024 / 1024).toFixed(2)),
    },
    local_video: {
      count: video.total,
      size_mb: Number((bytes.video / 1024 / 1024).toFixed(2)),
    },
    online: {
      count: token ? selected?.count ?? 0 : onlineCount,
      status: token ? selected?.status ?? "not_loaded" : onlineStatus,
      token,
      last_asset_clear_at: token ? onlineAssetClearAt.get(token) ?? null : lastClear,
    },
    online_accounts: accounts,
    online_details: details,
    online_scope: scope,
  };
}

const legacyBatchTasks = new Map<string, { kind: string; total: number; result?: Record<string, unknown> }>();

const IMAGINE_SESSION_TTL_MS = 10 * 60 * 1000;
const VIDEO_SESSION_TTL_MS = 10 * 60 * 1000;

const imagineSessions = new Map<
  string,
  {
    prompt: string;
    aspect_ratio: string;
    nsfw: boolean | null;
    created_at: number;
  }
>();

const videoSessions = new Map<
  string,
  {
    prompt: string;
    aspect_ratio: string;
    video_length: number;
    resolution_name: "480p" | "720p";
    preset: "fun" | "normal" | "spicy" | "custom";
    image_url: string | null;
    reasoning_effort: string | null;
    created_at: number;
  }
>();

const onlineAssetClearAt = new Map<string, number>();
const onlineAssetState = new Map<string, { count: number; status: string }>();

function createLegacyTask(kind: string, total: number, result?: Record<string, unknown>): string {
  const taskId = crypto.randomUUID();
  if (result) legacyBatchTasks.set(taskId, { kind, total: Math.max(0, total), result });
  else legacyBatchTasks.set(taskId, { kind, total: Math.max(0, total) });
  return taskId;
}

function cleanupSessions<T extends { created_at: number }>(store: Map<string, T>, ttlMs: number): void {
  const now = Date.now();
  for (const [taskId, info] of store.entries()) {
    if (now - info.created_at > ttlMs) store.delete(taskId);
  }
}

function getImagineSession(taskId: string): (typeof imagineSessions extends Map<any, infer V> ? V : never) | null {
  cleanupSessions(imagineSessions, IMAGINE_SESSION_TTL_MS);
  if (!taskId) return null;
  const v = imagineSessions.get(taskId);
  if (!v) return null;
  return { ...v };
}

function getVideoSession(taskId: string): (typeof videoSessions extends Map<any, infer V> ? V : never) | null {
  cleanupSessions(videoSessions, VIDEO_SESSION_TTL_MS);
  if (!taskId) return null;
  const v = videoSessions.get(taskId);
  if (!v) return null;
  return { ...v };
}

async function requireLegacyPublic(c: any): Promise<Response | null> {
  const bearer = parseBearer(c.req.header("Authorization") ?? null);
  const queryKey = String(c.req.query("public_key") ?? "").trim();
  const provided = bearer || queryKey;
  const cfg = await getLegacyPublicConfig(c.env as Env);
  if (!cfg.enabled) return c.json({ status: "error", detail: "Public access is disabled" }, 401);
  const expected = cfg.key;
  if (!expected) return null;
  if (provided && provided === expected) return null;
  return c.json({ status: "error", detail: "Unauthorized" }, 401);
}

function resolveImagineRatio(raw: string): string {
  const v = String(raw || "").trim();
  const allow = new Set(["16:9", "9:16", "3:2", "2:3", "1:1", "4:3", "3:4"]);
  return allow.has(v) ? v : "2:3";
}

function resolveVideoRatio(raw: string): "16:9" | "9:16" | "3:2" | "2:3" | "1:1" {
  const map: Record<string, "16:9" | "9:16" | "3:2" | "2:3" | "1:1"> = {
    "16:9": "16:9",
    "9:16": "9:16",
    "3:2": "3:2",
    "2:3": "2:3",
    "1:1": "1:1",
    "1280x720": "16:9",
    "720x1280": "9:16",
    "1792x1024": "3:2",
    "1024x1792": "2:3",
    "1024x1024": "1:1",
  };
  return map[String(raw || "").trim()] ?? "3:2";
}

function maskToken(token: string): string {
  if (!token) return "";
  if (token.length <= 10) return `${token.slice(0, 3)}***${token.slice(-2)}`;
  return `${token.slice(0, 6)}...${token.slice(-4)}`;
}

function onlineAccountRows(rows: Awaited<ReturnType<typeof listTokens>>): Array<Record<string, unknown>> {
  return rows.map((r) => ({
    token: r.token,
    token_masked: maskToken(r.token),
    pool: toPoolName(r.token_type),
    last_asset_clear_at: onlineAssetClearAt.get(r.token) ?? null,
  }));
}

function base64UrlEncode(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function encodeAssetPath(raw: string): string {
  try {
    const u = new URL(raw);
    return `u_${base64UrlEncode(u.toString())}`;
  } catch {
    const p = raw.startsWith("/") ? raw : `/${raw}`;
    return `p_${base64UrlEncode(p)}`;
  }
}

function toProxyAssetUrl(raw: string, settings: Awaited<ReturnType<typeof getSettings>>["global"], origin: string): string {
  const baseUrl = String(settings.base_url ?? "").trim() || origin;
  const path = encodeAssetPath(raw);
  return `${baseUrl}/images/${path}`;
}

async function consumeNdjson(
  upstream: Response,
  onObject: (obj: Record<string, any>) => Promise<void> | void,
): Promise<void> {
  if (!upstream.body) return;
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      buffer += decoder.decode(value, { stream: true });
      let idx = -1;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const data = JSON.parse(line) as Record<string, any>;
          await onObject(data);
        } catch {
          // ignore malformed line
        }
      }
    }
    const tail = buffer.trim();
    if (tail) {
      try {
        const data = JSON.parse(tail) as Record<string, any>;
        await onObject(data);
      } catch {
        // ignore
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
}

async function listRemoteAssetIds(env: Env, token: string, settings: Awaited<ReturnType<typeof getSettings>>): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();
  let pageToken = "";

  for (let i = 0; i < 100; i++) {
    const headers = getDynamicHeaders(settings.grok, "/rest/assets");
    const cf = normalizeCfCookie(settings.grok.cf_clearance ?? "");
    headers.Cookie = cf ? `sso-rw=${token};sso=${token};${cf}` : `sso-rw=${token};sso=${token}`;

    const url = new URL("https://grok.com/rest/assets");
    url.searchParams.set("pageSize", "50");
    url.searchParams.set("orderBy", "ORDER_BY_LAST_USE_TIME");
    url.searchParams.set("source", "SOURCE_ANY");
    url.searchParams.set("isLatest", "true");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const upstream = await fetch(url.toString(), {
      method: "GET",
      headers,
    });

    if (!upstream.ok) {
      const txt = await upstream.text().catch(() => "");
      await recordTokenFailure(env.DB, token, upstream.status, txt.slice(0, 200));
      await applyCooldown(env.DB, token, upstream.status);
      throw new Error(`assets_list_http_${upstream.status}`);
    }

    const data = (await upstream.json().catch(() => ({}))) as Record<string, any>;
    const items = Array.isArray(data.assets) ? data.assets : [];
    for (const item of items) {
      const id = String(item?.assetId ?? "").trim();
      if (id) out.push(id);
    }

    const next = String(data.nextPageToken ?? "").trim();
    if (!next || seen.has(next)) break;
    seen.add(next);
    pageToken = next;
  }

  return out;
}

async function clearRemoteAssets(
  env: Env,
  token: string,
  assetIds: string[],
  settings: Awaited<ReturnType<typeof getSettings>>,
): Promise<{ success: number; failed: number }> {
  let success = 0;
  let failed = 0;
  const targets = assetIds.filter(Boolean);

  await mapLimit(targets, 6, async (assetId) => {
    const headers = getDynamicHeaders(settings.grok, "/rest/assets-metadata");
    const cf = normalizeCfCookie(settings.grok.cf_clearance ?? "");
    headers.Cookie = cf ? `sso-rw=${token};sso=${token};${cf}` : `sso-rw=${token};sso=${token}`;

    const upstream = await fetch(`https://grok.com/rest/assets-metadata/${encodeURIComponent(assetId)}`, {
      method: "DELETE",
      headers,
    });

    if (upstream.ok) {
      success += 1;
      return;
    }

    failed += 1;
    const txt = await upstream.text().catch(() => "");
    await recordTokenFailure(env.DB, token, upstream.status, txt.slice(0, 200));
    await applyCooldown(env.DB, token, upstream.status);
  });

  if (success > 0) onlineAssetClearAt.set(token, Date.now());
  return { success, failed };
}

async function buildOnlineDetails(
  env: Env,
  settings: Awaited<ReturnType<typeof getSettings>>,
  tokens: string[],
): Promise<{ details: Array<Record<string, unknown>>; total: number }> {
  let total = 0;
  const details: Array<Record<string, unknown>> = [];

  for (const token of tokens) {
    try {
      const assetIds = await listRemoteAssetIds(env, token, settings);
      total += assetIds.length;
      onlineAssetState.set(token, { count: assetIds.length, status: "ok" });
      details.push({
        token,
        token_masked: maskToken(token),
        count: assetIds.length,
        status: "ok",
        last_asset_clear_at: onlineAssetClearAt.get(token) ?? null,
      });
    } catch (e) {
      onlineAssetState.set(token, { count: 0, status: `error: ${e instanceof Error ? e.message : String(e)}` });
      details.push({
        token,
        token_masked: maskToken(token),
        count: 0,
        status: `error: ${e instanceof Error ? e.message : String(e)}`,
        last_asset_clear_at: onlineAssetClearAt.get(token) ?? null,
      });
    }
  }

  return { details, total };
}

function onlineSummaryFromDetails(details: Array<Record<string, unknown>>): { count: number; status: string; last_asset_clear_at: number | null } {
  let count = 0;
  let status = "not_loaded";
  let last_asset_clear_at: number | null = null;
  for (const d of details) {
    count += Number(d.count ?? 0) || 0;
    const st = String(d.status ?? "not_loaded");
    if (st === "ok") status = "ok";
    else if (st.startsWith("error") && status !== "ok") status = "error";
    const t = Number(d.last_asset_clear_at ?? 0) || 0;
    if (t > 0) last_asset_clear_at = Math.max(last_asset_clear_at ?? 0, t);
  }
  return { count, status, last_asset_clear_at };
}

async function refreshTokenQuota(
  env: Env,
  settings: Awaited<ReturnType<typeof getSettings>>,
  row: Awaited<ReturnType<typeof listTokens>>[number],
): Promise<{ ok: boolean; detail?: string }> {
  try {
    const cf = normalizeCfCookie(settings.grok.cf_clearance ?? "");
    const cookie = cf ? `sso-rw=${row.token};sso=${row.token};${cf}` : `sso-rw=${row.token};sso=${row.token}`;

    const basic = await checkRateLimits(cookie, settings.grok, "grok-4-fast");
    if (!basic) {
      await applyCooldown(env.DB, row.token, 500);
      return { ok: false, detail: "rate_limit_check_failed" };
    }

    const remaining = Number((basic as any).remainingTokens);
    if (Number.isFinite(remaining)) {
      await updateTokenLimits(env.DB, row.token, { remaining_queries: Math.floor(remaining) });
    }

    if (row.token_type === "ssoSuper") {
      const heavy = await checkRateLimits(cookie, settings.grok, "grok-4-heavy");
      const heavyRemaining = Number((heavy as any)?.remainingTokens);
      if (Number.isFinite(heavyRemaining)) {
        await updateTokenLimits(env.DB, row.token, { heavy_remaining_queries: Math.floor(heavyRemaining) });
      }
    }

    return { ok: true };
  } catch (e) {
    await applyCooldown(env.DB, row.token, 500);
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

export const openAiRoutes = new Hono<{ Bindings: Env; Variables: { apiAuth: ApiAuthInfo } }>();

openAiRoutes.use(
  "/*",
  cors({
    origin: "*",
    allowHeaders: ["Authorization", "Content-Type"],
    allowMethods: ["GET", "POST", "OPTIONS"],
    maxAge: 86400,
  }),
);

// Admin verification endpoint for frontend (app_key validation)
openAiRoutes.get("/admin/verify", async (c) => {
  const denied = await requireLegacyAdmin(c);
  if (denied) return denied;
  return c.json({ success: true }, 200);
});

openAiRoutes.get("/public/verify", async (c) => {
  const bearer = parseBearer(c.req.header("Authorization") ?? null);
  const cfg = await getLegacyPublicConfig(c.env);
  if (!cfg.enabled) return c.json({ status: "error", detail: "Public access is disabled" }, 401);
  const required = cfg.key;
  if (!required) return c.json({ status: "success" });
  if (bearer && bearer === required) return c.json({ status: "success" });
  return c.json({ status: "error", detail: "Unauthorized" }, 401);
});

openAiRoutes.get("/public/imagine/config", async (c) => {
  const settings = await getSettings(c.env);
  const nsfwDefault = String(settings.grok.filtered_tags ?? "").toLowerCase().includes("nsfw");
  return c.json({
    final_min_bytes: 100000,
    medium_min_bytes: 50000,
    nsfw: nsfwDefault,
  });
});

openAiRoutes.post("/public/imagine/start", async (c) => {
  const denied = await requireLegacyPublic(c);
  if (denied) return denied;

  const body = (await c.req.json()) as { prompt?: string; aspect_ratio?: string; nsfw?: boolean | null };
  const prompt = String(body?.prompt ?? "").trim();
  if (!prompt) return c.json({ detail: "Prompt cannot be empty" }, 400);

  const aspect_ratio = resolveImagineRatio(String(body?.aspect_ratio ?? "2:3"));
  const task_id = crypto.randomUUID().replace(/-/g, "");
  cleanupSessions(imagineSessions, IMAGINE_SESSION_TTL_MS);
  imagineSessions.set(task_id, {
    prompt,
    aspect_ratio,
    nsfw: typeof body?.nsfw === "boolean" ? body.nsfw : null,
    created_at: Date.now(),
  });

  return c.json({ task_id, aspect_ratio });
});

openAiRoutes.post("/public/imagine/stop", async (c) => {
  const denied = await requireLegacyPublic(c);
  if (denied) return denied;
  const body = (await c.req.json()) as { task_ids?: string[] };
  const taskIds = Array.isArray(body?.task_ids) ? body.task_ids : [];
  let removed = 0;
  for (const taskId of taskIds) {
    if (imagineSessions.delete(String(taskId))) removed += 1;
  }
  return c.json({ status: "success", removed });
});

openAiRoutes.get("/public/imagine/sse", async (c) => {
  const denied = await requireLegacyPublic(c);
  if (denied) return denied;

  const taskId = String(c.req.query("task_id") ?? "").trim();
  const session = getImagineSession(taskId);
  if (!session) return c.json({ detail: "Task not found" }, 404);

  const settingsBundle = await getSettings(c.env);
  const origin = new URL(c.req.url).origin;
  const chosen = await selectBestToken(c.env.DB, "grok-imagine-0.9");
  if (!chosen) return c.json({ error: "No available token" }, 503);

  const jwt = chosen.token;
  const cf = normalizeCfCookie(settingsBundle.grok.cf_clearance ?? "");
  const cookie = cf ? `sso-rw=${jwt};sso=${jwt};${cf}` : `sso-rw=${jwt};sso=${jwt}`;

  const { payload, referer } = buildConversationPayload({
    requestModel: "grok-imagine-0.9",
    content: session.prompt,
    imgIds: [],
    imgUris: [],
    settings: settingsBundle.grok,
  });

  (payload as any).enableImageStreaming = true;
  (payload as any).imageGenerationCount = 6;
  (payload as any).modelConfigOverride = {
    modelMap: {
      imageGenModelConfig: {
        aspectRatio: session.aspect_ratio,
        enableNsfw: session.nsfw ?? undefined,
      },
    },
  };

  const upstream = await sendConversationRequest({
    payload,
    cookie,
    settings: settingsBundle.grok,
    ...(referer ? { referer } : {}),
  });

  if (!upstream.ok || !upstream.body) {
    const txt = await upstream.text().catch(() => "");
    await recordTokenFailure(c.env.DB, jwt, upstream.status, txt.slice(0, 200));
    await applyCooldown(c.env.DB, jwt, upstream.status);
    return c.json({ detail: `upstream_${upstream.status}` }, 502);
  }

  const stream = new ReadableStream<Uint8Array>({
    start: async (controller) => {
      const encoder = new TextEncoder();
      const runId = crypto.randomUUID().replace(/-/g, "");
      let seq = 0;
      const sentFinal = new Set<string>();

      const emit = (obj: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      };

      emit({ type: "status", status: "running", prompt: session.prompt, aspect_ratio: session.aspect_ratio, run_id: runId });

      try {
        await consumeNdjson(upstream, async (data) => {
          const err = data.error as { message?: string } | undefined;
          if (err?.message) {
            emit({ type: "error", message: String(err.message), code: "upstream_error", run_id: runId });
            return;
          }

          const grok = (data as any).result?.response;
          if (!grok) return;

          const modelResp = grok.modelResponse;
          const list = Array.isArray(modelResp?.generatedImageUrls) ? modelResp.generatedImageUrls : [];
          for (const raw of list) {
            if (typeof raw !== "string" || !raw.trim()) continue;
            const imageId = `img_${base64UrlEncode(raw).slice(0, 16)}`;
            const payload = toProxyAssetUrl(raw, settingsBundle.global, origin);
            if (sentFinal.has(imageId)) continue;
            seq += 1;
            emit({
              type: "image_generation.completed",
              image_id: imageId,
              sequence: seq,
              url: payload,
              aspect_ratio: session.aspect_ratio,
              run_id: runId,
              stage: "final",
              created_at: Date.now(),
            });
            sentFinal.add(imageId);
          }
        });
      } catch (e) {
        emit({ type: "error", message: e instanceof Error ? e.message : String(e), code: "internal_error", run_id: runId });
      }

      emit({ type: "status", status: "stopped", run_id: runId });
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
      imagineSessions.delete(taskId);
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    },
  });
});

openAiRoutes.get("/public/imagine/ws", async (c) => {
  // 旧前端优先走 WS，Worker 侧退化为 SSE 可避免升级协议复杂度
  return c.redirect(`/v1/public/imagine/sse?${new URL(c.req.url).searchParams.toString()}`, 307);
});

openAiRoutes.post("/public/video/start", async (c) => {
  const denied = await requireLegacyPublic(c);
  if (denied) return denied;

  const body = (await c.req.json()) as {
    prompt?: string;
    aspect_ratio?: string;
    video_length?: number;
    resolution_name?: string;
    preset?: string;
    image_url?: string | null;
    reasoning_effort?: string | null;
  };

  const prompt = String(body?.prompt ?? "").trim();
  if (!prompt) return c.json({ detail: "Prompt cannot be empty" }, 400);

  const aspect_ratio = resolveVideoRatio(String(body?.aspect_ratio ?? "3:2"));
  const video_length = [6, 10, 15].includes(Number(body?.video_length)) ? Number(body?.video_length) : 6;
  const resolution_name = String(body?.resolution_name ?? "480p") === "720p" ? "720p" : "480p";
  const presetRaw = String(body?.preset ?? "normal");
  const preset: "fun" | "normal" | "spicy" | "custom" = ["fun", "normal", "spicy", "custom"].includes(presetRaw)
    ? (presetRaw as any)
    : "normal";
  const image_url = body?.image_url ? String(body.image_url).trim() : null;
  const reasoning_effort = body?.reasoning_effort ? String(body.reasoning_effort).trim() : null;

  const task_id = crypto.randomUUID().replace(/-/g, "");
  cleanupSessions(videoSessions, VIDEO_SESSION_TTL_MS);
  videoSessions.set(task_id, {
    prompt,
    aspect_ratio,
    video_length,
    resolution_name,
    preset,
    image_url,
    reasoning_effort,
    created_at: Date.now(),
  });

  return c.json({ task_id, aspect_ratio });
});

openAiRoutes.post("/public/video/stop", async (c) => {
  const denied = await requireLegacyPublic(c);
  if (denied) return denied;
  const body = (await c.req.json()) as { task_ids?: string[] };
  const taskIds = Array.isArray(body?.task_ids) ? body.task_ids : [];
  let removed = 0;
  for (const taskId of taskIds) {
    if (videoSessions.delete(String(taskId))) removed += 1;
  }
  return c.json({ status: "success", removed });
});

openAiRoutes.get("/public/video/sse", async (c) => {
  const denied = await requireLegacyPublic(c);
  if (denied) return denied;

  const taskId = String(c.req.query("task_id") ?? "").trim();
  const session = getVideoSession(taskId);
  if (!session) return c.json({ detail: "Task not found" }, 404);

  const settingsBundle = await getSettings(c.env);
  const origin = new URL(c.req.url).origin;
  const chosen = await selectBestToken(c.env.DB, "grok-imagine-0.9");
  if (!chosen) return c.json({ error: "No available token" }, 503);

  const jwt = chosen.token;
  const cf = normalizeCfCookie(settingsBundle.grok.cf_clearance ?? "");
  const cookie = cf ? `sso-rw=${jwt};sso=${jwt};${cf}` : `sso-rw=${jwt};sso=${jwt}`;

  let imgIds: string[] = [];
  let imgUris: string[] = [];
  let postId: string | undefined;
  if (session.image_url) {
    const uploaded = await uploadImage(session.image_url, cookie, settingsBundle.grok);
    if (uploaded.fileId) imgIds = [uploaded.fileId];
    if (uploaded.fileUri) imgUris = [uploaded.fileUri];
    if (imgUris.length) {
      const post = await createPost(imgUris[0]!, cookie, settingsBundle.grok);
      postId = post.postId || undefined;
    }
  }

  const { payload, referer } = buildConversationPayload({
    requestModel: "grok-imagine-0.9",
    content: session.prompt,
    imgIds,
    imgUris,
    ...(postId ? { postId } : {}),
    settings: settingsBundle.grok,
  });

  const modelConfigOverride = {
    modelMap: {
      videoGenModelConfig: {
        aspectRatio: session.aspect_ratio,
        resolutionName: session.resolution_name,
        videoLength: session.video_length,
        ...(postId ? { parentPostId: postId } : {}),
      },
    },
  };
  (payload as any).modelConfigOverride = modelConfigOverride;

  const modeMap: Record<string, string> = {
    fun: "--mode=extremely-crazy",
    normal: "--mode=normal",
    spicy: "--mode=extremely-spicy-or-crazy",
    custom: "--mode=custom",
  };
  (payload as any).message = `${session.prompt} ${modeMap[session.preset] ?? "--mode=normal"}`;

  const upstream = await sendConversationRequest({
    payload,
    cookie,
    settings: settingsBundle.grok,
    ...(referer ? { referer } : {}),
  });

  if (!upstream.ok || !upstream.body) {
    const txt = await upstream.text().catch(() => "");
    await recordTokenFailure(c.env.DB, jwt, upstream.status, txt.slice(0, 200));
    await applyCooldown(c.env.DB, jwt, upstream.status);
    return c.json({ detail: `upstream_${upstream.status}` }, 502);
  }

  const encoder = new TextEncoder();
  const sse = new ReadableStream<Uint8Array>({
    start: async (controller) => {
      const emitChunk = (data: Record<string, unknown>) => {
        const payloadOut = {
          id: `chatcmpl-${crypto.randomUUID()}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: "grok-imagine-0.9",
          choices: [
            {
              index: 0,
              delta: data,
              finish_reason: null,
            },
          ],
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payloadOut)}\n\n`));
      };

      let lastProgress = -1;
      let sawVideo = false;
      try {
        await consumeNdjson(upstream, async (line) => {
          const err = line.error as { message?: string } | undefined;
          if (err?.message) {
            emitChunk({ content: `错误：${String(err.message)}` });
            return;
          }
          const grok = (line as any).result?.response;
          if (!grok) return;

          const videoResp = grok.streamingVideoGenerationResponse;
          if (videoResp) {
            const progress = typeof videoResp.progress === "number" ? videoResp.progress : 0;
            if (progress > lastProgress) {
              lastProgress = progress;
              emitChunk({ content: `进度 ${progress}%` });
            }
            const videoUrl = typeof videoResp.videoUrl === "string" ? videoResp.videoUrl : "";
            if (videoUrl) {
              sawVideo = true;
              const path = videoUrl.replaceAll("/", "-");
              const proxy = `${(settingsBundle.global.base_url ?? "").trim() || origin}/images/${path}`;
              emitChunk({ content: `<video src="${proxy}" controls="controls" width="500" height="300"></video>\n` });
            }
          }
        });
      } catch (e) {
        emitChunk({ content: `错误：${e instanceof Error ? e.message : String(e)}` });
      }

      if (!sawVideo) emitChunk({ content: "生成结束，但未返回视频链接" });

      const done = {
        id: `chatcmpl-${crypto.randomUUID()}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: "grok-imagine-0.9",
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: "stop",
          },
        ],
      };
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(done)}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
      videoSessions.delete(taskId);
    },
  });

  return new Response(sse, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    },
  });
});

openAiRoutes.get("/public/voice/token", async (c) => {
  const denied = await requireLegacyPublic(c);
  if (denied) return denied;

  const voice = String(c.req.query("voice") ?? "ara");
  const personality = String(c.req.query("personality") ?? "assistant");
  const speed = Number(c.req.query("speed") ?? "1.0");

  const settings = await getSettings(c.env);
  const chosen = (await selectBestToken(c.env.DB, "grok-4-fast")) ?? (await selectBestToken(c.env.DB, "grok-4"));
  if (!chosen) return c.json({ error: "No available tokens for voice mode", code: "no_token" }, 503);

  const cf = normalizeCfCookie(settings.grok.cf_clearance ?? "");
  const cookie = cf ? `sso-rw=${chosen.token};sso=${chosen.token};${cf}` : `sso-rw=${chosen.token};sso=${chosen.token}`;
  const headers = getDynamicHeaders(settings.grok, "/rest/livekit/tokens");
  headers.Cookie = cookie;

  const payload = {
    sessionPayload: JSON.stringify({
      voice,
      personality,
      playback_speed: Number.isFinite(speed) ? speed : 1.0,
      enable_vision: false,
      turn_detection: { type: "server_vad" },
    }),
    requestAgentDispatch: false,
    livekitUrl: "wss://livekit.grok.com",
    params: { enable_markdown_transcript: "true" },
  };

  const upstream = await fetch("https://grok.com/rest/livekit/tokens", {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  if (!upstream.ok) {
    const txt = await upstream.text().catch(() => "");
    await recordTokenFailure(c.env.DB, chosen.token, upstream.status, txt.slice(0, 200));
    await applyCooldown(c.env.DB, chosen.token, upstream.status);
    return c.json({ error: `Voice token error: upstream_${upstream.status}`, code: "voice_error" }, 502);
  }

  const data = (await upstream.json().catch(() => ({}))) as Record<string, any>;
  const token = String(data.token ?? "").trim();
  if (!token) return c.json({ error: "Upstream returned no voice token", code: "upstream_error" }, 502);

  return c.json({ token, url: "wss://livekit.grok.com", participant_name: "", room_name: "" });
});

openAiRoutes.get("/admin/storage", async (c) => {
  const denied = await requireLegacyAdmin(c);
  if (denied) return denied;
  return c.json({ type: "d1" });
});

openAiRoutes.get("/admin/config", async (c) => {
  const denied = await requireLegacyAdmin(c);
  if (denied) return denied;
  const settings = await getSettings(c.env);
  return c.json(toLegacyConfig(settings));
});

openAiRoutes.post("/admin/config", async (c) => {
  const denied = await requireLegacyAdmin(c);
  if (denied) return denied;
  const body = (await c.req.json()) as Record<string, any>;
  const app = (body?.app ?? {}) as Record<string, any>;
  const proxy = (body?.proxy ?? {}) as Record<string, any>;
  const retry = (body?.retry ?? {}) as Record<string, any>;

  const globalConfig: Record<string, unknown> = {
    image_mode: app.image_format === "base64" ? "base64" : "url",
  };
  if (typeof app.app_url === "string") globalConfig.base_url = app.app_url;
  if (typeof app.app_key === "string") globalConfig.admin_password = app.app_key;
  if (typeof app.public_enabled === "boolean") globalConfig.public_enabled = app.public_enabled;
  if (typeof app.public_key === "string") globalConfig.public_key = app.public_key;

  const grokConfig: Record<string, unknown> = {};
  if (typeof app.api_key === "string") grokConfig.api_key = app.api_key;
  if (typeof proxy.base_proxy_url === "string") grokConfig.proxy_url = proxy.base_proxy_url;
  if (typeof proxy.asset_proxy_url === "string") grokConfig.cache_proxy_url = proxy.asset_proxy_url;
  if (typeof proxy.cf_clearance === "string") grokConfig.cf_clearance = proxy.cf_clearance;
  if (typeof app.dynamic_statsig === "boolean") grokConfig.dynamic_statsig = app.dynamic_statsig;
  if (typeof app.filter_tags === "string") grokConfig.filtered_tags = app.filter_tags;
  if (typeof app.thinking === "boolean") grokConfig.show_thinking = app.thinking;
  if (typeof app.temporary === "boolean") grokConfig.temporary = app.temporary;
  if (Array.isArray(retry.retry_status_codes)) grokConfig.retry_status_codes = retry.retry_status_codes;

  await saveSettings(c.env, {
    global_config: globalConfig as any,
    grok_config: grokConfig as any,
  });

  return c.json({ status: "success" });
});

openAiRoutes.get("/admin/tokens", async (c) => {
  const denied = await requireLegacyAdmin(c);
  if (denied) return denied;

  const rows = await listTokens(c.env.DB);
  const now = Date.now();
  const grouped: { ssoBasic: any[]; ssoSuper: any[] } = { ssoBasic: [], ssoSuper: [] };

  for (const row of rows) {
    const pool = toPoolName(row.token_type);
    const status = row.status === "expired" ? "expired" : row.cooldown_until && row.cooldown_until > now ? "cooling" : "active";
    grouped[pool].push({
      token: row.token,
      status,
      quota: row.remaining_queries,
      note: row.note ?? "",
      fail_count: row.failed_count ?? 0,
      use_count: 0,
      tags: parseTags(row.tags),
      created_at: row.created_time,
      last_fail_at: row.last_failure_time,
      last_fail_reason: row.last_failure_reason ?? "",
    });
  }

  return c.json(grouped);
});

openAiRoutes.post("/admin/tokens", async (c) => {
  const denied = await requireLegacyAdmin(c);
  if (denied) return denied;

  const body = (await c.req.json()) as Record<string, any[]>;
  const desiredByType: Record<"sso" | "ssoSuper", any[]> = { sso: [], ssoSuper: [] };
  for (const [pool, list] of Object.entries(body ?? {})) {
    const tokenType = toTokenType(pool);
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const token = String((item as any)?.token ?? "").trim();
      if (!token) continue;
      desiredByType[tokenType].push(item);
    }
  }

  const existing = await listTokens(c.env.DB);
  for (const tokenType of ["sso", "ssoSuper"] as const) {
    const existingByType = existing.filter((r) => r.token_type === tokenType).map((r) => r.token);
    const desiredByTypeTokens = new Set(desiredByType[tokenType].map((x) => String((x as any).token)));
    const toDelete = existingByType.filter((t) => !desiredByTypeTokens.has(t));
    const toAdd = [...desiredByTypeTokens].filter((t) => !existingByType.includes(t));

    if (toDelete.length) await deleteTokens(c.env.DB, toDelete, tokenType);
    if (toAdd.length) await addTokens(c.env.DB, toAdd, tokenType);
  }

  for (const tokenType of ["sso", "ssoSuper"] as const) {
    for (const item of desiredByType[tokenType]) {
      const token = String((item as any)?.token ?? "").trim();
      if (!token) continue;
      const note = String((item as any)?.note ?? "");
      const tags = Array.isArray((item as any)?.tags) ? (item as any).tags.map((x: any) => String(x)) : [];
      const quota = Number((item as any)?.quota);
      await updateTokenNote(c.env.DB, token, tokenType, note);
      await updateTokenTags(c.env.DB, token, tokenType, tags);
      if (Number.isFinite(quota)) {
        await updateTokenLimits(
          c.env.DB,
          token,
          tokenType === "ssoSuper"
            ? { remaining_queries: Math.floor(quota), heavy_remaining_queries: Math.floor(quota) }
            : { remaining_queries: Math.floor(quota) },
        );
      }
    }
  }

  return c.json({ status: "success" });
});

openAiRoutes.post("/admin/tokens/refresh", async (c) => {
  const denied = await requireLegacyAdmin(c);
  if (denied) return denied;
  const body = (await c.req.json()) as { token?: string };
  const token = String(body?.token ?? "").trim();
  if (!token) return c.json({ status: "error", detail: "missing_token" }, 400);

  const rows = await listTokens(c.env.DB);
  const row = rows.find((r) => r.token === token);
  if (!row) return c.json({ status: "success", results: { [token]: false } });

  const settings = await getSettings(c.env);
  const refreshed = await refreshTokenQuota(c.env, settings, row);
  return c.json({
    status: "success",
    results: { [token]: refreshed.ok },
    ...(refreshed.ok ? {} : { detail: refreshed.detail ?? "refresh_failed" }),
  });
});

openAiRoutes.post("/admin/tokens/refresh/async", async (c) => {
  const denied = await requireLegacyAdmin(c);
  if (denied) return denied;
  const body = (await c.req.json()) as { tokens?: string[] };
  const rows = await listTokens(c.env.DB);
  const requested = Array.isArray(body?.tokens) ? body.tokens.map((t) => String(t ?? "").trim()).filter(Boolean) : [];
  const targetRows = requested.length ? rows.filter((r) => requested.includes(r.token)) : rows;
  const settings = await getSettings(c.env);

  const results: Record<string, boolean> = {};
  for (const row of targetRows) {
    const refreshed = await refreshTokenQuota(c.env, settings, row);
    results[row.token] = refreshed.ok;
  }

  const taskId = createLegacyTask("tokens-refresh", targetRows.length, { results });
  return c.json({ status: "success", task_id: taskId });
});

openAiRoutes.post("/admin/tokens/nsfw/enable/async", async (c) => {
  const denied = await requireLegacyAdmin(c);
  if (denied) return denied;
  const body = (await c.req.json()) as { tokens?: string[] };
  const targets = Array.isArray(body?.tokens)
    ? body.tokens.map((t) => String(t ?? "").trim()).filter(Boolean)
    : [];

  const rows = await listTokens(c.env.DB);
  let ok = 0;
  let fail = 0;
  const details: Record<string, { status: "success" | "error"; detail?: string }> = {};

  for (const token of targets) {
    const matched = rows.filter((r) => r.token === token);
    if (!matched.length) {
      fail += 1;
      details[token] = { status: "error", detail: "token_not_found" };
      continue;
    }

    try {
      for (const row of matched) {
        const tags = parseTags(row.tags);
        if (!tags.includes("nsfw")) tags.push("nsfw");
        await updateTokenTags(c.env.DB, row.token, row.token_type, tags);
      }
      ok += 1;
      details[token] = { status: "success" };
    } catch (e) {
      fail += 1;
      details[token] = { status: "error", detail: e instanceof Error ? e.message : String(e) };
    }
  }

  const taskId = createLegacyTask("tokens-nsfw", targets.length, {
    summary: { ok, fail },
    results: details,
  });
  return c.json({ status: "success", task_id: taskId });
});

openAiRoutes.get("/admin/cache", async (c) => {
  const denied = await requireLegacyAdmin(c);
  if (denied) return denied;
  const scope = c.req.query("scope") === "all" ? "all" : c.req.query("tokens") ? "selected" : c.req.query("token") ? "selected" : "none";
  const token = String(c.req.query("token") ?? "");
  const data = await buildLegacyCacheStats(c.env, scope as "all" | "selected" | "none", token);
  return c.json(data);
});

openAiRoutes.get("/admin/cache/list", async (c) => {
  const denied = await requireLegacyAdmin(c);
  if (denied) return denied;

  const t = (c.req.query("type") ?? "image").toLowerCase();
  const type: CacheType = t === "video" ? "video" : "image";
  const page = Math.max(1, Number(c.req.query("page") ?? 1));
  const pageSize = Math.max(1, Math.min(2000, Number(c.req.query("page_size") ?? 1000)));
  const offset = (page - 1) * pageSize;
  const { total, items } = await listCacheRowsByType(c.env.DB, type, pageSize, offset);

  return c.json({
    items: items.map((it) => {
      const name = it.key.startsWith(`${type}/`) ? it.key.slice(type.length + 1) : it.key;
      return {
        name,
        size_bytes: it.size,
        mtime_ms: it.last_access_at || it.created_at,
        preview_url: type === "image" ? `/images/${name}` : null,
      };
    }),
    total,
    page,
    page_size: pageSize,
  });
});

openAiRoutes.post("/admin/cache/item/delete", async (c) => {
  const denied = await requireLegacyAdmin(c);
  if (denied) return denied;
  const body = (await c.req.json()) as { type?: string; name?: string };
  const type: CacheType = String(body?.type ?? "image").toLowerCase() === "video" ? "video" : "image";
  const name = String(body?.name ?? "").trim();
  if (!name) return c.json({ status: "error", detail: "missing_name" }, 400);
  const key = `${type}/${name}`;
  await c.env.KV_CACHE.delete(key);
  await deleteCacheRow(c.env.DB, key);
  return c.json({ status: "success" });
});

openAiRoutes.post("/admin/cache/clear", async (c) => {
  const denied = await requireLegacyAdmin(c);
  if (denied) return denied;
  const before = await getCacheSizeBytes(c.env.DB);
  const body = (await c.req.json().catch(() => ({}))) as { type?: string };
  const type = String(body?.type ?? "").toLowerCase();
  if (type === "image") await clearKvCacheByType(c.env, "image");
  else if (type === "video") await clearKvCacheByType(c.env, "video");
  else {
    await clearKvCacheByType(c.env, "image");
    await clearKvCacheByType(c.env, "video");
  }
  const after = await getCacheSizeBytes(c.env.DB);
  const releasedMb = Math.max(0, (before.total - after.total) / 1024 / 1024);
  return c.json({ status: "success", result: { size_mb: Number(releasedMb.toFixed(2)) } });
});

openAiRoutes.post("/admin/cache/online/load/async", async (c) => {
  const denied = await requireLegacyAdmin(c);
  if (denied) return denied;
  const body = (await c.req.json()) as { tokens?: string[] };
  const allRows = await listTokens(c.env.DB);
  const requested = Array.isArray(body?.tokens) ? body.tokens.map((t) => String(t ?? "").trim()).filter(Boolean) : [];
  const tokens = requested.length ? requested : allRows.map((r) => r.token);
  const settings = await getSettings(c.env);

  const { details, total } = await buildOnlineDetails(c.env, settings, tokens);
  const stats = await buildLegacyCacheStats(c.env, tokens.length ? "selected" : "all");
  const summary = onlineSummaryFromDetails(details);
  const result = {
    ...stats,
    online: {
      ...stats.online,
      count: summary.count,
      status: summary.status,
      last_asset_clear_at: summary.last_asset_clear_at,
    },
    online_details: details,
    online_scope: tokens.length === allRows.length ? "all" : "selected",
  };

  const taskId = createLegacyTask("cache-online-load", tokens.length, {
    ...result,
    online: {
      ...result.online,
      count: total,
    },
  });
  return c.json({ status: "success", task_id: taskId });
});

openAiRoutes.post("/admin/cache/online/clear/async", async (c) => {
  const denied = await requireLegacyAdmin(c);
  if (denied) return denied;
  const body = (await c.req.json()) as { tokens?: string[] };
  const allRows = await listTokens(c.env.DB);
  const requested = Array.isArray(body?.tokens) ? body.tokens.map((t) => String(t ?? "").trim()).filter(Boolean) : [];
  const tokens = requested.length ? requested : allRows.map((r) => r.token);
  const settings = await getSettings(c.env);
  const results: Record<string, { status: string; success?: number; failed?: number; error?: string }> = {};

  for (const token of tokens) {
    try {
      const assetIds = await listRemoteAssetIds(c.env, token, settings);
      const cleared = await clearRemoteAssets(c.env, token, assetIds, settings);
      results[token] = { status: cleared.failed > 0 ? "partial" : "success", success: cleared.success, failed: cleared.failed };
      onlineAssetState.set(token, { count: 0, status: cleared.failed > 0 ? "error: partial_clear_failed" : "ok" });
    } catch (e) {
      results[token] = { status: "error", error: e instanceof Error ? e.message : String(e) };
      onlineAssetState.set(token, { count: 0, status: `error: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  const taskId = createLegacyTask("cache-online-clear", tokens.length, { results });
  return c.json({ status: "success", task_id: taskId });
});

openAiRoutes.post("/admin/cache/online/clear", async (c) => {
  const denied = await requireLegacyAdmin(c);
  if (denied) return denied;
  const body = (await c.req.json().catch(() => ({}))) as { token?: string };
  const token = String(body?.token ?? "").trim();
  if (!token) return c.json({ status: "error", detail: "missing_token" }, 400);

  const settings = await getSettings(c.env);
  try {
    const assetIds = await listRemoteAssetIds(c.env, token, settings);
    const result = await clearRemoteAssets(c.env, token, assetIds, settings);
    onlineAssetState.set(token, { count: 0, status: result.failed > 0 ? "error: partial_clear_failed" : "ok" });
    return c.json({ status: "success", result });
  } catch (e) {
    return c.json(
      {
        status: "error",
        detail: e instanceof Error ? e.message : String(e),
        result: { success: 0, failed: 0 },
      },
      500,
    );
  }
});

openAiRoutes.get("/admin/batch/:taskId/stream", async (c) => {
  const denied = await requireLegacyAdmin(c);
  if (denied) return denied;
  const taskId = c.req.param("taskId");
  const task = legacyBatchTasks.get(taskId) ?? { kind: "unknown", total: 0 };
  const snapshot = { type: "snapshot", total: task.total, processed: 0 };
  const done = { type: "done", total: task.total, processed: task.total, result: task.result ?? {} };
  legacyBatchTasks.delete(taskId);
  return new Response(`data: ${JSON.stringify(snapshot)}\n\ndata: ${JSON.stringify(done)}\n\n`, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
});

openAiRoutes.post("/admin/batch/:taskId/cancel", async (c) => {
  const denied = await requireLegacyAdmin(c);
  if (denied) return denied;
  const taskId = c.req.param("taskId");
  legacyBatchTasks.delete(taskId);
  return c.json({ status: "success" });
});

openAiRoutes.use("/*", requireApiAuth);

openAiRoutes.get("/models", async (c) => {
  const ts = Math.floor(Date.now() / 1000);
  const data = Object.entries(MODEL_CONFIG).map(([id, cfg]) => ({
    id,
    object: "model",
    created: ts,
    owned_by: "x-ai",
    display_name: cfg.display_name,
    description: cfg.description,
    raw_model_path: cfg.raw_model_path,
    default_temperature: cfg.default_temperature,
    default_max_output_tokens: cfg.default_max_output_tokens,
    supported_max_output_tokens: cfg.supported_max_output_tokens,
    default_top_p: cfg.default_top_p,
  }));
  return c.json({ object: "list", data });
});

openAiRoutes.get("/models/:modelId", async (c) => {
  const modelId = c.req.param("modelId");
  if (!isValidModel(modelId)) return c.json(openAiError(`Model '${modelId}' not found`, "model_not_found"), 404);
  const cfg = MODEL_CONFIG[modelId]!;
  const ts = Math.floor(Date.now() / 1000);
  return c.json({
    id: modelId,
    object: "model",
    created: ts,
    owned_by: "x-ai",
    display_name: cfg.display_name,
    description: cfg.description,
    raw_model_path: cfg.raw_model_path,
    default_temperature: cfg.default_temperature,
    default_max_output_tokens: cfg.default_max_output_tokens,
    supported_max_output_tokens: cfg.supported_max_output_tokens,
    default_top_p: cfg.default_top_p,
  });
});

openAiRoutes.post("/chat/completions", async (c) => {
  const start = Date.now();
  const ip = getClientIp(c.req.raw);
  const keyName = c.get("apiAuth").name ?? "Unknown";

  const origin = new URL(c.req.url).origin;

  let requestedModel = "";
  try {
    const body = (await c.req.json()) as {
      model?: string;
      messages?: any[];
      stream?: boolean;
    };

    requestedModel = String(body.model ?? "");
    if (!requestedModel) return c.json(openAiError("Missing 'model'", "missing_model"), 400);
    if (!Array.isArray(body.messages)) return c.json(openAiError("Missing 'messages'", "missing_messages"), 400);
    if (!isValidModel(requestedModel))
      return c.json(openAiError(`Model '${requestedModel}' not supported`, "model_not_supported"), 400);

    const settingsBundle = await getSettings(c.env);

    const retryCodes = Array.isArray(settingsBundle.grok.retry_status_codes)
      ? settingsBundle.grok.retry_status_codes
      : [401, 429];

    const stream = Boolean(body.stream);
    const maxRetry = 3;
    let lastErr: string | null = null;

    for (let attempt = 0; attempt < maxRetry; attempt++) {
      const chosen = await selectBestToken(c.env.DB, requestedModel);
      if (!chosen) return c.json(openAiError("No available token", "NO_AVAILABLE_TOKEN"), 503);

      const jwt = chosen.token;
      const cf = normalizeCfCookie(settingsBundle.grok.cf_clearance ?? "");
      const cookie = cf ? `sso-rw=${jwt};sso=${jwt};${cf}` : `sso-rw=${jwt};sso=${jwt}`;

      const { content, images } = extractContent(body.messages as any);
      const cfg = MODEL_CONFIG[requestedModel]!;
      const isVideoModel = Boolean(cfg.is_video_model);
      const imgInputs = isVideoModel && images.length > 1 ? images.slice(0, 1) : images;

      try {
        const uploads = await mapLimit(imgInputs, 5, (u) => uploadImage(u, cookie, settingsBundle.grok));
        const imgIds = uploads.map((u) => u.fileId).filter(Boolean);
        const imgUris = uploads.map((u) => u.fileUri).filter(Boolean);

        let postId: string | undefined;
        if (isVideoModel && imgUris.length) {
          const post = await createPost(imgUris[0]!, cookie, settingsBundle.grok);
          postId = post.postId || undefined;
        }

        const { payload, referer } = buildConversationPayload({
          requestModel: requestedModel,
          content,
          imgIds,
          imgUris,
          ...(postId ? { postId } : {}),
          settings: settingsBundle.grok,
        });

        const upstream = await sendConversationRequest({
          payload,
          cookie,
          settings: settingsBundle.grok,
          ...(referer ? { referer } : {}),
        });

        if (!upstream.ok) {
          const txt = await upstream.text().catch(() => "");
          lastErr = `Upstream ${upstream.status}: ${txt.slice(0, 200)}`;
          await recordTokenFailure(c.env.DB, jwt, upstream.status, txt.slice(0, 200));
          await applyCooldown(c.env.DB, jwt, upstream.status);
          if (retryCodes.includes(upstream.status) && attempt < maxRetry - 1) continue;
          break;
        }

        if (stream) {
          const sse = createOpenAiStreamFromGrokNdjson(upstream, {
            cookie,
            settings: settingsBundle.grok,
            global: settingsBundle.global,
            origin,
            onFinish: async ({ status, duration }) => {
              await addRequestLog(c.env.DB, {
                ip,
                model: requestedModel,
                duration: Number(duration.toFixed(2)),
                status,
                key_name: keyName,
                token_suffix: jwt.slice(-6),
                error: status === 200 ? "" : "stream_error",
              });
            },
          });

          return new Response(sse, {
            status: 200,
            headers: {
              "Content-Type": "text/event-stream; charset=utf-8",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
              "X-Accel-Buffering": "no",
              "Access-Control-Allow-Origin": "*",
            },
          });
        }

        const json = await parseOpenAiFromGrokNdjson(upstream, {
          cookie,
          settings: settingsBundle.grok,
          global: settingsBundle.global,
          origin,
          requestedModel,
        });

        const duration = (Date.now() - start) / 1000;
        await addRequestLog(c.env.DB, {
          ip,
          model: requestedModel,
          duration: Number(duration.toFixed(2)),
          status: 200,
          key_name: keyName,
          token_suffix: jwt.slice(-6),
          error: "",
        });

        return c.json(json);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        lastErr = msg;
        await recordTokenFailure(c.env.DB, jwt, 500, msg);
        await applyCooldown(c.env.DB, jwt, 500);
        if (attempt < maxRetry - 1) continue;
      }
    }

    const duration = (Date.now() - start) / 1000;
    await addRequestLog(c.env.DB, {
      ip,
      model: requestedModel,
      duration: Number(duration.toFixed(2)),
      status: 500,
      key_name: keyName,
      token_suffix: "",
      error: lastErr ?? "unknown_error",
    });

    return c.json(openAiError(lastErr ?? "Upstream error", "upstream_error"), 500);
  } catch (e) {
    const duration = (Date.now() - start) / 1000;
    await addRequestLog(c.env.DB, {
      ip,
      model: requestedModel || "unknown",
      duration: Number(duration.toFixed(2)),
      status: 500,
      key_name: keyName,
      token_suffix: "",
      error: e instanceof Error ? e.message : String(e),
    });
    return c.json(openAiError("Internal error", "internal_error"), 500);
  }
});

openAiRoutes.options("/*", (c) => c.body(null, 204));
