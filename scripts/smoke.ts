/**
 * Customer-style smoke test against a running server: gets a free key, lists tools, calls every tool group.
 * Usage: tsx scripts/smoke.ts [baseUrl] [apiKey]
 * Prints a transcript (truncated JSON) suitable for evidence.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const base = (process.argv[2] ?? "http://127.0.0.1:8787").replace(/\/$/, "");
let key = process.argv[3] ?? process.env["MVC_API_KEY"];

async function main() {
  if (!key) {
    const r = await fetch(`${base}/api/keys/free`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "smoke@example.com" }) });
    key = ((await r.json()) as { api_key: string }).api_key;
    console.log(`# issued free key ${key.slice(0, 8)}…`);
  }
  const client = new Client({ name: "mvc-smoke", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${key}` } } }));
  const tools = (await client.listTools()).tools;
  console.log(`# tools/list -> ${tools.length} tools`);
  for (const t of tools) console.log(`  - ${t.name}`);

  const calls: [string, Record<string, unknown>][] = [
    ["ems_coverage", { state: "CA" }],
    ["ems_list_agencies", { state: "CA" }],
    ["ems_search_protocols", { query: "adult cardiac arrest epinephrine", state: "CA", limit: 2 }],
    ["ems_get_protocol", { id: 235335 }],
    ["legal_search_judges", { query: "smith", limit: 2 }],
    ["legal_get_judge", { slug: "c-lynwood-smith-jr" }],
    ["legal_judge_recent_cases", { judge_id: "3002", limit: 2 }],
    ["legal_search_courts", { state: "CA", type: "state", limit: 2 }],
    ["legal_court_judges", { court_id: "alnd", limit: 3 }],
    ["health_npi_lookup", { first_name: "john", last_name: "smith", state: "CA", limit: 1 }],
    ["health_drug_label", { name: "metformin", sections: ["boxed_warning", "contraindications"] }],
    ["health_drug_recalls", { query: "metformin", limit: 2 }],
    ["health_drug_adverse_events", { drug: "ibuprofen", top: 5 }],
    ["models_gpu_catalog", { query: "spark" }],
    ["models_estimate_vram", { model_id: "Qwen/Qwen3-8B", quant: "Q4_K_M", context_tokens: 32768 }],
    ["models_fit_check", { model_id: "Qwen/Qwen3-8B", hardware: [{ gpu: "DGX Spark", count: 2 }], context_tokens: 32768 }],
    ["models_gguf_files", { repo_id: "unsloth/Qwen3-8B-GGUF", memory_gb: 16 }],
    ["models_search_hf", { query: "qwen3", gguf_only: true, limit: 3 }],
  ];
  let failures = 0;
  for (const [name, args] of calls) {
    const t0 = Date.now();
    const res = await client.callTool({ name, arguments: args });
    const first = (res.content as { type: string; text: string }[])[0];
    const text = first?.text ?? "";
    const ok = !res.isError;
    if (!ok) failures++;
    console.log(`\n## ${name} ${JSON.stringify(args)}\n   ${ok ? "OK" : "ERROR"} in ${Date.now() - t0} ms\n   ${text.slice(0, 420).replace(/\n/g, " ")}${text.length > 420 ? " …" : ""}`);
  }
  await client.close();
  console.log(`\n# done: ${calls.length - failures}/${calls.length} calls ok`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
