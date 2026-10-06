/** Outbound HTTP helper: timeout, user agent, small in-memory TTL cache, readable upstream errors. */

export const USER_AGENT = "meshvault-connectors/0.1 (+https://github.com/thefiredev-cloud/meshvault-connectors)";

export class UpstreamError extends Error {
  constructor(
    public readonly service: string,
    public readonly status: number,
    message: string,
  ) {
    super(`${service}: ${message}`);
    this.name = "UpstreamError";
  }
}

interface CacheEntry {
  expires: number;
  value: unknown;
}
const cache = new Map<string, CacheEntry>();
const MAX_CACHE = 300;

export function clearHttpCache(): void {
  cache.clear();
}

export interface FetchJsonOptions {
  service: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Cache successful GET responses for this many seconds (0 disables). */
  ttlSeconds?: number;
  /** Statuses to treat as "not found" and return null for. */
  nullOn?: number[];
  fetchImpl?: typeof fetch;
}

export async function fetchJson<T>(url: string, opts: FetchJsonOptions): Promise<T | null> {
  const ttl = opts.ttlSeconds ?? 120;
  const now = Date.now();
  const hit = cache.get(url);
  if (ttl > 0 && hit && hit.expires > now) return hit.value as T | null;

  const doFetch = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(url, {
      headers: { "user-agent": USER_AGENT, accept: "application/json", ...opts.headers },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
    });
  } catch (err) {
    const reason = err instanceof Error && err.name === "TimeoutError" ? "timed out" : "unreachable";
    throw new UpstreamError(opts.service, 504, `${reason}; try again shortly`);
  }

  if (opts.nullOn?.includes(res.status)) return null;
  if (res.status === 429) throw new UpstreamError(opts.service, 429, "rate limited upstream; try again in a minute");
  if (!res.ok) {
    throw new UpstreamError(opts.service, res.status, `HTTP ${res.status}`);
  }
  let json: T;
  try {
    json = (await res.json()) as T;
  } catch {
    throw new UpstreamError(opts.service, 502, "returned a non-JSON response");
  }
  if (ttl > 0) {
    if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value as string);
    cache.set(url, { expires: now + ttl * 1000, value: json });
  }
  return json;
}

export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") u.set(k, String(v));
  }
  const s = u.toString();
  return s ? `?${s}` : "";
}

/** Trim long text for LLM consumption. */
export function clip(text: string | undefined | null, max: number): string {
  if (!text) return "";
  const t = text.replace(/\s+\n/g, "\n").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
