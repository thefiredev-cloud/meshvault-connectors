/** MCP server factory. One stateless server per HTTP request; quota is enforced around every tool call. */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { PLANS, SERVER_INFO, type Env } from "./config.js";
import { UpstreamError } from "./lib/http.js";
import { consume, refund, type Principal } from "./quota.js";
import type { Store } from "./store.js";
import { ALL_TOOLS } from "./tools/index.js";
import { ToolInputError } from "./tools/types.js";

export interface McpContext {
  store: Store;
  env: Env;
  principal: Principal;
  /** Public origin, used in upgrade links. */
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

const INSTRUCTIONS = [
  "MeshVault Connectors: read-only tools in four groups.",
  "ems_*: EMS protocol lookup from Protocol Guide (education and reference, not medical direction).",
  "legal_*: judge and court lookup from JudgeFinder (informational, not legal advice).",
  "health_*: NPI registry and openFDA drug labels, recalls and adverse event reports (not medical advice).",
  "models_*: VRAM and GPU fit math for open-weight models and Hugging Face search.",
  "Free callers have a daily call quota; when it is used up a tool returns an error with an upgrade link.",
].join("\n");

type ToolText = { type: "text"; text: string };

function failure(text: string, extra?: Record<string, unknown>) {
  const content: ToolText[] = [{ type: "text", text }];
  return { content, isError: true, ...(extra ? { structuredContent: extra } : {}) };
}

export function createMcpServer(ctx: McpContext): McpServer {
  const server = new McpServer(
    { name: SERVER_INFO.name, title: SERVER_INFO.title, version: SERVER_INFO.version, websiteUrl: SERVER_INFO.websiteUrl },
    { instructions: INSTRUCTIONS },
  );

  for (const def of ALL_TOOLS) {
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: def.input,
        annotations: { title: def.title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      async (args: Record<string, unknown>) => {
        const quota = await consume(ctx.store, ctx.principal);
        if (!quota.allowed) {
          const plan = PLANS[quota.plan];
          const upgrade = quota.plan === "pro" ? "Your Pro daily limit resets at 00:00 UTC." : `Upgrade or get a key: ${ctx.baseUrl}/#pricing`;
          return failure(
            `Daily quota reached for the ${plan.label} plan (${quota.used}/${quota.limit} calls). Resets ${quota.resetsAt}. ${upgrade}`,
            { error: "quota_exceeded", plan: quota.plan, used: quota.used, limit: quota.limit, resets_at: quota.resetsAt, upgrade_url: `${ctx.baseUrl}/#pricing` },
          );
        }
        try {
          const data = (await def.run(args, { env: ctx.env, ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}) })) as Record<string, unknown>;
          const withQuota = { ...data, _quota: { plan: quota.plan, used: quota.used, limit: quota.limit, resets_at: quota.resetsAt } };
          return { content: [{ type: "text" as const, text: JSON.stringify(withQuota) }], structuredContent: withQuota };
        } catch (err) {
          if (err instanceof ToolInputError) {
            await refund(ctx.store, ctx.principal).catch(() => undefined);
            return failure(err.message);
          }
          if (err instanceof UpstreamError) {
            await refund(ctx.store, ctx.principal).catch(() => undefined);
            return failure(`${err.message}. This call was not counted against your quota.`);
          }
          console.error(JSON.stringify({ level: "error", tool: def.name, message: err instanceof Error ? err.message : String(err) }));
          return failure("Unexpected error in this tool. Try again; if it persists contact support.");
        }
      },
    );
  }
  return server;
}

/** Handles one MCP HTTP request statelessly (JSON responses, no sessions). */
export async function handleMcpRequest(req: Request, ctx: McpContext, authInfo?: AuthInfo): Promise<Response> {
  const server = createMcpServer(ctx);
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req, authInfo ? { authInfo } : undefined);
  } finally {
    void server.close().catch(() => undefined);
  }
}
