export function nowMs(): number {
  return Date.now();
}

export function normalizeEpochSeconds(value: number | string | null | undefined): number {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n >= 1e12 ? Math.floor(n / 1000) : Math.floor(n);
}

export function formatUtcSeconds(seconds: number): string {
  const d = new Date(seconds * 1000);
  return d.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}

export function formatUtcMs(ms: number): string {
  const d = new Date(ms);
  return d.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}

