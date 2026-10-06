import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { PLANS, SERVER_INFO, docsUrl } from "./config.js";
import type { Deps } from "./deps.js";
import { createCheckoutSession, createPortalSession, handleWebhook, revealPurchasedKey } from "./billing.js";
import { getKeyById, issueKey, verifyRawKey, looksLikeKey } from "./keys.js";
import { handleMcpRequest } from "./mcp.js";
import { clientIp, originOf, registerOAuthRoutes, verifyAccessToken } from "./oauth.js";
import { escapeHtml, pageShell } from "./pages.js";
import { anonymousSubject, hit, nextUtcMidnight, utcDay, type Principal } from "./quota.js";
import { z } from "zod";
import { ALL_TOOLS, toolsByGroup } from "./tools/index.js";

type Auth = { ok: true; principal: Principal } | { ok: false; response: Response };

function bearerOf(c: Context): string | undefined {
  const h = c.req.header("authorization");
  if (h) {
    const m = /^Bearer\s+(\S+)$/i.exec(h);
    if (m) return m[1];
  }
  return c.req.header("x-api-key") ?? undefined;
}

function unauthorized(base: string, description: string, withError: boolean): Response {
  const params = [`resource_metadata="${base}/.well-known/oauth-protected-resource"`, 'scope="mcp"'];
  if (withError) params.push('error="invalid_token"', `error_description="${description.replace(/"/g, "'")}"`);
  return new Response(JSON.stringify({ error: withError ? "invalid_token" : "authentication_required", error_description: description }), {
    status: 401,
    headers: { "content-type": "application/json", "www-authenticate": `Bearer ${params.join(", ")}`, "cache-control": "no-store" },
  });
}

export function createApp(deps: Deps): Hono {
  const app = new Hono();

  app.use(
    "*",
    cors({
      origin: "*",
      allowHeaders: ["authorization", "content-type", "x-api-key", "mcp-session-id", "mcp-protocol-version", "last-event-id"],
      exposeHeaders: ["www-authenticate", "mcp-session-id"],
      allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
      maxAge: 86400,
    }),
  );

  app.use("*", async (c, next) => {
    await next();
    c.res.headers.set("x-content-type-options", "nosniff");
    c.res.headers.set("referrer-policy", "no-referrer");
  });

  async function authenticate(c: Context): Promise<Auth> {
    const base = originOf(c, deps);
    const token = bearerOf(c);
    if (!token) return { ok: false, response: unauthorized(base, "Authentication required. Use OAuth or an API key.", false) };
    let keyId: string | null = null;
    if (looksLikeKey(token)) {
      keyId = (await verifyRawKey(deps.store, token))?.id ?? null;
    } else {
      keyId = await verifyAccessToken(deps, token, base);
    }
    const rec = keyId ? await getKeyById(deps.store, keyId) : null;
    if (!rec || rec.status !== "active") return { ok: false, response: unauthorized(base, "Invalid, expired or revoked credential.", true) };
    return { ok: true, principal: { plan: rec.plan, subject: `k:${rec.id}`, keyId: rec.id } };
  }

  registerOAuthRoutes(app, deps);

  app.get("/health", (c) => c.json({ ok: true, service: SERVER_INFO.name, version: SERVER_INFO.version, groups: toolsByGroup() }));

  app.get("/.well-known/mcp/server-card.json", (c) => {
    const base = originOf(c, deps);
    return c.json({
      serverInfo: { name: SERVER_INFO.name, title: SERVER_INFO.title, version: SERVER_INFO.version },
      transport: { type: "streamable-http", url: `${base}/mcp` },
      authentication: { required: true, schemes: ["oauth2", "bearer"] },
      tryEndpoint: `${base}/mcp/try`,
      toolGroups: toolsByGroup(),
      tools: ALL_TOOLS.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: z.toJSONSchema(z.object(t.input)) })),
    });
  });

  const handleMcp = async (c: Context, principalOverride?: Principal) => {
    if (c.req.method !== "POST") {
      return c.json({ jsonrpc: "2.0", error: { code: -32000, message: "Use POST. This server is stateless and has no SSE stream." }, id: null }, 405, { allow: "POST, OPTIONS" });
    }
    const base = originOf(c, deps);
    let principal = principalOverride;
    if (!principal) {
      const a = await authenticate(c);
      if (!a.ok) return a.response;
      principal = a.principal;
    }
    return handleMcpRequest(c.req.raw, { store: deps.store, env: deps.env, principal, baseUrl: base, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) });
  };

  app.all("/mcp", (c) => handleMcp(c));

  // Unauthenticated sandbox for demos and directory reviewers: 10 calls per day per network.
  app.all("/mcp/try", async (c) => {
    const secret = deps.env.get("APP_SECRET") ?? "dev";
    return handleMcp(c, { plan: "anonymous", subject: anonymousSubject(clientIp(c), secret) });
  });

  app.post("/api/keys/free", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { email?: unknown };
    const email = typeof body.email === "string" ? body.email.trim() : "";
    if (!/^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/.test(email)) return c.json({ error: "valid_email_required" }, 400);
    const secret = deps.env.get("APP_SECRET") ?? "dev";
    if (!(await hit(deps.store, "freekey", anonymousSubject(clientIp(c), secret), 5))) return c.json({ error: "too_many_keys_today" }, 429);
    const { rawKey, record } = await issueKey(deps.store, { plan: "free", origin: "free", email });
    return c.json({ api_key: rawKey, key_id: record.id, plan: "free", daily_calls: PLANS.free.dailyCalls, note: "Shown once. Send as 'Authorization: Bearer <key>' to /mcp." }, 201, { "cache-control": "no-store" });
  });

  app.get("/api/usage", async (c) => {
    const a = await authenticate(c);
    if (!a.ok) return a.response;
    const path = `usage/${a.principal.subject.replace(":", "-")}/${utcDay()}.json`;
    const used = (await deps.store.get<{ n: number }>(path))?.value.n ?? 0;
    const plan = PLANS[a.principal.plan];
    return c.json({ plan: plan.id, daily_calls: plan.dailyCalls, used_today: used, resets_at: nextUtcMidnight() });
  });

  app.post("/api/checkout", async (c) => {
    const base = originOf(c, deps);
    const body = (await c.req.json().catch(() => ({}))) as { email?: unknown };
    const email = typeof body.email === "string" && body.email.includes("@") ? body.email.trim() : undefined;
    let keyId: string | undefined;
    if (bearerOf(c)) {
      const a = await authenticate(c);
      if (!a.ok) return a.response;
      keyId = a.principal.keyId;
    }
    try {
      const s = await createCheckoutSession(deps, { base, ...(keyId ? { keyId } : {}), ...(email ? { email } : {}) });
      return c.json({ url: s.url, session_id: s.id });
    } catch (err) {
      const m = err instanceof Error ? err.message : "error";
      if (m === "already_pro") return c.json({ error: "already_pro" }, 409);
      if (m === "key_not_active") return c.json({ error: "key_not_active" }, 401);
      console.error(JSON.stringify({ level: "error", route: "checkout", message: m }));
      return c.json({ error: "checkout_unavailable" }, 502);
    }
  });

  app.post("/api/billing/portal", async (c) => {
    const a = await authenticate(c);
    if (!a.ok) return a.response;
    try {
      return c.json({ url: await createPortalSession(deps, a.principal.keyId as string, originOf(c, deps)) });
    } catch {
      return c.json({ error: "no_subscription" }, 404);
    }
  });

  app.get("/billing/success", async (c) => {
    const sessionId = c.req.query("session_id") ?? "";
    const base = originOf(c, deps);
    const headers = { "cache-control": "no-store", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'" };
    try {
      const r = await revealPurchasedKey(deps, sessionId);
      if (r.status === "ready") {
        return pageShell(
          "Thanks, you are on Pro",
          `<h1>You are on Pro</h1><p>Your key is below. Save it now; this page is the only place it is shown.</p><pre class="key">${escapeHtml(r.key)}</pre>
<p>Add the connector with URL <code>${escapeHtml(base)}/mcp</code>. OAuth clients (Claude, ChatGPT) ask for this key when you connect. CLI clients send it as <code>Authorization: Bearer &lt;key&gt;</code>.</p>
<p class="fine">Manage or cancel any time from the billing portal. Questions: tanner@meshvault.ai.</p>`,
          { headers },
        );
      }
      if (r.status === "upgraded") {
        return pageShell("You are on Pro", `<h1>Your key is now Pro</h1><p>The key you used to start checkout now has the Pro daily limit. No new key was created.</p>`, { headers });
      }
      if (r.status === "expired") {
        return pageShell("Key already shown", `<h1>Key already shown</h1><p>For security the key is shown for 24 hours after purchase. Email tanner@meshvault.ai with your receipt and we will issue a replacement.</p>`, { headers });
      }
      return pageShell("Payment pending", `<h1>Payment pending</h1><p>We have not seen the payment complete yet. Refresh in a moment.</p>`, { status: 202, headers });
    } catch (err) {
      console.error(JSON.stringify({ level: "error", route: "billing_success", message: err instanceof Error ? err.message : String(err) }));
      return pageShell("Something went wrong", `<h1>Something went wrong</h1><p>Your payment is safe. Email tanner@meshvault.ai with your receipt and we will sort out your key.</p>`, { status: 500, headers });
    }
  });

  app.post("/api/stripe/webhook", async (c) => {
    const raw = await c.req.text();
    try {
      const out = await handleWebhook(deps, raw, c.req.header("stripe-signature"));
      return c.json({ received: true, ...out });
    } catch (err) {
      const m = err instanceof Error ? err.message : "error";
      // Signature failures are the caller's fault; anything else should make Stripe retry.
      const sig = m === "missing_signature" || /signature|timestamp|payload/i.test(m);
      console.error(JSON.stringify({ level: sig ? "warn" : "error", route: "stripe_webhook", message: m.slice(0, 200) }));
      return c.json({ error: sig ? "invalid_signature" : "processing_failed" }, sig ? 400 : 500);
    }
  });

  app.notFound((c) => c.json({ error: "not_found", path: new URL(c.req.url).pathname, docs: docsUrl(deps.env, originOf(c, deps)) }, 404));
  app.onError((err, c) => {
    console.error(JSON.stringify({ level: "error", message: err.message }));
    return c.json({ error: "internal_error" }, 500);
  });
  return app;
}
