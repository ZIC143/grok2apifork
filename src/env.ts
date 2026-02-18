export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  R2_CACHE: R2Bucket;

  // Optional vars via wrangler.toml [vars]
  R2_CACHE_TTL_DAYS?: string;
  R2_CLEANUP_BATCH?: string;
}
