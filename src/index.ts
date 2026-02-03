import { Hono } from "hono";
import type { Env } from "./env";
import { openAiRoutes } from "./routes/openai";
import { mediaRoutes } from "./routes/media";
import { adminRoutes } from "./routes/admin";
import { runKvDailyClear } from "./kv/cleanup";

const app = new Hono<{ Bindings: Env }>();

function getAssets(env: Env): Fetcher | null {
  const anyEnv = env as unknown as { ASSETS?: unknown };
  const assets = anyEnv.ASSETS as { fetch?: unknown } | undefined;
  return assets && typeof assets.fetch === "function" ? (assets as Fetcher) : null;
}

function isDebugRequest(c: any): boolean {
  try {
    return new URL(c.req.url).searchParams.get("debug") === "1";
  } catch {
    return false;
  }
}

function assetFetchError(message: string): Response {
  return new Response(message, {
    status: 500,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

async function fetchAsset(c: any, pathname: string): Promise<Response> {
  const assets = getAssets(c.env as Env);
  if (!assets) {
    console.error("ASSETS binding missing: check wrangler.toml assets binding");
    return assetFetchError(
      'Internal Server Error: missing ASSETS binding. Check `wrangler.toml` `assets = { directory = \"./app/template\", binding = \"ASSETS\" }` and redeploy.',
    );
  }

  const url = new URL(c.req.url);
  url.pathname = pathname;
  try {
    return await assets.fetch(new Request(url.toString(), c.req.raw));
  } catch (err) {
    console.error(`ASSETS fetch failed (${pathname}):`, err);
    const detail = isDebugRequest(c) ? `\n\n${err instanceof Error ? err.stack || err.message : String(err)}` : "";
    return assetFetchError(`Internal Server Error: failed to fetch asset ${pathname}.${detail}`);
  }
}

app.onError((err, c) => {
  console.error("Unhandled error:", err);
  const detail = isDebugRequest(c) ? `\n\n${err instanceof Error ? err.stack || err.message : String(err)}` : "";
  return c.text(`Internal Server Error${detail}`, 500);
});

app.route("/v1", openAiRoutes);
app.route("/", mediaRoutes);
app.route("/", adminRoutes);

app.get("/_worker.js", (c) => c.notFound());

app.get("/", (c) => c.redirect("/login", 302));

app.get("/login", (c) => fetchAsset(c, "/login.html"));

app.get("/manage", (c) => fetchAsset(c, "/admin.html"));

app.get("/static/*", (c) => {
  const url = new URL(c.req.url);
  if (url.pathname === "/static/_worker.js") return c.notFound();
  url.pathname = url.pathname.replace(/^\/static\//, "/");
  return fetchAsset(c, url.pathname);
});

app.get("/health", (c) =>
  c.json({
    status: "healthy",
    service: "Grok2API",
    runtime: "cloudflare-workers",
    bindings: {
      db: Boolean((c.env as any)?.DB),
      kv_cache: Boolean((c.env as any)?.KV_CACHE),
      assets: Boolean(getAssets(c.env as any)),
    },
  }),
);

app.notFound((c) => {
  const assets = getAssets(c.env as any);
  // Avoid calling c.notFound() here because it will invoke this handler again.
  if (!assets) return c.text("Not Found", 404);
  try {
    return assets.fetch(c.req.raw);
  } catch (err) {
    console.error("ASSETS fetch failed (notFound):", err);
    const detail = isDebugRequest(c) ? `\n\n${err instanceof Error ? err.stack || err.message : String(err)}` : "";
    return c.text(`Internal Server Error${detail}`, 500);
  }
});

const handler: ExportedHandler<Env> = {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
  scheduled: (_event, env, ctx) => {
    ctx.waitUntil(runKvDailyClear(env));
  },
};

export default handler;
