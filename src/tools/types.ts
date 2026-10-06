import type { ZodRawShape, z } from "zod";
import type { ToolGroup } from "../config.js";

export interface ToolDef<S extends ZodRawShape = ZodRawShape> {
  group: ToolGroup;
  name: string;
  title: string;
  description: string;
  input: S;
  run(args: z.infer<z.ZodObject<S>>, ctx: ToolContext): Promise<unknown>;
}

export interface ToolContext {
  fetchImpl?: typeof fetch;
  env: { get(name: string): string | undefined };
}

/** Helper that keeps the generic inference intact when declaring a tool. */
export function defineTool<S extends ZodRawShape>(def: ToolDef<S>): ToolDef<S> {
  return def;
}

export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}
