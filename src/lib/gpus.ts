/** Built-in accelerator catalog (public spec-sheet numbers). Memory in GB, bandwidth in GB/s. */
export interface GpuSpec {
  id: string;
  name: string;
  vramGb: number;
  bandwidthGbs: number;
  unified?: boolean;
  aliases?: string[];
}

export const GPUS: readonly GpuSpec[] = [
  { id: "rtx-3060-12", name: "GeForce RTX 3060 12GB", vramGb: 12, bandwidthGbs: 360, aliases: ["3060"] },
  { id: "rtx-3080-10", name: "GeForce RTX 3080 10GB", vramGb: 10, bandwidthGbs: 760, aliases: ["3080"] },
  { id: "rtx-3090", name: "GeForce RTX 3090", vramGb: 24, bandwidthGbs: 936, aliases: ["3090"] },
  { id: "rtx-4060-ti-16", name: "GeForce RTX 4060 Ti 16GB", vramGb: 16, bandwidthGbs: 288, aliases: ["4060 ti"] },
  { id: "rtx-4070-ti-super", name: "GeForce RTX 4070 Ti Super", vramGb: 16, bandwidthGbs: 672, aliases: ["4070 ti super"] },
  { id: "rtx-4080", name: "GeForce RTX 4080", vramGb: 16, bandwidthGbs: 717, aliases: ["4080"] },
  { id: "rtx-4080-super", name: "GeForce RTX 4080 Super", vramGb: 16, bandwidthGbs: 736, aliases: ["4080 super"] },
  { id: "rtx-4090", name: "GeForce RTX 4090", vramGb: 24, bandwidthGbs: 1008, aliases: ["4090"] },
  { id: "rtx-5070-ti", name: "GeForce RTX 5070 Ti", vramGb: 16, bandwidthGbs: 896, aliases: ["5070 ti"] },
  { id: "rtx-5080", name: "GeForce RTX 5080", vramGb: 16, bandwidthGbs: 960, aliases: ["5080"] },
  { id: "rtx-5090", name: "GeForce RTX 5090", vramGb: 32, bandwidthGbs: 1792, aliases: ["5090"] },
  { id: "rtx-a6000", name: "RTX A6000", vramGb: 48, bandwidthGbs: 768, aliases: ["a6000"] },
  { id: "rtx-6000-ada", name: "RTX 6000 Ada", vramGb: 48, bandwidthGbs: 960, aliases: ["6000 ada"] },
  { id: "rtx-pro-6000", name: "RTX PRO 6000 Blackwell", vramGb: 96, bandwidthGbs: 1792, aliases: ["pro 6000", "rtx pro 6000"] },
  { id: "l4", name: "NVIDIA L4", vramGb: 24, bandwidthGbs: 300 },
  { id: "l40s", name: "NVIDIA L40S", vramGb: 48, bandwidthGbs: 864 },
  { id: "a100-40", name: "NVIDIA A100 40GB", vramGb: 40, bandwidthGbs: 1555 },
  { id: "a100-80", name: "NVIDIA A100 80GB", vramGb: 80, bandwidthGbs: 2039, aliases: ["a100"] },
  { id: "h100-80", name: "NVIDIA H100 80GB", vramGb: 80, bandwidthGbs: 3350, aliases: ["h100"] },
  { id: "h200", name: "NVIDIA H200 141GB", vramGb: 141, bandwidthGbs: 4800 },
  { id: "b200", name: "NVIDIA B200", vramGb: 180, bandwidthGbs: 8000 },
  { id: "mi300x", name: "AMD Instinct MI300X", vramGb: 192, bandwidthGbs: 5300 },
  { id: "dgx-spark", name: "NVIDIA DGX Spark / GB10 (128GB unified)", vramGb: 128, bandwidthGbs: 273, unified: true, aliases: ["gb10", "spark", "gx10", "ascent"] },
  { id: "strix-halo-128", name: "AMD Ryzen AI Max+ 395 (128GB unified)", vramGb: 128, bandwidthGbs: 256, unified: true, aliases: ["strix halo", "ai max"] },
  { id: "m4-max-128", name: "Apple M4 Max 128GB", vramGb: 128, bandwidthGbs: 546, unified: true, aliases: ["m4 max"] },
  { id: "m3-ultra-512", name: "Apple M3 Ultra 512GB", vramGb: 512, bandwidthGbs: 819, unified: true, aliases: ["m3 ultra"] },
  { id: "m2-ultra-192", name: "Apple M2 Ultra 192GB", vramGb: 192, bandwidthGbs: 800, unified: true, aliases: ["m2 ultra"] },
];

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\b(nvidia|geforce|amd|rtx|gpu|graphics)\b/g, " ").replace(/\s+/g, " ").trim();
}

export function findGpu(query: string): GpuSpec | undefined {
  const q = norm(query);
  if (!q) return undefined;
  const exact = GPUS.find((g) => g.id === query.toLowerCase() || norm(g.name) === q);
  if (exact) return exact;
  const withAlias = GPUS.filter((g) => [g.id, norm(g.name), ...(g.aliases ?? []).map(norm)].some((n) => n === q || n.includes(q) || q.includes(n)));
  // Prefer the closest (shortest) name, so "4080" picks the plain 4080 over the Super.
  return withAlias.sort((a, b) => norm(a.name).length - norm(b.name).length)[0];
}
