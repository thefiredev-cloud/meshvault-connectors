/**
 * Local server for development and customer-style testing: `pnpm dev`.
 * Serves ./public statically and the API from the same Hono app, with a file-backed store.
 * Env: APP_SECRET (>=32 chars), optional STRIPE_*, PORT (default 8787), LOCAL_STORE_DIR (default .local-store).
 */
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { createApp } from "../src/app.js";
import { buildDeps } from "../src/runtime.js";

process.env["LOCAL_STORE_DIR"] ??= ".local-store";
process.env["APP_SECRET"] ??= "local-dev-secret-local-dev-secret-0000";
const port = Number(process.env["PORT"] ?? 8787);

const api = createApp(buildDeps());
const root = new Hono();
root.get("/", serveStatic({ path: "./public/index.html" }));
root.get("/docs", serveStatic({ path: "./public/docs/index.html" }));
root.use("/*", serveStatic({ root: "./public" }));
root.route("/", api);

serve({ fetch: root.fetch, port }, (info) => console.log(`meshvault-connectors dev server on http://127.0.0.1:${info.port}`));
