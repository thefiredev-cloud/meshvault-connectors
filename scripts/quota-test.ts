/**
 * Uses up a free key's daily quota through real MCP calls, prints the quota error a customer would see,
 * then (optionally) creates a Checkout URL for upgrading that same key and prints it.
 * Usage: tsx scripts/quota-test.ts <baseUrl> [--checkout]    Writes the key to $MVC_KEY_OUT (default /tmp/mvc-free-key).
 */
import { writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const base = (process.argv[2] ?? "http://127.0.0.1:18433").replace(/\/$/, "");
const wantCheckout = process.argv.includes("--checkout");

const free = (await (await fetch(`${base}/api/keys/free`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "quota-test@example.com" }) })).json()) as { api_key: string; daily_calls: number };
writeFileSync(process.env["MVC_KEY_OUT"] ?? "/tmp/mvc-free-key", free.api_key, { mode: 0o600 });
console.log(`free key issued (${free.api_key.slice(0, 8)}…), daily_calls=${free.daily_calls}`);

const client = new Client({ name: "quota-test", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${free.api_key}` } } }));
let ok = 0;
let denied: string | undefined;
for (let i = 1; i <= free.daily_calls + 3; i++) {
  const r = await client.callTool({ name: "models_gpu_catalog", arguments: { query: "h100" } });
  if (r.isError) {
    denied = `call #${i}: ${(r.content as { text: string }[])[0]?.text}`;
    break;
  }
  ok++;
}
console.log(`calls ok before limit: ${ok}`);
console.log(`quota response -> ${denied}`);
await client.close();

if (wantCheckout) {
  const r = await fetch(`${base}/api/checkout`, { method: "POST", headers: { authorization: `Bearer ${free.api_key}`, "content-type": "application/json" }, body: "{}" });
  const j = (await r.json()) as { url?: string };
  console.log(`checkout ${r.status}`);
  writeFileSync("/tmp/mvc-checkout-url", j.url ?? "", { mode: 0o600 });
}
