import { Hono } from "hono";
import type { Env } from "../env";
import { getSettings, normalizeCfCookie } from "../settings";
import { applyCooldown, recordTokenFailure, selectBestToken } from "../repo/tokens";
import { getDynamicHeaders } from "../grok/headers";
import { deleteCacheRow, touchCacheRow, upsertCacheRow, type CacheType } from "../repo/r2Cache";
import { nowMs } from "../utils/time";

export const mediaRoutes = new Hono<{ Bindings: Env }>();

function guessCacheSeconds(path: string): number {
  const lower = path.toLowerCase();
  if (lower.endsWith(".mp4") || lower.endsWith(".webm") || lower.endsWith(".mov")) return 60 * 60 * 24;
  return 60 * 60 * 24;
}

function detectTypeByPath(path: string): CacheType {
  const lower = path.toLowerCase();
  if (lower.endsWith(".mp4") || lower.endsWith(".webm") || lower.endsWith(".mov") || lower.endsWith(".avi"))
    return "video";
  return "image";
}

function r2Key(type: CacheType, imgPath: string): string {
  return `${type}/${imgPath}`;
}

function contentRangeFromR2(obj: R2Object): { start: number; end: number; length: number } | null {
  const r = obj.range;
  if (!r) return null;

  const size = obj.size;
  if ("suffix" in r) {
    const length = Math.min(size, r.suffix);
    const start = Math.max(0, size - length);
    const end = Math.max(0, size - 1);
    return { start, end, length };
  }

  const start = r.offset ?? 0;
  const end = r.length !== undefined ? Math.min(size - 1, start + r.length - 1) : size - 1;
  const length = Math.max(0, end - start + 1);
  return { start, end, length };
}

function responseFromR2(obj: R2ObjectBody, opts: { cacheSeconds: number }): Response {
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("ETag", obj.httpEtag);
  headers.set("Accept-Ranges", "bytes");
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Cache-Control", `public, max-age=${opts.cacheSeconds}`);

  const cr = contentRangeFromR2(obj);
  if (cr) {
    headers.set("Content-Range", `bytes ${cr.start}-${cr.end}/${obj.size}`);
    headers.set("Content-Length", String(cr.length));
    return new Response(obj.body, { status: 206, headers });
  }

  headers.set("Content-Length", String(obj.size));
  return new Response(obj.body, { status: 200, headers });
}

function toUpstreamHeaders(args: { pathname: string; cookie: string; settings: Awaited<ReturnType<typeof getSettings>>["grok"] }): Record<string, string> {
  const headers = getDynamicHeaders(args.settings, args.pathname);
  headers.Cookie = args.cookie;
  delete headers["Content-Type"];
  headers.Accept =
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";
  headers["Sec-Fetch-Dest"] = "document";
  headers["Sec-Fetch-Mode"] = "navigate";
  headers["Sec-Fetch-Site"] = "same-site";
  headers["Sec-Fetch-User"] = "?1";
  headers["Upgrade-Insecure-Requests"] = "1";
  headers.Referer = "https://grok.com/";
  return headers;
}

mediaRoutes.get("/images/:imgPath{.+}", async (c) => {
  const imgPath = c.req.param("imgPath");
  const originalPath = `/${imgPath.replaceAll("-", "/")}`;
  const url = new URL(`https://assets.grok.com${originalPath}`);
  const type = detectTypeByPath(originalPath);
  const key = r2Key(type, imgPath);
  const cacheSeconds = guessCacheSeconds(originalPath);

  // 1) Try R2 cache first (supports Range when passing request headers)
  const rangeHeader = c.req.header("Range");
  const cachedObj = await c.env.R2_CACHE.get(key, rangeHeader ? { range: c.req.raw.headers } : undefined);
  if (cachedObj) {
    c.executionCtx.waitUntil(touchCacheRow(c.env.DB, key, nowMs()));
    return responseFromR2(cachedObj, { cacheSeconds });
  }

  // stale metadata cleanup (best-effort)
  c.executionCtx.waitUntil(deleteCacheRow(c.env.DB, key));

  const settingsBundle = await getSettings(c.env);
  const chosen = await selectBestToken(c.env.DB, "grok-4-fast");
  if (!chosen) return c.text("No available token", 503);

  const cf = normalizeCfCookie(settingsBundle.grok.cf_clearance ?? "");
  const cookie = cf ? `sso-rw=${chosen.token};sso=${chosen.token};${cf}` : `sso-rw=${chosen.token};sso=${chosen.token}`;

  const baseHeaders = toUpstreamHeaders({ pathname: originalPath, cookie, settings: settingsBundle.grok });

  // 2) If Range request and cache miss: serve range from upstream immediately,
  // and warm the full object to R2 in background (avoid caching partial objects).
  if (rangeHeader && type === "video") {
    c.executionCtx.waitUntil(
      (async () => {
        try {
          const full = await fetch(url.toString(), { headers: baseHeaders });
          if (!full.ok || !full.body) return;

          const ct = full.headers.get("content-type") ?? "";
          const stream = full.body;
          const counted = new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              controller.enqueue(chunk);
            },
          });
          const pass = stream.pipeThrough(counted);

          const httpMetadata = ct
            ? { contentType: ct, cacheControl: `public, max-age=${cacheSeconds}` }
            : { cacheControl: `public, max-age=${cacheSeconds}` };
          const put = await c.env.R2_CACHE.put(key, pass, { httpMetadata });
          const now = nowMs();
          await upsertCacheRow(c.env.DB, {
            key,
            type,
            size: put.size,
            etag: put.etag,
            content_type: ct,
            created_at: now,
            last_access_at: now,
          });
        } catch {
          // ignore warm errors
        }
      })(),
    );

    const rangeResp = await fetch(url.toString(), { headers: { ...baseHeaders, Range: rangeHeader } });
    if (!rangeResp.ok) {
      await recordTokenFailure(c.env.DB, chosen.token, rangeResp.status, await rangeResp.text().catch(() => ""));
      await applyCooldown(c.env.DB, chosen.token, rangeResp.status);
      return new Response(`Upstream ${rangeResp.status}`, { status: rangeResp.status });
    }

    const outHeaders = new Headers(rangeResp.headers);
    outHeaders.set("Access-Control-Allow-Origin", "*");
    outHeaders.set("Cache-Control", `public, max-age=${cacheSeconds}`);
    return new Response(rangeResp.body, { status: rangeResp.status, headers: outHeaders });
  }

  // 3) Normal miss: fetch once, tee to (R2 put) + (client response), and record metadata
  const upstream = await fetch(url.toString(), { headers: baseHeaders });
  if (!upstream.ok || !upstream.body) {
    const txt = await upstream.text().catch(() => "");
    await recordTokenFailure(c.env.DB, chosen.token, upstream.status, txt.slice(0, 200));
    await applyCooldown(c.env.DB, chosen.token, upstream.status);
    return new Response(`Upstream ${upstream.status}`, { status: upstream.status });
  }

  const contentType = upstream.headers.get("content-type") ?? "";
  let byteCount = 0;
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      byteCount += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
  const counted = upstream.body.pipeThrough(counter);
  const [toR2, toClient] = counted.tee();

  c.executionCtx.waitUntil(
    (async () => {
      try {
        const httpMetadata = contentType
          ? { contentType, cacheControl: `public, max-age=${cacheSeconds}` }
          : { cacheControl: `public, max-age=${cacheSeconds}` };
        const put = await c.env.R2_CACHE.put(key, toR2, { httpMetadata });
        const now = nowMs();
        await upsertCacheRow(c.env.DB, {
          key,
          type,
          size: put.size || byteCount,
          etag: put.etag,
          content_type: contentType,
          created_at: now,
          last_access_at: now,
        });
      } catch {
        // ignore write errors
      }
    })(),
  );

  const outHeaders = new Headers(upstream.headers);
  outHeaders.set("Access-Control-Allow-Origin", "*");
  outHeaders.set("Cache-Control", `public, max-age=${cacheSeconds}`);
  if (contentType) outHeaders.set("Content-Type", contentType);
  return new Response(toClient, { status: 200, headers: outHeaders });
});
