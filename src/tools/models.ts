/** Models group: memory sizing, GPU fit and Hugging Face discovery for open-weight models. */
import { z } from "zod";
import { findGpu, GPUS } from "../lib/gpus.js";
import { fetchJson, qs, UpstreamError } from "../lib/http.js";
import {
  DEFAULT_FIT_QUANTS,
  QUANTS,
  activeParamsB,
  archFromConfig,
  bytesToGb,
  decodeTps,
  findQuant,
  kvCacheBytes,
  planMemory,
  roughArch,
  totalUsableGb,
  verdictFor,
  type Arch,
  type Hardware,
  type KvType,
} from "../lib/vram.js";
import { defineTool, ToolInputError, type ToolContext } from "./types.js";

const HF = "https://huggingface.co";
export const MODELS_NOTE =
  "Estimates from public architecture configs and typical quantization sizes (llama.cpp-style). Real usage varies by runtime, context length, batch size and driver; leave 5-10% headroom.";

function hfHeaders(ctx: ToolContext): Record<string, string> {
  const t = ctx.env.get("HF_TOKEN");
  return t ? { authorization: `Bearer ${t}` } : {};
}

const repoId = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/, "Use the form owner/name, e.g. Qwen/Qwen3-8B");

interface HfModelInfo {
  id: string;
  gated?: boolean | string;
  safetensors?: { total?: number };
  gguf?: { total?: number; architecture?: string; context_length?: number };
  pipeline_tag?: string;
  library_name?: string;
  tags?: string[];
  downloads?: number;
  likes?: number;
  lastModified?: string;
  cardData?: { license?: string };
}

async function hfInfo(ctx: ToolContext, id: string): Promise<HfModelInfo | null> {
  return fetchJson<HfModelInfo>(`${HF}/api/models/${id}`, { service: "Hugging Face", ttlSeconds: 1800, nullOn: [404, 401], headers: hfHeaders(ctx), fetchImpl: ctx.fetchImpl });
}

async function hfConfig(ctx: ToolContext, id: string): Promise<Record<string, unknown> | null> {
  try {
    return await fetchJson<Record<string, unknown>>(`${HF}/${id}/raw/main/config.json`, { service: "Hugging Face", ttlSeconds: 3600, nullOn: [404, 401, 403], headers: hfHeaders(ctx), fetchImpl: ctx.fetchImpl });
  } catch (err) {
    if (err instanceof UpstreamError && err.status === 502) return null;
    throw err;
  }
}

interface ResolvedModel {
  label: string;
  paramsB: number;
  activeB: number;
  arch: Arch;
  maxContext?: number;
  sources: string[];
}

/** Resolve model facts from a Hugging Face id and/or explicit overrides. Explicit values win. */
async function resolveModel(
  ctx: ToolContext,
  a: { model_id?: string | undefined; params_b?: number | undefined; active_params_b?: number | undefined },
): Promise<ResolvedModel> {
  if (!a.model_id && !a.params_b) throw new ToolInputError("Provide model_id (Hugging Face owner/name) or params_b (billions of parameters).");
  const sources: string[] = [];
  let paramsB = a.params_b;
  let arch: Arch | undefined;
  let label = a.model_id ?? `${a.params_b}B model`;

  if (a.model_id) {
    const [info, cfg] = await Promise.all([hfInfo(ctx, a.model_id), hfConfig(ctx, a.model_id)]);
    if (!info && !cfg && !paramsB) throw new ToolInputError(`Model "${a.model_id}" not found on Hugging Face (private, gated without token, or misspelled). Pass params_b to size it manually.`);
    if (cfg) {
      const parsed = archFromConfig(cfg);
      if (parsed) {
        arch = parsed;
        sources.push("config.json");
      }
    }
    if (!paramsB) {
      const total = info?.safetensors?.total ?? info?.gguf?.total;
      if (total) {
        paramsB = total / 1e9;
        sources.push("Hugging Face parameter count");
      }
    }
  }
  if (!paramsB) throw new ToolInputError("Could not read a parameter count; pass params_b.");
  if (!arch) {
    arch = roughArch(paramsB);
    sources.push("rule-of-thumb architecture (pass model_id for exact KV cache math)");
  }
  const activeB = a.active_params_b ?? activeParamsB(paramsB, arch);
  label = a.model_id ?? label;
  return { label, paramsB, activeB, arch, ...(arch.maxPositions ? { maxContext: arch.maxPositions } : {}), sources };
}

const hardwareItem = z.object({
  gpu: z.string().trim().max(60).optional().describe("Catalog name such as 'RTX 4090', 'H100', 'DGX Spark'. See models_gpu_catalog."),
  vram_gb: z.number().min(1).max(2048).optional().describe("Override memory per device in GB."),
  bandwidth_gbs: z.number().min(20).max(20000).optional().describe("Override memory bandwidth per device in GB/s."),
  count: z.number().int().min(1).max(64).default(1),
  unified_memory: z.boolean().optional(),
});

function toHardware(items: z.infer<typeof hardwareItem>[]): Hardware[] {
  return items.map((h) => {
    const spec = h.gpu ? findGpu(h.gpu) : undefined;
    if (h.gpu && !spec && !h.vram_gb) {
      throw new ToolInputError(`Unknown accelerator "${h.gpu}". Use models_gpu_catalog to see names, or pass vram_gb and bandwidth_gbs.`);
    }
    const vram = h.vram_gb ?? spec?.vramGb;
    if (!vram) throw new ToolInputError("Each hardware entry needs `gpu` or `vram_gb`.");
    return {
      label: spec?.name ?? h.gpu ?? `${vram} GB device`,
      vramGb: vram,
      bandwidthGbs: h.bandwidth_gbs ?? spec?.bandwidthGbs ?? 500,
      count: h.count,
      unified: h.unified_memory ?? spec?.unified ?? false,
    };
  });
}

const quantEnum = z.string().trim().max(12).describe(`Quantization: ${QUANTS.map((q) => q.id).join(", ")}.`);
const kvEnum = z.enum(["f16", "q8_0", "q4_0"]).default("f16").describe("KV cache precision.");

export const modelsTools = [
  defineTool({
    group: "models",
    name: "models_estimate_vram",
    title: "Estimate model memory",
    description:
      "Estimate memory for running an open-weight model: weights at a chosen quantization, KV cache for a context length (exact from the model's config when a Hugging Face id is given), runtime overhead, and MoE active-parameter count.",
    input: {
      model_id: repoId.optional().describe("Hugging Face repo, e.g. Qwen/Qwen3-8B."),
      params_b: z.number().min(0.1).max(5000).optional().describe("Total parameters in billions (overrides the Hub value)."),
      active_params_b: z.number().min(0.1).max(5000).optional().describe("Active parameters per token for MoE models."),
      quant: quantEnum.default("Q4_K_M"),
      context_tokens: z.number().int().min(256).max(2_000_000).default(8192),
      kv_cache: kvEnum,
      batch: z.number().int().min(1).max(256).default(1).describe("Concurrent sequences sharing the weights."),
      gpu_count: z.number().int().min(1).max(64).default(1).describe("Devices the model is split over (adds per-device runtime overhead)."),
    },
    async run(a, ctx) {
      const q = findQuant(a.quant);
      if (!q) throw new ToolInputError(`Unknown quantization "${a.quant}". Known: ${QUANTS.map((x) => x.id).join(", ")}.`);
      const m = await resolveModel(ctx, a);
      const kv = a.kv_cache as KvType;
      const plan = planMemory(m.paramsB, q, m.arch, a.context_tokens, kv, a.batch, a.gpu_count);
      return {
        model: m.label,
        parameters_b: Math.round(m.paramsB * 100) / 100,
        active_parameters_b: Math.round(m.activeB * 100) / 100,
        moe: Boolean(m.arch.moe),
        quant: q.id,
        bits_per_weight: q.bitsPerWeight,
        context_tokens: a.context_tokens,
        context_limit: m.maxContext ?? null,
        context_exceeds_model_limit: m.maxContext ? a.context_tokens > m.maxContext : false,
        kv_cache_type: kv,
        kv_cache_gb_per_1k_tokens: bytesToGb(kvCacheBytes(m.arch, 1000, kv, 1)),
        memory_gb: { weights: plan.weightsGb, kv_cache: plan.kvGb, runtime_overhead: plan.overheadGb, total: plan.totalGb },
        architecture: { layers: m.arch.layers, full_attention_layers: m.arch.fullAttentionLayers, kv_heads: m.arch.kvHeads, head_dim: m.arch.headDim, mla: Boolean(m.arch.mlaCacheDim) },
        sources: m.sources,
        note: MODELS_NOTE,
      };
    },
  }),

  defineTool({
    group: "models",
    name: "models_fit_check",
    title: "Will this model fit my GPU or cluster?",
    description:
      "Check which quantizations of a model fit on given hardware (one GPU, several GPUs, or a unified-memory cluster) at a context length, with headroom verdicts, a recommended quant and an upper-bound decode tokens/second from memory bandwidth.",
    input: {
      model_id: repoId.optional(),
      params_b: z.number().min(0.1).max(5000).optional(),
      active_params_b: z.number().min(0.1).max(5000).optional(),
      hardware: z.array(hardwareItem).min(1).max(8).describe("One entry per kind of device, with a count. A cluster is several entries or a count above 1."),
      context_tokens: z.number().int().min(256).max(2_000_000).default(8192),
      kv_cache: kvEnum,
      batch: z.number().int().min(1).max(256).default(1),
      quants: z.array(quantEnum).min(1).max(12).optional().describe(`Defaults to ${DEFAULT_FIT_QUANTS.join(", ")}.`),
      tensor_parallel: z.boolean().default(false).describe("True when the runtime uses tensor parallelism; false for layer split."),
    },
    async run(a, ctx) {
      const hw = toHardware(a.hardware);
      const m = await resolveModel(ctx, a);
      const kv = a.kv_cache as KvType;
      const deviceCount = hw.reduce((s, h) => s + h.count, 0);
      const usable = totalUsableGb(hw);
      const ids = a.quants ?? [...DEFAULT_FIT_QUANTS];
      const rows = ids.map((id) => {
        const q = findQuant(id);
        if (!q) throw new ToolInputError(`Unknown quantization "${id}".`);
        const plan = planMemory(m.paramsB, q, m.arch, a.context_tokens, kv, a.batch, deviceCount);
        const verdict = verdictFor(plan.totalGb, usable);
        const kvPerToken = kvCacheBytes(m.arch, 1, kv, 1);
        return {
          quant: q.id,
          needed_gb: plan.totalGb,
          weights_gb: plan.weightsGb,
          kv_cache_gb: plan.kvGb,
          verdict,
          headroom_gb: Math.round((usable - plan.totalGb) * 100) / 100,
          decode_tps_upper_bound: verdict === "no" ? null : decodeTps(m.activeB, q, kvPerToken * Math.min(a.context_tokens, 8192) * 0.5, hw, a.tensor_parallel),
        };
      });
      const best = rows.find((r) => r.verdict === "fits") ?? rows.find((r) => r.verdict === "tight");
      const cluster = deviceCount > 1;
      return {
        model: m.label,
        parameters_b: Math.round(m.paramsB * 100) / 100,
        active_parameters_b: Math.round(m.activeB * 100) / 100,
        hardware: hw.map((h) => ({ device: h.label, count: h.count, vram_gb_each: h.vramGb, bandwidth_gbs_each: h.bandwidthGbs, unified_memory: h.unified })),
        usable_gb: usable,
        context_tokens: a.context_tokens,
        results: rows,
        recommendation: best
          ? `${best.quant} (${best.verdict}, needs ${best.needed_gb} GB of ${usable} GB usable)`
          : "Nothing in the tested set fits. Try a smaller quant such as Q2_K or IQ2_M, a shorter context, q8_0/q4_0 KV cache, or more memory.",
        cluster_note: cluster
          ? "Multi-device: weights and KV cache are split across devices. Layer split gives single-device speed with pooled memory; tensor parallel scales speed sub-linearly and needs a fast interconnect (NVLink or 100-400 Gb/s RDMA)."
          : undefined,
        sources: m.sources,
        note: MODELS_NOTE,
      };
    },
  }),

  defineTool({
    group: "models",
    name: "models_gguf_files",
    title: "List a repo's GGUF files",
    description:
      "List the GGUF files in a Hugging Face repo with exact sizes per quantization (shards summed). Optionally mark which quants fit in a given amount of memory.",
    input: {
      repo_id: repoId,
      memory_gb: z.number().min(1).max(4096).optional().describe("Available memory for weights plus cache; marks quants that fit with 15% headroom."),
    },
    async run({ repo_id, memory_gb }, ctx) {
      const tree = await fetchJson<{ type: string; path: string; size: number }[]>(`${HF}/api/models/${repo_id}/tree/main?recursive=true`, {
        service: "Hugging Face",
        ttlSeconds: 1800,
        nullOn: [404, 401],
        headers: hfHeaders(ctx),
        fetchImpl: ctx.fetchImpl,
      });
      if (!tree) throw new ToolInputError(`Repo "${repo_id}" not found or not public.`);
      const groups = new Map<string, { quant: string; bytes: number; files: string[] }>();
      for (const f of tree) {
        if (f.type !== "file" || !f.path.toLowerCase().endsWith(".gguf")) continue;
        const base = f.path.replace(/-\d{5}-of-\d{5}\.gguf$/i, ".gguf");
        const quant = (base.match(/(?:^|[-._/])((?:UD-)?(?:I?Q\d(?:_[A-Z0-9]+)*|BF16|F16|F32|MXFP4|NVFP4))(?=[-._]|$)/i)?.[1] ?? "unknown").toUpperCase();
        const g = groups.get(base) ?? { quant, bytes: 0, files: [] };
        g.bytes += f.size;
        g.files.push(f.path);
        groups.set(base, g);
      }
      const files = [...groups.entries()]
        .map(([name, g]) => ({
          name,
          quant: g.quant,
          size_gb: bytesToGb(g.bytes),
          shards: g.files.length,
          fits: memory_gb === undefined ? undefined : g.bytes / 1024 ** 3 <= memory_gb / 1.15,
        }))
        .sort((x, y) => x.size_gb - y.size_gb);
      return { repo: repo_id, url: `${HF}/${repo_id}`, gguf_files: files.length, files, note: memory_gb ? "fits = file size within memory_gb with 15% headroom for KV cache and runtime; check models_fit_check for context-specific math." : undefined };
    },
  }),

  defineTool({
    group: "models",
    name: "models_search_hf",
    title: "Search Hugging Face models",
    description: "Search public Hugging Face models by text, task, library or GGUF availability, sorted by downloads, likes or recency. Returns ids, downloads, likes, license and task.",
    input: {
      query: z.string().trim().min(1).max(100),
      task: z.string().trim().max(60).optional().describe("Pipeline tag such as text-generation, image-text-to-text, automatic-speech-recognition."),
      gguf_only: z.boolean().default(false),
      sort: z.enum(["downloads", "likes", "lastModified", "trendingScore"]).default("downloads"),
      limit: z.number().int().min(1).max(25).default(10),
    },
    async run({ query, task, gguf_only, sort, limit }, ctx) {
      const url = `${HF}/api/models${qs({ search: query, pipeline_tag: task, filter: gguf_only ? "gguf" : undefined, sort, direction: -1, limit, full: "false" })}`;
      const rows = (await fetchJson<HfModelInfo[]>(url, { service: "Hugging Face", ttlSeconds: 600, headers: hfHeaders(ctx), fetchImpl: ctx.fetchImpl })) ?? [];
      return {
        source: "Hugging Face Hub",
        query,
        count: rows.length,
        models: rows.slice(0, limit).map((r) => ({
          id: r.id,
          task: r.pipeline_tag ?? null,
          library: r.library_name ?? null,
          downloads: r.downloads ?? null,
          likes: r.likes ?? null,
          gated: Boolean(r.gated),
          license: r.tags?.find((t) => t.startsWith("license:"))?.slice(8) ?? null,
          gguf: r.tags?.includes("gguf") ?? false,
          url: `${HF}/${r.id}`,
        })),
      };
    },
  }),

  defineTool({
    group: "models",
    name: "models_gpu_catalog",
    title: "GPU and accelerator catalog",
    description: "Memory size and bandwidth for common GPUs, workstation cards, datacenter accelerators and unified-memory machines, used by models_fit_check. Optional text filter.",
    input: { query: z.string().trim().max(40).optional() },
    async run({ query }) {
      const q = query?.toLowerCase();
      const list = GPUS.filter((g) => !q || g.name.toLowerCase().includes(q) || g.id.includes(q) || (g.aliases ?? []).some((x) => x.includes(q)));
      return {
        count: list.length,
        devices: list.map((g) => ({ name: g.name, vram_gb: g.vramGb, bandwidth_gbs: g.bandwidthGbs, unified_memory: g.unified ?? false })),
        note: "Public spec-sheet numbers. For anything not listed pass vram_gb and bandwidth_gbs directly.",
      };
    },
  }),
];
