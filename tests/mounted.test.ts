import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

let server: Server;
let origin = "";

beforeAll(async () => {
  process.env["LOCAL_STORE_DIR"] = mkdtempSync(join(tmpdir(), "mvc-mounted-"));
  process.env["CONNECTORS_APP_SECRET"] = "mounted-secret-mounted-secret-0123456789";
  process.env["CONNECTORS_PUBLIC_BASE_URL"] = "https://host.test";
  process.env["CONNECTORS_LANDING_PATH"] = "/connectors";
  process.env["CONNECTORS_STRIPE_SECRET_KEY"] = "sk_test_unused_in_this_test";
  process.env["CONNECTORS_STRIPE_WEBHOOK_SECRET"] = "whsec_unused_in_this_test";
  // Dynamic on purpose: src/mounted.ts reads CONNECTORS_* env and builds the app at import time.
  const mod = await import("../src/mounted.js");
  server = createServer((req, res) => void mod.default(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("mounted function entry", () => {
  it("maps CONNECTORS_* env and restores the original path from __path", async () => {
    const res = await fetch(`${origin}/api/connectors?__path=/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);
    const meta = (await res.json()) as { issuer: string; service_documentation: string };
    expect(meta.issuer).toBe("https://host.test");
    expect(meta.service_documentation).toBe("https://host.test/connectors/docs");
  });

  it("passes raw JSON bodies through and serves MCP over the rewritten path", async () => {
    const key = (await (await fetch(`${origin}/api/connectors?__path=/api/keys/free`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "a@b.co" }) })).json()) as { api_key: string };
    expect(key.api_key).toMatch(/^mvc_/);
    const client = new Client({ name: "t", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/api/connectors?__path=/mcp`), { requestInit: { headers: { authorization: `Bearer ${key.api_key}` } } }));
    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(18);
    await client.close();
  });

  it("rejects an unsigned Stripe webhook with a client error, not a crash", async () => {
    const res = await fetch(`${origin}/api/connectors?__path=/api/stripe/webhook`, { method: "POST", headers: { "stripe-signature": "t=1,v1=bad" }, body: "{}" });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});
