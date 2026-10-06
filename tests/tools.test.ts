import { describe, expect, it } from "vitest";
import { clearHttpCache } from "../src/lib/http.js";
import { ALL_TOOLS } from "../src/tools/index.js";
import { ToolInputError } from "../src/tools/types.js";
import { upstream } from "./helpers.js";

const env = { get: (_: string) => undefined };
const tool = (name: string) => {
  const t = ALL_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
};

describe("tool behavior", () => {
  it("every tool is read-only documented and namespaced by group", () => {
    const names = ALL_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of ALL_TOOLS) {
      expect(t.name.startsWith(`${t.group}_`)).toBe(true);
      expect(t.description.length).toBeGreaterThan(40);
    }
  });

  it("health_drug_label prefers the exact single-ingredient label over combinations", async () => {
    clearHttpCache();
    const fetchImpl = upstream([
      [
        "api.fda.gov/drug/label.json",
        {
          meta: { results: { total: 2 } },
          results: [
            { set_id: "combo", effective_time: "20260101", openfda: { brand_name: ["Lisinopril and Hydrochlorothiazide"], generic_name: ["LISINOPRIL AND HYDROCHLOROTHIAZIDE"], manufacturer_name: ["A"] }, boxed_warning: ["fetal toxicity combo"] },
            { set_id: "single", effective_time: "20260102", openfda: { brand_name: ["Lisinopril"], generic_name: ["LISINOPRIL"], manufacturer_name: ["B"] }, boxed_warning: ["fetal toxicity single"] },
          ],
        },
      ],
    ]);
    const out = (await tool("health_drug_label").run({ name: "lisinopril", sections: ["boxed_warning"], limit: 1 }, { env, fetchImpl })) as { labels: { brand_name: string[]; sections: Record<string, string> }[] };
    expect(out.labels).toHaveLength(1);
    expect(out.labels[0]?.brand_name).toEqual(["Lisinopril"]);
    expect(out.labels[0]?.sections["boxed_warning"]).toContain("single");
  });

  it("health_npi_lookup rejects numbers that fail the check digit and under-specified searches", async () => {
    await expect(tool("health_npi_lookup").run({ npi: "1234567890", limit: 5 }, { env })).rejects.toBeInstanceOf(ToolInputError);
    await expect(tool("health_npi_lookup").run({ limit: 5 }, { env })).rejects.toBeInstanceOf(ToolInputError);
  });

  it("models_fit_check pools memory for a two-node unified cluster and reports a recommendation", async () => {
    clearHttpCache();
    const fetchImpl = upstream([
      ["huggingface.co/api/models/acme/big-70b", { id: "acme/big-70b", safetensors: { total: 70_000_000_000 } }],
      ["huggingface.co/acme/big-70b/raw/main/config.json", { num_hidden_layers: 80, hidden_size: 8192, num_attention_heads: 64, num_key_value_heads: 8, head_dim: 128, max_position_embeddings: 131072 }],
    ]);
    const out = (await tool("models_fit_check").run(
      { model_id: "acme/big-70b", hardware: [{ gpu: "DGX Spark", count: 2 }], context_tokens: 65536, kv_cache: "f16", batch: 1, tensor_parallel: false },
      { env, fetchImpl },
    )) as { usable_gb: number; results: { quant: string; verdict: string }[]; recommendation: string; cluster_note?: string };
    expect(out.usable_gb).toBeCloseTo(225.28, 1);
    expect(out.results.find((r) => r.quant === "Q8_0")?.verdict).toBe("fits");
    expect(out.cluster_note).toContain("Multi-device");
  });

  it("models_fit_check says when nothing fits", async () => {
    clearHttpCache();
    const out = (await tool("models_fit_check").run(
      { params_b: 405, hardware: [{ gpu: "RTX 3060" }], context_tokens: 8192, kv_cache: "f16", batch: 1, tensor_parallel: false },
      { env },
    )) as { recommendation: string; results: { verdict: string }[] };
    expect(out.results.every((r) => r.verdict === "no")).toBe(true);
    expect(out.recommendation).toMatch(/Nothing/);
  });

  it("ems_search_protocols requires a jurisdiction", async () => {
    await expect(tool("ems_search_protocols").run({ query: "stroke", limit: 3 }, { env })).rejects.toBeInstanceOf(ToolInputError);
  });

  it("upstream failures surface as readable errors", async () => {
    clearHttpCache();
    const fetchImpl = upstream([["judgefinder", { error: "boom" }, 500]]);
    await expect(tool("legal_search_courts").run({ state: "CA", limit: 3 }, { env, fetchImpl })).rejects.toThrow(/JudgeFinder/);
  });
});
