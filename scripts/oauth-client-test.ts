/**
 * Real-client OAuth proof: the official MCP SDK client discovers the server, registers itself dynamically,
 * runs authorization code + PKCE (this script plays the user on the consent page), and calls a tool.
 * Usage: tsx scripts/oauth-client-test.ts <baseUrl> <apiKey>
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

const base = (process.argv[2] ?? "http://127.0.0.1:18433").replace(/\/$/, "");
const apiKey = process.argv[3] ?? process.env["MVC_API_KEY"];
if (!apiKey) throw new Error("pass an API key (the 'user login' on the consent page)");

class Provider implements OAuthClientProvider {
  info?: OAuthClientInformationMixed;
  tok?: OAuthTokens;
  verifier = "";
  code = "";
  get redirectUrl() {
    return "http://127.0.0.1:33418/callback";
  }
  get clientMetadata(): OAuthClientMetadata {
    return { client_name: "oauth-proof-client", redirect_uris: [this.redirectUrl], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] };
  }
  clientInformation() {
    return this.info;
  }
  saveClientInformation(i: OAuthClientInformationMixed) {
    this.info = i;
  }
  tokens() {
    return this.tok;
  }
  saveTokens(t: OAuthTokens) {
    this.tok = t;
  }
  saveCodeVerifier(v: string) {
    this.verifier = v;
  }
  codeVerifier() {
    return this.verifier;
  }
  async redirectToAuthorization(url: URL) {
    console.log(`authorize -> ${url.origin}${url.pathname} (client_id len ${url.searchParams.get("client_id")?.length}, S256=${url.searchParams.get("code_challenge_method")})`);
    const page = await (await fetch(url)).text();
    const ctx = /name="ctx" value="([^"]+)"/.exec(page)?.[1];
    if (!ctx) throw new Error("consent page did not render a ctx field");
    const res = await fetch(`${base}/oauth/authorize`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ctx, api_key: apiKey as string, action: "key" }) });
    const loc = res.headers.get("location");
    if (res.status !== 302 || !loc) throw new Error(`expected redirect, got ${res.status}`);
    this.code = new URL(loc).searchParams.get("code") ?? "";
    console.log(`consent approved -> redirect to ${new URL(loc).origin}${new URL(loc).pathname} with code`);
  }
}

const provider = new Provider();
const url = new URL(`${base}/mcp`);
let client = new Client({ name: "oauth-proof", version: "1.0.0" });
let transport = new StreamableHTTPClientTransport(url, { authProvider: provider });
try {
  await client.connect(transport);
  console.log("connected without OAuth?? unexpected");
} catch (e) {
  if (!(e instanceof UnauthorizedError)) throw e;
  console.log("401 -> OAuth discovery, dynamic registration and authorization ran");
  await transport.finishAuth(provider.code);
  console.log(`token issued (access ${provider.tok?.access_token?.length} chars, refresh ${provider.tok ? "present" : "missing"}, expires_in ${provider.tok?.expires_in})`);
  client = new Client({ name: "oauth-proof", version: "1.0.0" });
  transport = new StreamableHTTPClientTransport(url, { authProvider: provider });
  await client.connect(transport);
}
const tools = (await client.listTools()).tools;
console.log(`tools/list over OAuth -> ${tools.length} tools`);
const r = await client.callTool({ name: "models_gpu_catalog", arguments: { query: "h100" } });
console.log(`tools/call models_gpu_catalog -> ${r.isError ? "ERROR" : "ok"}: ${((r.content as { text: string }[])[0]?.text ?? "").slice(0, 160)}`);
await client.close();
