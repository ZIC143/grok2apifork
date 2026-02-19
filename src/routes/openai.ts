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
  const appKey = String(settings.grok.api_key ?? "").trim();
  const fallback = String(settings.global.admin_password ?? "").trim();
  return appKey || fallback;
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
      app_key: settings.grok.api_key ?? "",
      public_enabled: true,
      public_key: "",
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
      count: 0,
      status: "not_loaded",
      token,
      last_asset_clear_at: null,
    },
    online_accounts: [],
    online_details: [],
    online_scope: scope,
  };
}

const legacyBatchTasks = new Map<string, { kind: string; total: number; result?: Record<string, unknown> }>();

function createLegacyTask(kind: string, total: number, result?: Record<string, unknown>): string {
  const taskId = crypto.randomUUID();
  if (result) legacyBatchTasks.set(taskId, { kind, total: Math.max(0, total), result });
  else legacyBatchTasks.set(taskId, { kind, total: Math.max(0, total) });
  return taskId;
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
  const authHeader = c.req.header("Authorization");
  if (!authHeader) return c.json({ error: "Missing Authorization header" }, 401);
  
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();
  if (!token) return c.json({ error: "Invalid Authorization format" }, 401);
  
  const settings = await getSettings(c.env);
  const apiKey = (settings.grok.api_key ?? "").trim();
  
  if (!apiKey) {
    // If no API key is configured, deny access to admin panel
    return c.json({ error: "Admin access not configured" }, 401);
  }
  
  if (token === apiKey) {
    return c.json({ success: true }, 200);
  }
  
  return c.json({ error: "Invalid app_key" }, 401);
});

openAiRoutes.get("/public/verify", async (c) => {
  const bearer = parseBearer(c.req.header("Authorization") ?? null);
  const settings = await getSettings(c.env);
  const required = String(settings.grok.api_key ?? "").trim();
  if (!required) return c.json({ status: "success" });
  if (bearer && bearer === required) return c.json({ status: "success" });
  return c.json({ status: "error", detail: "Unauthorized" }, 401);
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

  const grokConfig: Record<string, unknown> = {};
  if (typeof app.app_key === "string") grokConfig.api_key = app.app_key;
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
  return c.json({ status: "success", results: token ? { [token]: true } : {} });
});

openAiRoutes.post("/admin/tokens/refresh/async", async (c) => {
  const denied = await requireLegacyAdmin(c);
  if (denied) return denied;
  const body = (await c.req.json()) as { tokens?: string[] };
  const taskId = createLegacyTask("tokens-refresh", Array.isArray(body?.tokens) ? body.tokens.length : 0);
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
  const scope = c.req.query("scope") === "all" ? "all" : c.req.query("tokens") ? "selected" : "none";
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
  const result = await buildLegacyCacheStats(c.env, "selected");
  const taskId = createLegacyTask("cache-online-load", Array.isArray(body?.tokens) ? body.tokens.length : 0, result);
  return c.json({ status: "success", task_id: taskId });
});

openAiRoutes.post("/admin/cache/online/clear/async", async (c) => {
  const denied = await requireLegacyAdmin(c);
  if (denied) return denied;
  const body = (await c.req.json()) as { tokens?: string[] };
  const results: Record<string, { status: string }> = {};
  for (const token of Array.isArray(body?.tokens) ? body.tokens : []) results[String(token)] = { status: "success" };
  const taskId = createLegacyTask("cache-online-clear", Object.keys(results).length, { results });
  return c.json({ status: "success", task_id: taskId });
});

openAiRoutes.post("/admin/cache/online/clear", async (c) => {
  const denied = await requireLegacyAdmin(c);
  if (denied) return denied;
  return c.json({ status: "success", result: { success: 0, failed: 0 } });
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
