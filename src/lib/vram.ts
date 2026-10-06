/** Model memory math: weights by quantization, KV cache from architecture, fit and speed estimates. Pure functions. */

export interface Quant {
  id: string;
  bitsPerWeight: number;
  note?: string;
}

/** Effective bits per weight including scales, per llama.cpp GGUF types and common serving formats. */
export const QUANTS: readonly Quant[] = [
  { id: "F16", bitsPerWeight: 16 },
  { id: "BF16", bitsPerWeight: 16 },
  { id: "FP8", bitsPerWeight: 8.1 },
  { id: "Q8_0", bitsPerWeight: 8.5 },
  { id: "Q6_K", bitsPerWeight: 6.5625 },
  { id: "Q5_K_M", bitsPerWeight: 5.69 },
  { id: "Q5_K_S", bitsPerWeight: 5.54 },
  { id: "Q4_K_M", bitsPerWeight: 4.89 },
  { id: "Q4_K_S", bitsPerWeight: 4.58 },
  { id: "Q4_0", bitsPerWeight: 4.5 },
  { id: "IQ4_XS", bitsPerWeight: 4.25 },
  { id: "MXFP4", bitsPerWeight: 4.25 },
  { id: "NVFP4", bitsPerWeight: 4.5 },
  { id: "Q3_K_M", bitsPerWeight: 3.91 },
  { id: "Q3_K_S", bitsPerWeight: 3.5 },
  { id: "IQ3_M", bitsPerWeight: 3.66 },
  { id: "Q2_K", bitsPerWeight: 2.96 },
  { id: "IQ2_M", bitsPerWeight: 2.7 },
  { id: "IQ2_XXS", bitsPerWeight: 2.06 },
];

export const DEFAULT_FIT_QUANTS = ["Q8_0", "Q6_K", "Q5_K_M", "Q4_K_M", "Q3_K_M", "Q2_K"] as const;

export function findQuant(id: string): Quant | undefined {
  const u = id.toUpperCase();
  return QUANTS.find((q) => q.id === u);
}

export const KV_TYPES = {
  f16: 2,
  q8_0: 1.0625,
  q4_0: 0.5625,
} as const;
export type KvType = keyof typeof KV_TYPES;

export interface Arch {
  layers: number;
  /** Layers that keep a full KV cache (hybrid/linear-attention models keep fewer). */
  fullAttentionLayers: number;
  kvHeads: number;
  headDim: number;
  /** MLA latent cache width per token per layer (kv_lora_rank + rope dim), when present. */
  mlaCacheDim?: number;
  hidden: number;
  maxPositions?: number;
  moe?: { experts: number; activePerToken: number; moeLayers: number; expertInter: number };
  /** True when the architecture came from rules of thumb rather than a config file. */
  rough: boolean;
}

const GB = 1024 ** 3;

export function bytesToGb(b: number): number {
  return Math.round((b / GB) * 100) / 100;
}

export function weightsBytes(paramsB: number, quant: Quant): number {
  return (paramsB * 1e9 * quant.bitsPerWeight) / 8;
}

export function kvCacheBytes(arch: Arch, contextTokens: number, kv: KvType, batch = 1): number {
  const bytes = KV_TYPES[kv];
  const perTokenPerLayer = arch.mlaCacheDim ? arch.mlaCacheDim * bytes : 2 * arch.kvHeads * arch.headDim * bytes;
  return perTokenPerLayer * arch.fullAttentionLayers * contextTokens * batch;
}

/** Rule-of-thumb architecture when only a parameter count is known. Flagged `rough`. */
export function roughArch(paramsB: number): Arch {
  const layers = Math.max(12, Math.round(14 * paramsB ** 0.38));
  return { layers, fullAttentionLayers: layers, kvHeads: 8, headDim: 128, hidden: 4096, rough: true };
}

type Cfg = Record<string, unknown>;
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Build an Arch from a Hugging Face config.json (handles nested text_config, MLA, MoE and hybrid layer lists). */
export function archFromConfig(raw: Cfg): Arch | null {
  const cfg = (raw["text_config"] && typeof raw["text_config"] === "object" ? (raw["text_config"] as Cfg) : raw) as Cfg;
  const layers = num(cfg["num_hidden_layers"]) ?? num(cfg["n_layer"]) ?? num(cfg["num_layers"]);
  const hidden = num(cfg["hidden_size"]) ?? num(cfg["n_embd"]);
  const heads = num(cfg["num_attention_heads"]) ?? num(cfg["n_head"]);
  if (!layers || !hidden || !heads) return null;
  const kvHeads = num(cfg["num_key_value_heads"]) ?? num(cfg["n_head_kv"]) ?? heads;
  const headDim = num(cfg["head_dim"]) ?? Math.round(hidden / heads);
  const maxPositions = num(cfg["max_position_embeddings"]);

  let fullAttentionLayers = layers;
  const layerTypes = cfg["layer_types"];
  if (Array.isArray(layerTypes) && layerTypes.length === layers) {
    fullAttentionLayers = layerTypes.filter((t) => t === "full_attention").length || layers;
  } else {
    const interval = num(cfg["full_attention_interval"]);
    if (interval && interval > 1) fullAttentionLayers = Math.ceil(layers / interval);
  }

  const kvLora = num(cfg["kv_lora_rank"]);
  const rope = num(cfg["qk_rope_head_dim"]);
  const mlaCacheDim = kvLora ? kvLora + (rope ?? 0) : undefined;

  const experts = num(cfg["num_experts"]) ?? num(cfg["n_routed_experts"]) ?? num(cfg["num_local_experts"]);
  const topk = num(cfg["num_experts_per_tok"]) ?? num(cfg["top_k"]);
  const expertInter = num(cfg["moe_intermediate_size"]) ?? num(cfg["intermediate_size"]);
  const firstDense = num(cfg["first_k_dense_replace"]) ?? 0;
  const moe = experts && topk && expertInter ? { experts, activePerToken: topk, moeLayers: Math.max(0, layers - firstDense), expertInter } : undefined;

  return { layers, fullAttentionLayers, kvHeads, headDim, hidden, ...(mlaCacheDim ? { mlaCacheDim } : {}), ...(maxPositions ? { maxPositions } : {}), ...(moe ? { moe } : {}), rough: false };
}

/** Active parameter estimate for MoE models (billions). Falls back to total for dense models. */
export function activeParamsB(totalB: number, arch: Arch): number {
  const m = arch.moe;
  if (!m) return totalB;
  const perExpert = 3 * arch.hidden * m.expertInter;
  const expertTotal = (m.moeLayers * m.experts * perExpert) / 1e9;
  const expertActive = (m.moeLayers * m.activePerToken * perExpert) / 1e9;
  return Math.max(0.1, totalB - expertTotal + expertActive);
}

export interface Hardware {
  label: string;
  vramGb: number;
  bandwidthGbs: number;
  count: number;
  unified: boolean;
}

export interface MemoryPlan {
  weightsGb: number;
  kvGb: number;
  overheadGb: number;
  totalGb: number;
}

export function planMemory(paramsB: number, quant: Quant, arch: Arch, contextTokens: number, kv: KvType, batch: number, gpuCount: number): MemoryPlan {
  const w = weightsBytes(paramsB, quant);
  const k = kvCacheBytes(arch, contextTokens, kv, batch);
  // Runtime context and compute buffers: ~0.7 GB per device, 3% of weights, and activation scratch that grows with batch.
  const overhead = gpuCount * 0.7 * GB + 0.03 * w + 0.05 * GB * batch;
  return { weightsGb: bytesToGb(w), kvGb: bytesToGb(k), overheadGb: bytesToGb(overhead), totalGb: bytesToGb(w + k + overhead) };
}

export function totalUsableGb(hw: Hardware[]): number {
  const raw = hw.reduce((s, h) => s + h.vramGb * h.count, 0);
  // Keep headroom: discrete cards lose ~6% to fragmentation and display; unified memory shares with the OS (~12%).
  const usable = hw.reduce((s, h) => s + h.vramGb * h.count * (h.unified ? 0.88 : 0.94), 0);
  return Math.round(Math.min(usable, raw) * 100) / 100;
}

export type Verdict = "fits" | "tight" | "no";

export function verdictFor(neededGb: number, usableGb: number): Verdict {
  if (neededGb > usableGb) return "no";
  return neededGb > usableGb * 0.92 ? "tight" : "fits";
}

/**
 * Upper-bound decode speed. Memory-bound: each token reads the active weights once plus the KV cache.
 * Layer-split pipelines use one device's bandwidth at a time; tensor-parallel scales sub-linearly.
 */
export function decodeTps(activeParams: number, quant: Quant, kvBytesPerToken: number, hw: Hardware[], tensorParallel: boolean): number {
  const perToken = (activeParams * 1e9 * quant.bitsPerWeight) / 8 + kvBytesPerToken;
  if (perToken <= 0 || hw.length === 0) return 0;
  const devices = hw.flatMap((h) => Array.from({ length: h.count }, () => h.bandwidthGbs));
  const slowest = Math.min(...devices);
  const bw = tensorParallel && devices.length > 1 ? slowest * devices.length * 0.65 : slowest;
  const efficiency = 0.6;
  return Math.round(((bw * 1e9 * efficiency) / perToken) * 10) / 10;
}
