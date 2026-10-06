import { emsTools } from "./ems.js";
import { healthTools } from "./health.js";
import { legalTools } from "./legal.js";
import { modelsTools } from "./models.js";
import type { ToolDef } from "./types.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const ALL_TOOLS: ToolDef<any>[] = [...emsTools, ...legalTools, ...healthTools, ...modelsTools];

export function toolsByGroup() {
  const out: Record<string, string[]> = {};
  for (const t of ALL_TOOLS) (out[t.group] ??= []).push(t.name);
  return out;
}
