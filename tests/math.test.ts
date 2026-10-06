import { describe, expect, it } from "vitest";
import { findGpu } from "../src/lib/gpus.js";
import { activeParamsB, archFromConfig, decodeTps, findQuant, kvCacheBytes, planMemory, roughArch, totalUsableGb, verdictFor, weightsBytes } from "../src/lib/vram.js";
import { fdaTerm, isValidNpi } from "../src/tools/health.js";

const qwen3_8b = { num_hidden_layers: 36, hidden_size: 4096, num_attention_heads: 32, num_key_value_heads: 8, head_dim: 128, max_position_embeddings: 40960 };

describe("vram math", () => {
  it("computes weights for 8B at Q4_K_M near 4.5 GiB", () => {
    const gib = weightsBytes(8, findQuant("q4_k_m")!) / 1024 ** 3;
    expect(gib).toBeGreaterThan(4.4);
    expect(gib).toBeLessThan(4.7);
  });

  it("KV cache for Qwen3-8B at 8192 ctx f16 is 1.125 GiB", () => {
    const arch = archFromConfig(qwen3_8b)!;
    const gib = kvCacheBytes(arch, 8192, "f16") / 1024 ** 3;
    expect(gib).toBeCloseTo(1.125, 3);
  });

  it("uses only full-attention layers for hybrid models", () => {
    const arch = archFromConfig({ ...qwen3_8b, layer_types: Array.from({ length: 36 }, (_, i) => (i % 4 === 3 ? "full_attention" : "linear_attention")) })!;
    expect(arch.fullAttentionLayers).toBe(9);
    expect(kvCacheBytes(arch, 8192, "f16") / 1024 ** 3).toBeCloseTo(0.28125, 4);
  });

  it("handles MLA caches and nested text_config", () => {
    const arch = archFromConfig({ text_config: { ...qwen3_8b, kv_lora_rank: 512, qk_rope_head_dim: 64 } })!;
    expect(arch.mlaCacheDim).toBe(576);
    expect(kvCacheBytes(arch, 1000, "f16")).toBe(576 * 2 * 36 * 1000);
  });

  it("estimates MoE active parameters below total", () => {
    const arch = archFromConfig({ num_hidden_layers: 48, hidden_size: 2048, num_attention_heads: 32, num_key_value_heads: 4, head_dim: 128, num_experts: 128, num_experts_per_tok: 8, moe_intermediate_size: 768 })!;
    const active = activeParamsB(30.5, arch);
    expect(active).toBeGreaterThan(2);
    expect(active).toBeLessThan(5);
  });

  it("returns null for configs without layers", () => {
    expect(archFromConfig({ hidden_size: 10 })).toBeNull();
  });

  it("verdicts and usable memory", () => {
    const hw = [{ label: "x", vramGb: 24, bandwidthGbs: 1000, count: 1, unified: false }];
    expect(totalUsableGb(hw)).toBeCloseTo(22.56, 2);
    expect(verdictFor(10, 22.56)).toBe("fits");
    expect(verdictFor(21, 22.56)).toBe("tight");
    expect(verdictFor(23, 22.56)).toBe("no");
  });

  it("70B Q4_K_M does not fit one 24GB card but fits two", () => {
    const arch = roughArch(70);
    const q = findQuant("Q4_K_M")!;
    const one = planMemory(70, q, arch, 8192, "f16", 1, 1).totalGb;
    const hw1 = [{ label: "4090", vramGb: 24, bandwidthGbs: 1008, count: 1, unified: false }];
    const hw2 = [{ ...hw1[0]!, count: 2 }];
    expect(verdictFor(one, totalUsableGb(hw1))).toBe("no");
    const two = planMemory(70, q, arch, 8192, "f16", 1, 2).totalGb;
    expect(verdictFor(two, totalUsableGb(hw2))).not.toBe("no");
  });

  it("decode speed scales with bandwidth and shrinks with size", () => {
    const fast = [{ label: "a", vramGb: 24, bandwidthGbs: 1000, count: 1, unified: false }];
    const slow = [{ label: "b", vramGb: 128, bandwidthGbs: 273, count: 1, unified: true }];
    const q = findQuant("Q4_K_M")!;
    expect(decodeTps(8, q, 0, fast, false)).toBeGreaterThan(decodeTps(8, q, 0, slow, false));
    expect(decodeTps(8, q, 0, fast, false)).toBeGreaterThan(decodeTps(32, q, 0, fast, false));
  });

  it("finds GPUs by common names", () => {
    expect(findGpu("RTX 4090")?.vramGb).toBe(24);
    expect(findGpu("4080")?.id).toBe("rtx-4080");
    expect(findGpu("4080 super")?.id).toBe("rtx-4080-super");
    expect(findGpu("H100")?.vramGb).toBe(80);
    expect(findGpu("DGX Spark")?.unified).toBe(true);
    expect(findGpu("nonexistent card")).toBeUndefined();
  });
});

describe("health helpers", () => {
  it("validates NPI check digits", () => {
    expect(isValidNpi("1234567893")).toBe(true);
    expect(isValidNpi("1234567890")).toBe(false);
    expect(isValidNpi("123")).toBe(false);
  });

  it("quotes openFDA terms safely", () => {
    expect(fdaTerm('met"formin\\ x')).toBe('"met formin x"');
  });
});
