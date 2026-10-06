/**
 * Minimal OAuth 2.1 authorization server in front of the MCP endpoint.
 *
 * - Public clients only (token_endpoint_auth_method=none), registered statelessly: client_id is a signed JWT holding the redirect URIs.
 * - Authorization code + PKCE (S256 only), exact redirect_uri match, single-use codes.
 * - The "login" is holding a MeshVault API key, or instantly creating a free one.
 * - Access tokens are short-lived HS256 JWTs bound to the key id; refresh tokens rotate with replay detection that revokes the family.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { SignJWT, jwtVerify, errors as joseErrors } from "jose";
import type { Context, Hono } from "hono";
import { required } from "./config.js";
import type { Deps } from "./deps.js";
import { issueKey, getKeyById, verifyRawKey, sha256Hex } from "./keys.js";
import { hit } from "./quota.js";
import { ConflictError, update } from "./store.js";
import { escapeHtml, pageShell } from "./pages.js";

const ACCESS_TTL_S = 3600;
const REFRESH_TTL_S = 30 * 24 * 3600;
const CODE_TTL_S = 120;
const FORM_TTL_S = 900;

export function signingKey(deps: Deps): Uint8Array {
  return createHash("sha256").update(`jwt:${required(deps.env, "APP_SECRET")}`).digest();
}

export function originOf(c: Context, deps: Deps): string {
  const configured = deps.env.get("PUBLIC_BASE_URL");
  return (configured ?? new URL(c.req.url).origin).replace(/\/$/, "");
}

const b64url = (buf: Buffer) => buf.toString("base64url");

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function validRedirectUri(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash) return false;
  if (u.protocol === "https:") return true;
  if (u.protocol === "http:") return ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  // Native apps register custom schemes (cursor://, vscode://). Block script-capable schemes.
  return !["javascript:", "data:", "vbscript:", "file:", "blob:", "about:"].includes(u.protocol);
}

interface ClientClaims {
  redirect_uris: string[];
  client_name?: string;
}

async function readClient(deps: Deps, clientId: string): Promise<ClientClaims | null> {
  try {
    const { payload } = await jwtVerify(clientId, signingKey(deps), { algorithms: ["HS256"], audience: "oauth-client" });
    const uris = payload["redirect_uris"];
    if (!Array.isArray(uris) || !uris.every((x) => typeof x === "string")) return null;
    return { redirect_uris: uris as string[], ...(typeof payload["client_name"] === "string" ? { client_name: payload["client_name"] as string } : {}) };
  } catch {
    return null;
  }
}

function oauthError(error: string, description: string, status = 400): Response {
  return new Response(JSON.stringify({ error, error_description: description }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", pragma: "no-cache" },
  });
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...extra } });
}

export function protectedResourceMetadata(base: string) {
  return { resource: `${base}/mcp`, authorization_servers: [base], bearer_methods_supported: ["header"], scopes_supported: ["mcp"], resource_name: "MeshVault Connectors", resource_documentation: `${base}/docs` };
}

export function authServerMetadata(base: string) {
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["mcp"],
    service_documentation: `${base}/docs`,
  };
}

interface AuthReq {
  cid: string;
  ru: string;
  cc: string;
  state?: string;
  scope: string;
}

async function signAuthReq(deps: Deps, r: AuthReq): Promise<string> {
  return new SignJWT({ ...r }).setProtectedHeader({ alg: "HS256" }).setAudience("oauth-authreq").setIssuedAt().setExpirationTime(`${FORM_TTL_S}s`).sign(signingKey(deps));
}

async function readAuthReq(deps: Deps, token: string): Promise<AuthReq | null> {
  try {
    const { payload } = await jwtVerify(token, signingKey(deps), { algorithms: ["HS256"], audience: "oauth-authreq" });
    const { cid, ru, cc, scope } = payload as Record<string, unknown>;
    if (typeof cid !== "string" || typeof ru !== "string" || typeof cc !== "string" || typeof scope !== "string") return null;
    return { cid, ru, cc, scope, ...(typeof payload["state"] === "string" ? { state: payload["state"] as string } : {}) };
  } catch {
    return null;
  }
}

function authorizePage(opts: { ctxToken: string; clientName: string; error?: string; issuedKey?: string; base: string }): Response {
  const err = opts.error ? `<p class="err" role="alert">${escapeHtml(opts.error)}</p>` : "";
  const body = opts.issuedKey
    ? `<h1>Your free key</h1>
<p>Save this key now. It is shown once. It also works in any MCP client as a Bearer token.</p>
<pre class="key" id="k">${escapeHtml(opts.issuedKey)}</pre>
<form method="post" action="/oauth/authorize">
<input type="hidden" name="ctx" value="${escapeHtml(opts.ctxToken)}">
<input type="hidden" name="api_key" value="${escapeHtml(opts.issuedKey)}">
<button type="submit" name="action" value="key">Authorize ${escapeHtml(opts.clientName)}</button>
</form>`
    : `<h1>Connect ${escapeHtml(opts.clientName)}</h1>
<p>MeshVault Connectors gives your AI assistant read-only tools for EMS protocols, courts and judges, public health data and model sizing.</p>
${err}
<form method="post" action="/oauth/authorize">
<input type="hidden" name="ctx" value="${escapeHtml(opts.ctxToken)}">
<label for="api_key">I have a key</label>
<input id="api_key" name="api_key" type="password" autocomplete="off" placeholder="mvc_..." spellcheck="false">
<button type="submit" name="action" value="key">Authorize</button>
</form>
<p class="or">or</p>
<form method="post" action="/oauth/authorize">
<input type="hidden" name="ctx" value="${escapeHtml(opts.ctxToken)}">
<label for="email">Get a free key (100 calls a day)</label>
<input id="email" name="email" type="email" autocomplete="email" placeholder="you@example.com" required>
<p class="fine">We use your email only for service notices. No card needed. Upgrade any time at <a href="${escapeHtml(opts.base)}/#pricing">pricing</a>.</p>
<button type="submit" name="action" value="free" class="secondary">Create free key</button>
</form>`;
  return pageShell("Authorize MeshVault Connectors", body, {
    status: opts.error ? 400 : 200,
    headers: { "cache-control": "no-store", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'" },
  });
}

export function registerOAuthRoutes(app: Hono, deps: Deps): void {
  app.get("/.well-known/oauth-protected-resource", (c) => c.json(protectedResourceMetadata(originOf(c, deps))));
  app.get("/.well-known/oauth-protected-resource/mcp", (c) => c.json(protectedResourceMetadata(originOf(c, deps))));
  app.get("/.well-known/oauth-authorization-server", (c) => c.json(authServerMetadata(originOf(c, deps))));
  app.get("/.well-known/openid-configuration", (c) => c.json(authServerMetadata(originOf(c, deps))));

  app.post("/oauth/register", async (c) => {
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return oauthError("invalid_client_metadata", "Body must be JSON.");
    }
    const uris = body["redirect_uris"];
    if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10 || !uris.every((u) => typeof u === "string" && validRedirectUri(u))) {
      return oauthError("invalid_redirect_uri", "redirect_uris must be 1-10 https URLs, loopback http URLs, or app scheme URLs.");
    }
    const method = body["token_endpoint_auth_method"];
    if (method !== undefined && method !== "none") return oauthError("invalid_client_metadata", "Only token_endpoint_auth_method=none (public clients with PKCE) is supported.");
    const name = typeof body["client_name"] === "string" ? body["client_name"].slice(0, 80) : "MCP client";
    const clientId = await new SignJWT({ redirect_uris: uris, client_name: name }).setProtectedHeader({ alg: "HS256" }).setAudience("oauth-client").setIssuedAt().sign(signingKey(deps));
    return json(
      {
        client_id: clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_name: name,
        redirect_uris: uris,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        scope: "mcp",
      },
      201,
    );
  });

  app.get("/oauth/authorize", async (c) => {
    const q = c.req.query();
    const client = q["client_id"] ? await readClient(deps, q["client_id"]) : null;
    if (!client) return c.text("Unknown or invalid client_id.", 400);
    const redirectUri = q["redirect_uri"] ?? (client.redirect_uris.length === 1 ? client.redirect_uris[0] : undefined);
    if (!redirectUri || !client.redirect_uris.includes(redirectUri)) return c.text("redirect_uri does not match the client registration.", 400);
    // From here on, errors go back to the client's redirect URI.
    const fail = (error: string, desc: string) => {
      const u = new URL(redirectUri);
      u.searchParams.set("error", error);
      u.searchParams.set("error_description", desc);
      if (q["state"]) u.searchParams.set("state", q["state"]);
      return c.redirect(u.toString(), 302);
    };
    if (q["response_type"] !== "code") return fail("unsupported_response_type", "Only response_type=code is supported.");
    if (!q["code_challenge"] || q["code_challenge_method"] !== "S256") return fail("invalid_request", "PKCE with code_challenge_method=S256 is required.");
    if (!/^[A-Za-z0-9_-]{43}$/.test(q["code_challenge"])) return fail("invalid_request", "Malformed code_challenge.");
    const ctxToken = await signAuthReq(deps, { cid: q["client_id"] as string, ru: redirectUri, cc: q["code_challenge"], scope: "mcp", ...(q["state"] ? { state: q["state"] } : {}) });
    return authorizePage({ ctxToken, clientName: client.client_name ?? "your AI client", base: originOf(c, deps) });
  });

  app.post("/oauth/authorize", async (c) => {
    const form = await c.req.parseBody();
    const ctxToken = typeof form["ctx"] === "string" ? form["ctx"] : "";
    const req = await readAuthReq(deps, ctxToken);
    if (!req) return c.text("This authorization request expired. Go back to your AI client and try again.", 400);
    const client = await readClient(deps, req.cid);
    if (!client) return c.text("Unknown client.", 400);
    const clientName = client.client_name ?? "your AI client";
    const base = originOf(c, deps);

    let keyId: string | undefined;
    if (form["action"] === "free") {
      const email = typeof form["email"] === "string" ? form["email"].trim() : "";
      if (!/^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/.test(email)) return authorizePage({ ctxToken, clientName, base, error: "Enter a valid email address." });
      const ip = clientIp(c);
      const ok = await hit(deps.store, "freekey", `ip:${sha256Hex(`${required(deps.env, "APP_SECRET")}|${ip}`).slice(0, 20)}`, 5);
      if (!ok) return authorizePage({ ctxToken, clientName, base, error: "Too many free keys from this network today. Try again tomorrow or use an existing key." });
      const { rawKey } = await issueKey(deps.store, { plan: "free", origin: "free", email });
      return authorizePage({ ctxToken, clientName, base, issuedKey: rawKey });
    }

    const raw = typeof form["api_key"] === "string" ? form["api_key"].trim() : "";
    const rec = raw ? await verifyRawKey(deps.store, raw) : null;
    if (!rec) return authorizePage({ ctxToken, clientName, base, error: "That key was not recognized or has been revoked." });
    keyId = rec.id;

    const jti = b64url(randomBytes(16));
    const fam = `fam_${b64url(randomBytes(12))}`;
    const code = await new SignJWT({ cid: req.cid, ru: req.ru, cc: req.cc, kid: keyId, fam, scope: req.scope })
      .setProtectedHeader({ alg: "HS256" })
      .setAudience("oauth-code")
      .setJti(jti)
      .setIssuedAt()
      .setExpirationTime(`${CODE_TTL_S}s`)
      .sign(signingKey(deps));
    const u = new URL(req.ru);
    u.searchParams.set("code", code);
    if (req.state) u.searchParams.set("state", req.state);
    u.searchParams.set("iss", base);
    return new Response(null, { status: 302, headers: { location: u.toString(), "cache-control": "no-store" } });
  });

  app.post("/oauth/token", async (c) => {
    const form = await c.req.parseBody();
    const grant = form["grant_type"];
    const base = originOf(c, deps);
    const secret = signingKey(deps);

    const mint = async (kid: string, cid: string, fam: string, scope: string) => {
      const access = await new SignJWT({ scope, cid, fam })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuer(base)
        .setAudience(`${base}/mcp`)
        .setSubject(kid)
        .setIssuedAt()
        .setExpirationTime(`${ACCESS_TTL_S}s`)
        .sign(secret);
      const refresh = `mvr_${b64url(randomBytes(32))}`;
      await deps.store.put(`oauth/refresh/${sha256Hex(refresh)}.json`, { fam, kid, cid, scope, used: false, exp: Date.now() + REFRESH_TTL_S * 1000 }, { createOnly: true });
      return json({ access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_S, refresh_token: refresh, scope });
    };

    if (grant === "authorization_code") {
      const codeStr = typeof form["code"] === "string" ? form["code"] : "";
      const verifier = typeof form["code_verifier"] === "string" ? form["code_verifier"] : "";
      let p: Record<string, unknown>;
      try {
        ({ payload: p } = await jwtVerify(codeStr, secret, { algorithms: ["HS256"], audience: "oauth-code" }));
      } catch (e) {
        return oauthError("invalid_grant", e instanceof joseErrors.JWTExpired ? "Authorization code expired." : "Invalid authorization code.");
      }
      const { cid, ru, cc, kid, fam, scope, jti } = p as Record<string, string>;
      if (form["client_id"] !== cid) return oauthError("invalid_grant", "client_id does not match the code.");
      if (form["redirect_uri"] !== undefined && form["redirect_uri"] !== ru) return oauthError("invalid_grant", "redirect_uri does not match the authorization request.");
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return oauthError("invalid_grant", "Missing or malformed code_verifier.");
      if (!safeEqual(b64url(createHash("sha256").update(verifier).digest()), cc as string)) return oauthError("invalid_grant", "PKCE verification failed.");
      try {
        await deps.store.put(`oauth/codes/${jti}.json`, { fam, at: Date.now() }, { createOnly: true });
      } catch (e) {
        if (e instanceof ConflictError) {
          await deps.store.put(`oauth/families/${fam}.json`, { revoked: true, at: Date.now() }).catch(() => undefined);
          return oauthError("invalid_grant", "Authorization code already used.");
        }
        throw e;
      }
      const rec = await getKeyById(deps.store, kid as string);
      if (!rec || rec.status !== "active") return oauthError("invalid_grant", "The key behind this authorization is no longer active.");
      return mint(kid as string, cid as string, fam as string, scope as string);
    }

    if (grant === "refresh_token") {
      const rt = typeof form["refresh_token"] === "string" ? form["refresh_token"] : "";
      if (!rt.startsWith("mvr_")) return oauthError("invalid_grant", "Invalid refresh token.");
      const path = `oauth/refresh/${sha256Hex(rt)}.json`;
      const cur = await deps.store.get<{ fam: string; kid: string; cid: string; scope: string; used: boolean; exp: number }>(path);
      if (!cur) return oauthError("invalid_grant", "Invalid refresh token.");
      const v = cur.value;
      if (form["client_id"] !== undefined && form["client_id"] !== v.cid) return oauthError("invalid_grant", "client_id mismatch.");
      const famRevoked = await deps.store.get(`oauth/families/${v.fam}.json`);
      if (famRevoked || v.exp < Date.now()) return oauthError("invalid_grant", "Refresh token expired or revoked.");
      if (v.used) {
        await deps.store.put(`oauth/families/${v.fam}.json`, { revoked: true, at: Date.now() }).catch(() => undefined);
        return oauthError("invalid_grant", "Refresh token reuse detected; the session was revoked.");
      }
      let won = false;
      await update<typeof v>(deps.store, path, (x) => {
        if (!x || x.used) return undefined;
        won = true;
        return { ...x, used: true };
      });
      if (!won) return oauthError("invalid_grant", "Refresh token already used.");
      const rec = await getKeyById(deps.store, v.kid);
      if (!rec || rec.status !== "active") return oauthError("invalid_grant", "The key behind this session is no longer active.");
      return mint(v.kid, v.cid, v.fam, v.scope);
    }

    return oauthError("unsupported_grant_type", "Supported grants: authorization_code, refresh_token.");
  });
}

export function clientIp(c: Context): string {
  const xff = c.req.header("x-forwarded-for");
  return (xff?.split(",")[0]?.trim() || c.req.header("x-real-ip") || "unknown").slice(0, 64);
}

/** Validates an OAuth access token minted above. Returns the key id or null. */
export async function verifyAccessToken(deps: Deps, token: string, base: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, signingKey(deps), { algorithms: ["HS256"], issuer: base, audience: `${base}/mcp` });
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}
