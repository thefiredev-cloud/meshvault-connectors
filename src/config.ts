/** Plans and runtime configuration. Everything secret comes from the environment. */

export type PlanId = "anonymous" | "free" | "pro";

export interface Plan {
  id: PlanId;
  label: string;
  /** Tool calls allowed per UTC day. */
  dailyCalls: number;
  priceUsdMonthly: number;
}

export const PLANS: Record<PlanId, Plan> = {
  anonymous: { id: "anonymous", label: "Anonymous (no key)", dailyCalls: 10, priceUsdMonthly: 0 },
  free: { id: "free", label: "Free key", dailyCalls: 100, priceUsdMonthly: 0 },
  pro: { id: "pro", label: "Pro", dailyCalls: 5000, priceUsdMonthly: 19 },
};

export const TOOL_GROUPS = ["ems", "legal", "health", "models"] as const;
export type ToolGroup = (typeof TOOL_GROUPS)[number];

export interface Env {
  get(name: string): string | undefined;
}

export const processEnv: Env = { get: (n) => process.env[n] };

export function required(env: Env, name: string): string {
  const v = env.get(name);
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

/** Public origin used in OAuth metadata and Stripe return URLs. */
export function baseUrl(env: Env, requestUrl?: string): string {
  const configured = env.get("PUBLIC_BASE_URL");
  if (configured) return configured.replace(/\/$/, "");
  if (requestUrl) return new URL(requestUrl).origin;
  return "http://localhost:3000";
}

/**
 * Where the marketing site lives. Empty when the service owns its host; "/connectors" when it is mounted
 * under another site (the static pages are then served from that path). Server-side links use these helpers.
 */
function landingBase(env: Env, base: string): string {
  return `${base}${(env.get("LANDING_PATH") ?? "").replace(/\/+$/, "")}`;
}
export const pricingUrl = (env: Env, base: string): string => `${landingBase(env, base)}${env.get("LANDING_PATH") ? "" : "/"}#pricing`;
export const landingUrl = (env: Env, base: string): string => `${landingBase(env, base)}${env.get("LANDING_PATH") ? "" : "/"}`;
export const docsUrl = (env: Env, base: string): string => `${landingBase(env, base)}/docs`;

export const SERVER_INFO = {
  name: "meshvault-connectors",
  title: "MeshVault Connectors",
  version: "0.1.0",
  websiteUrl: "https://github.com/thefiredev-cloud/meshvault-connectors",
} as const;

export const CONTACT = {
  company: "The Fire Dev LLC (MeshVault)",
  email: "tanner@meshvault.ai",
} as const;
