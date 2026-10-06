/**
 * Node (req, res) entry for running the service as one Vercel Function inside another site's project.
 *
 * - Env names come from the host project with a CONNECTORS_ prefix (CONNECTORS_STRIPE_SECRET_KEY, ...), so they
 *   cannot collide with the host site's own STRIPE_* variables. BLOB_READ_WRITE_TOKEN is used as is.
 * - The host's vercel.json rewrites each public path to this function with the original path in `__path`.
 * - The body is read raw, which Stripe webhook signature checks need.
 *
 * `scripts/export-mount.mjs` bundles this file into a single CommonJS function for the host repo.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createApp } from "./app.js";
import { buildDeps } from "./runtime.js";

const PREFIX = "CONNECTORS_";
for (const [name, value] of Object.entries(process.env)) {
  if (name.startsWith(PREFIX) && value !== undefined) process.env[name.slice(PREFIX.length)] = value;
}

const app = createApp(buildDeps());

function readRaw(req: IncomingMessage & { body?: unknown }): Promise<Buffer> {
  if (Buffer.isBuffer(req.body)) return Promise.resolve(req.body);
  if (typeof req.body === "string") return Promise.resolve(Buffer.from(req.body));
  const { promise, resolve, reject } = Promise.withResolvers<Buffer>();
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => resolve(Buffer.concat(chunks)));
  req.on("error", reject);
  return promise;
}

/** Rebuilds the public request: original path from `__path`, original host from the forwarded headers. */
export async function toRequest(req: IncomingMessage & { body?: unknown }): Promise<Request> {
  const host = String(req.headers["x-forwarded-host"] ?? req.headers["host"] ?? "localhost");
  const proto = String(req.headers["x-forwarded-proto"] ?? "https").split(",")[0]!.trim();
  const url = new URL(req.url ?? "/", `${proto}://${host}`);
  const original = url.searchParams.get("__path");
  if (original) {
    url.searchParams.delete("__path");
    url.pathname = original.startsWith("/") ? original : `/${original}`;
  }
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const item of v) headers.append(k, item);
    else headers.set(k, v);
  }
  const method = req.method ?? "GET";
  const body = method === "GET" || method === "HEAD" ? undefined : await readRaw(req);
  return new Request(url, { method, headers, ...(body && body.length > 0 ? { body: new Uint8Array(body) } : {}) });
}

async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const response = await app.fetch(await toRequest(req));
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  res.end(Buffer.from(await response.arrayBuffer()));
}

// Vercel: keep the raw stream so the Stripe signature is computed over the exact bytes.
export const config = { api: { bodyParser: false } };
export default handler;
