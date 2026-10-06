/**
 * After a test purchase: shows the key's plan, then makes calls past the old free limit.
 * Usage: tsx scripts/after-purchase.ts <baseUrl> <keyFile> [extraCalls]
 */
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const base = (process.argv[2] ?? "http://127.0.0.1:18433").replace(/\/$/, "");
const key = readFileSync(process.argv[3] ?? "/tmp/mvc-free-key", "utf8").trim();
const extra = Number(process.argv[4] ?? 3);
const auth = { authorization: `Bearer ${key}` };

console.log("usage ->", JSON.stringify(await (await fetch(`${base}/api/usage`, { headers: auth })).json()));
const client = new Client({ name: "after-purchase", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: auth } }));
for (let i = 0; i < extra; i++) {
  const r = await client.callTool({ name: "health_npi_lookup", arguments: { npi: "1063837144" } });
  const text = (r.content as { text: string }[])[0]?.text ?? "";
  const q = (r.structuredContent as { _quota?: { plan: string; used: number; limit: number } } | undefined)?._quota;
  console.log(`call ${i + 1}: ${r.isError ? "ERROR " + text : "ok"} quota=${JSON.stringify(q)}`);
}
await client.close();
