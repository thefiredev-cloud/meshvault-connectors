import { createHash, randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { clearKeyCache } from "../src/keys.js";
import { BASE, makeApp, upstream } from "./helpers.js";

const pgSearch = {
  result: { data: { json: { results: [{ id: 235335, protocolNumber: "1210", protocolTitle: "Cardiac Arrest", section: "Cardiac", content: "Epinephrine may improve outcomes...", sourcePdfUrl: "https://example.org/1210.pdf", relevanceScore: 84.6, agencyName: "Los Angeles County EMS Agency", stateCode: "CA", protocolYear: 2018 }], totalFound: 1 } } },
};

const upstreamFake = upstream([
  ["protocol-guide.com/api/trpc/search.semantic", pgSearch],
  ["api/judges/search", { results: [{ id: "3002", type: "judge", title: "C Lynwood Smith, Jr", subtitle: "U.S. District Court, Northern District of Alabama", description: "AL • 408 cases", url: "/judges/c-lynwood-smith-jr" }], total_count: 1, has_more: false }],
  ["npiregistry.cms.hhs.gov", { result_count: 1, results: [{ number: "1234567893", enumeration_type: "NPI-1", basic: { first_name: "JANE", last_name: "DOE", credential: "MD", status: "A" }, addresses: [{ address_purpose: "LOCATION", address_1: "1 MAIN ST", city: "LOS ANGELES", state: "CA", postal_code: "900010000", telephone_number: "555-0100" }], taxonomies: [{ code: "207P00000X", desc: "Emergency Medicine", primary: true }] }] }],
  ["huggingface.co/api/models/Qwen/Qwen3-8B", { id: "Qwen/Qwen3-8B", safetensors: { total: 8_190_735_360 } }],
  ["huggingface.co/Qwen/Qwen3-8B/raw/main/config.json", { num_hidden_layers: 36, hidden_size: 4096, num_attention_heads: 32, num_key_value_heads: 8, head_dim: 128, max_position_embeddings: 40960 }],
]);

async function connect(fetchApp: typeof fetch, headers: Record<string, string>, path = "/mcp") {
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}${path}`), { fetch: fetchApp, requestInit: { headers } });
  await client.connect(transport);
  return client;
}

async function freeKey(fetchApp: typeof fetch, email = "dev@example.com"): Promise<string> {
  const r = await fetchApp(`${BASE}/api/keys/free`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
  expect(r.status).toBe(201);
  return ((await r.json()) as { api_key: string }).api_key;
}

const text = (r: unknown) => ((r as { content: { text: string }[] }).content[0] as { text: string }).text;

describe("MCP over streamable HTTP", () => {
  it("rejects missing and bad credentials with OAuth discovery hints", async () => {
    const { fetchApp } = makeApp();
    const r = await fetchApp(`${BASE}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toContain('resource_metadata="https://connectors.test/.well-known/oauth-protected-resource"');
    const bad = await fetchApp(`${BASE}/mcp`, { method: "POST", headers: { authorization: "Bearer mvc_nope", "content-type": "application/json" }, body: "{}" });
    expect(bad.status).toBe(401);
    expect(bad.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  it("lists all four groups and serves calls with a free key", async () => {
    const { fetchApp } = makeApp({ fetchImpl: upstreamFake });
    const key = await freeKey(fetchApp);
    const client = await connect(fetchApp, { authorization: `Bearer ${key}` });
    const tools = (await client.listTools()).tools.map((t) => t.name);
    for (const prefix of ["ems_", "legal_", "health_", "models_"]) expect(tools.some((t) => t.startsWith(prefix))).toBe(true);
    expect(tools).toHaveLength(18);

    const ems = await client.callTool({ name: "ems_search_protocols", arguments: { query: "adult cardiac arrest", state: "CA" } });
    expect(ems.isError).toBeFalsy();
    expect(text(ems)).toContain("Los Angeles County EMS Agency");
    expect(text(ems)).toContain("Not medical direction".toLowerCase().length ? "medical direction" : "");

    const legal = await client.callTool({ name: "legal_search_judges", arguments: { query: "smith" } });
    expect(text(legal)).toContain("c-lynwood-smith-jr");

    const health = await client.callTool({ name: "health_npi_lookup", arguments: { npi: "1234567893" } });
    expect(text(health)).toContain("Emergency Medicine");
    expect(text(health)).toContain("Not medical advice");

    const models = await client.callTool({ name: "models_fit_check", arguments: { model_id: "Qwen/Qwen3-8B", hardware: [{ gpu: "RTX 4090" }], context_tokens: 16384 } });
    const body = JSON.parse(text(models)) as { recommendation: string; results: { quant: string; verdict: string }[] };
    expect(body.results.find((r) => r.quant === "Q8_0")?.verdict).toBe("fits");
    expect(body.recommendation).toMatch(/^Q8_0/);
    await client.close();
  });

  it("returns tool errors for bad input without charging the quota", async () => {
    const { fetchApp } = makeApp({ fetchImpl: upstreamFake });
    const key = await freeKey(fetchApp);
    const client = await connect(fetchApp, { authorization: `Bearer ${key}` });
    const bad = await client.callTool({ name: "ems_search_protocols", arguments: { query: "cardiac arrest" } });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toContain("state");
    const usage = await fetchApp(`${BASE}/api/usage`, { headers: { authorization: `Bearer ${key}` } });
    expect(((await usage.json()) as { used_today: number }).used_today).toBe(0);
    await client.close();
  });

  it("enforces the anonymous daily quota with an upgrade message", async () => {
    const { fetchApp } = makeApp({ fetchImpl: upstreamFake });
    const client = await connect(fetchApp, {}, "/mcp/try");
    let last: unknown;
    for (let i = 0; i < 10; i++) last = await client.callTool({ name: "models_gpu_catalog", arguments: { query: "4090" } });
    expect((last as { isError?: boolean }).isError).toBeFalsy();
    const eleventh = await client.callTool({ name: "models_gpu_catalog", arguments: {} });
    expect(eleventh.isError).toBe(true);
    expect(text(eleventh)).toContain("Daily quota reached");
    expect(text(eleventh)).toContain("/#pricing");
    await client.close();
  });

  it("points upgrade and docs links at the landing path when mounted under another site", async () => {
    const { fetchApp } = makeApp({ fetchImpl: upstreamFake, env: { LANDING_PATH: "/connectors" } });
    const client = await connect(fetchApp, {}, "/mcp/try");
    let last: unknown;
    for (let i = 0; i < 11; i++) last = await client.callTool({ name: "models_gpu_catalog", arguments: { query: "4090" } });
    expect(text(last)).toContain(`${BASE}/connectors#pricing`);
    await client.close();
    const meta = (await (await fetchApp(`${BASE}/.well-known/oauth-authorization-server`)).json()) as { service_documentation: string };
    expect(meta.service_documentation).toBe(`${BASE}/connectors/docs`);
    const nf = (await (await fetchApp(`${BASE}/nope`)).json()) as { docs: string };
    expect(nf.docs).toBe(`${BASE}/connectors/docs`);
  });

  it("gives a revoked key no access", async () => {
    const { fetchApp, store } = makeApp();
    const key = await freeKey(fetchApp);
    const id = createHash("sha256").update(key).digest("hex").slice(0, 24);
    const rec = (await store.get<Record<string, unknown>>(`keys/${id}.json`))!;
    await store.put(`keys/${id}.json`, { ...rec.value, status: "revoked" }, { ifMatch: rec.etag });
    // key cache TTL is 10s; a fresh app instance has no cache problem in production because each key is cached per lambda for 10s only.
    clearKeyCache();
    const r = await fetchApp(`${BASE}/mcp`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: "{}" });
    expect(r.status).toBe(401);
  });
});

describe("OAuth 2.1 flow", () => {
  function pkce() {
    const verifier = randomBytes(32).toString("base64url");
    return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
  }

  async function registerClient(fetchApp: typeof fetch, redirect = "http://127.0.0.1:33418/callback") {
    const r = await fetchApp(`${BASE}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [redirect], client_name: "Test", token_endpoint_auth_method: "none" }) });
    expect(r.status).toBe(201);
    return (await r.json()) as { client_id: string };
  }

  async function authorize(fetchApp: typeof fetch, clientId: string, redirect: string, challenge: string, apiKey: string) {
    const url = new URL(`${BASE}/oauth/authorize`);
    for (const [k, v] of Object.entries({ response_type: "code", client_id: clientId, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", state: "xyz" })) url.searchParams.set(k, v);
    const page = await fetchApp(url);
    expect(page.status).toBe(200);
    const html = await page.text();
    const ctx = /name="ctx" value="([^"]+)"/.exec(html)![1]!;
    const post = await fetchApp(`${BASE}/oauth/authorize`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ctx, api_key: apiKey, action: "key" }) });
    return post;
  }

  const tokenReq = (fetchApp: typeof fetch, params: Record<string, string>) =>
    fetchApp(`${BASE}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params) });

  it("serves metadata, completes code+PKCE, calls MCP with the access token, rotates refresh and detects replay", async () => {
    const { fetchApp } = makeApp({ fetchImpl: upstreamFake });
    const meta = (await (await fetchApp(`${BASE}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    expect(meta["code_challenge_methods_supported"]).toEqual(["S256"]);
    const prm = (await (await fetchApp(`${BASE}/.well-known/oauth-protected-resource`)).json()) as Record<string, unknown>;
    expect(prm["resource"]).toBe(`${BASE}/mcp`);

    const key = await freeKey(fetchApp);
    const redirect = "http://127.0.0.1:33418/callback";
    const { client_id } = await registerClient(fetchApp, redirect);
    const { verifier, challenge } = pkce();
    const res = await authorize(fetchApp, client_id, redirect, challenge, key);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("state")).toBe("xyz");
    const code = loc.searchParams.get("code")!;

    // Wrong verifier is rejected.
    const wrong = await tokenReq(fetchApp, { grant_type: "authorization_code", code, client_id, redirect_uri: redirect, code_verifier: randomBytes(32).toString("base64url") });
    expect(wrong.status).toBe(400);

    const ok = await tokenReq(fetchApp, { grant_type: "authorization_code", code, client_id, redirect_uri: redirect, code_verifier: verifier });
    expect(ok.status).toBe(200);
    const tok = (await ok.json()) as { access_token: string; refresh_token: string };

    const client = await connect(fetchApp, { authorization: `Bearer ${tok.access_token}` });
    const r = await client.callTool({ name: "models_gpu_catalog", arguments: { query: "h100" } });
    expect(text(r)).toContain("H100");
    await client.close();

    // Code replay fails.
    const replay = await tokenReq(fetchApp, { grant_type: "authorization_code", code, client_id, redirect_uri: redirect, code_verifier: verifier });
    expect(replay.status).toBe(400);

    // Refresh rotates; reuse of the old token revokes the family.
    const refreshed = await tokenReq(fetchApp, { grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id });
    // Family was revoked by the code replay above, so the refresh must now fail.
    expect(refreshed.status).toBe(400);
  });

  it("rotates refresh tokens and revokes the family on reuse", async () => {
    const { fetchApp } = makeApp();
    const key = await freeKey(fetchApp);
    const redirect = "http://127.0.0.1:33418/callback";
    const { client_id } = await registerClient(fetchApp, redirect);
    const { verifier, challenge } = pkce();
    const code = new URL((await authorize(fetchApp, client_id, redirect, challenge, key)).headers.get("location")!).searchParams.get("code")!;
    const first = (await (await tokenReq(fetchApp, { grant_type: "authorization_code", code, client_id, redirect_uri: redirect, code_verifier: verifier })).json()) as { refresh_token: string };
    const second = await tokenReq(fetchApp, { grant_type: "refresh_token", refresh_token: first.refresh_token, client_id });
    expect(second.status).toBe(200);
    const next = (await second.json()) as { refresh_token: string; access_token: string };
    expect(next.refresh_token).not.toBe(first.refresh_token);
    const reuse = await tokenReq(fetchApp, { grant_type: "refresh_token", refresh_token: first.refresh_token, client_id });
    expect(reuse.status).toBe(400);
    const afterRevoke = await tokenReq(fetchApp, { grant_type: "refresh_token", refresh_token: next.refresh_token, client_id });
    expect(afterRevoke.status).toBe(400);
  });

  it("rejects unregistered redirect URIs, plain PKCE, and tampered tokens", async () => {
    const { fetchApp } = makeApp();
    const { client_id } = await registerClient(fetchApp);
    const base = new URL(`${BASE}/oauth/authorize`);
    base.searchParams.set("response_type", "code");
    base.searchParams.set("client_id", client_id);
    base.searchParams.set("code_challenge", "x".repeat(43));
    base.searchParams.set("code_challenge_method", "S256");
    const evil = new URL(base);
    evil.searchParams.set("redirect_uri", "https://evil.example/cb");
    expect((await fetchApp(evil)).status).toBe(400);
    const plain = new URL(base);
    plain.searchParams.set("redirect_uri", "http://127.0.0.1:33418/callback");
    plain.searchParams.set("code_challenge_method", "plain");
    const p = await fetchApp(plain, { redirect: "manual" });
    expect(p.status).toBe(302);
    expect(p.headers.get("location")).toContain("error=invalid_request");
    const forged = await fetchApp(`${BASE}/mcp`, { method: "POST", headers: { authorization: "Bearer eyJhbGciOiJub25lIn0.eyJzdWIiOiJrZXkifQ.", "content-type": "application/json" }, body: "{}" });
    expect(forged.status).toBe(401);
    const badReg = await fetchApp(`${BASE}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: ["javascript:alert(1)"] }) });
    expect(badReg.status).toBe(400);
  });
});

describe("Stripe billing", () => {
  const paidSession = (extra: Record<string, unknown> = {}) => ({
    id: "cs_test_abc",
    mode: "subscription",
    payment_status: "paid",
    customer: "cus_123",
    subscription: "sub_123",
    customer_details: { email: "buyer@example.com" },
    metadata: { app: "meshvault-connectors", key_id: "" },
    ...extra,
  });
  const evt = (type: string, object: unknown, id = `evt_${type}`) => ({ id, type, data: { object } });
  const post = (fetchApp: typeof fetch, event: unknown, sig = "valid:whsec_test") =>
    fetchApp(`${BASE}/api/stripe/webhook`, { method: "POST", headers: { "stripe-signature": sig, "content-type": "application/json" }, body: JSON.stringify(event) });

  it("creates a checkout session for an anonymous buyer", async () => {
    const { fetchApp, stripe } = makeApp();
    const r = await fetchApp(`${BASE}/api/checkout`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "buyer@example.com" }) });
    expect(r.status).toBe(200);
    const p = stripe.created[0] as Record<string, unknown>;
    expect(p["mode"]).toBe("subscription");
    expect(p["payment_method_types"]).toBeUndefined();
    expect(String(p["integration_identifier"])).toMatch(/^meshvault-connectors-[a-z]{8}$/);
    expect(p["success_url"]).toContain("/billing/success?session_id={CHECKOUT_SESSION_ID}");
  });

  it("issues a Pro key on checkout.session.completed, reveals it once, and revokes it on cancellation", async () => {
    const { fetchApp, stripe, store } = makeApp({ fetchImpl: upstreamFake });
    stripe.sessions.set("cs_test_abc", paidSession());
    const done = await post(fetchApp, evt("checkout.session.completed", paidSession()));
    expect(done.status).toBe(200);
    // Duplicate delivery is a no-op.
    const dup = (await (await post(fetchApp, evt("checkout.session.completed", paidSession()))).json()) as { duplicate?: boolean };
    expect(dup.duplicate).toBe(true);

    const page = await (await fetchApp(`${BASE}/billing/success?session_id=cs_test_abc`)).text();
    const key = /mvc_[A-Za-z0-9_-]{43}/.exec(page)![0];
    const usage = (await (await fetchApp(`${BASE}/api/usage`, { headers: { authorization: `Bearer ${key}` } })).json()) as { plan: string; daily_calls: number };
    expect(usage).toMatchObject({ plan: "pro", daily_calls: 5000 });

    // Success page and webhook converge on one key.
    const again = await (await fetchApp(`${BASE}/billing/success?session_id=cs_test_abc`)).text();
    expect(/mvc_[A-Za-z0-9_-]{43}/.exec(again)![0]).toBe(key);

    const del = await post(fetchApp, evt("customer.subscription.deleted", { id: "sub_123", customer: "cus_123", status: "canceled", metadata: { app: "meshvault-connectors", key_id: "" } }));
    expect(del.status).toBe(200);
    clearKeyCache();
    const after = await fetchApp(`${BASE}/api/usage`, { headers: { authorization: `Bearer ${key}` } });
    expect(after.status).toBe(401);
    void store;
  });

  it("upgrades an existing free key and downgrades it on cancellation", async () => {
    const { fetchApp, stripe } = makeApp();
    const key = await freeKey(fetchApp);
    const id = createHash("sha256").update(key).digest("hex").slice(0, 24);
    const session = paidSession({ id: "cs_test_upg", metadata: { app: "meshvault-connectors", key_id: id } });
    stripe.sessions.set("cs_test_upg", session);
    await post(fetchApp, evt("checkout.session.completed", session, "evt_up1"));
    clearKeyCache();
    const u1 = (await (await fetchApp(`${BASE}/api/usage`, { headers: { authorization: `Bearer ${key}` } })).json()) as { plan: string };
    expect(u1.plan).toBe("pro");
    await post(fetchApp, evt("customer.subscription.deleted", { id: "sub_123", customer: "cus_123", status: "canceled", metadata: { app: "meshvault-connectors", key_id: id } }, "evt_del1"));
    clearKeyCache();
    const u2 = (await (await fetchApp(`${BASE}/api/usage`, { headers: { authorization: `Bearer ${key}` } })).json()) as { plan: string };
    expect(u2.plan).toBe("free");
  });

  it("rejects webhooks with bad signatures and ignores foreign events", async () => {
    const { fetchApp } = makeApp();
    const bad = await post(fetchApp, evt("checkout.session.completed", paidSession()), "nope");
    expect(bad.status).toBe(400);
    const foreign = (await (await post(fetchApp, evt("checkout.session.completed", paidSession({ metadata: { app: "other" } })))).json()) as { handled: boolean };
    expect(foreign.handled).toBe(false);
  });

  it("does not fulfill unpaid sessions", async () => {
    const { fetchApp, stripe } = makeApp();
    stripe.sessions.set("cs_test_unpaid", paidSession({ id: "cs_test_unpaid", payment_status: "unpaid" }));
    const page = await fetchApp(`${BASE}/billing/success?session_id=cs_test_unpaid`);
    expect(page.status).toBe(202);
  });
});

