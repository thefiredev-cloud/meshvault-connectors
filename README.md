# MeshVault Connectors

[![CI](https://github.com/thefiredev-cloud/meshvault-connectors/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/thefiredev-cloud/meshvault-connectors/actions/workflows/ci.yml)
[![MIT license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![MCP transport](https://img.shields.io/badge/MCP-Streamable_HTTP-blue)](https://modelcontextprotocol.io)

MeshVault Connectors gives your AI assistant read-only MCP tools for EMS protocols, judges and courts, public health data and model sizing.

## Add it to Claude Code

```bash
claude mcp add --transport http meshvault https://thefiredev.com/mcp/try
```

This adds the keyless trial endpoint: 10 tool calls per UTC day per network. [Other clients and authentication](#use-it).

**Free:** a key allows 100 calls a day across all 18 tools. **Pro:** $19/month for 5,000 calls a day, with the same tools. [Get a free key or choose Pro](https://thefiredev.com/connectors#pricing). The server source is MIT; self-hosting is separate from the hosted plans.

![Terminal demo: add MeshVault to Claude Code, confirm the connection and list its 18 tools](docs/assets/demo.gif)

Recorded from a real run in a fresh Omabox home. The demo shows connection and tool discovery, not a tool call; idle time is shortened.

## Tool groups

| Group | Tools | Source |
| --- | --- | --- |
| `ems` | `ems_search_protocols`, `ems_get_protocol`, `ems_list_agencies`, `ems_coverage` | [Protocol Guide](https://protocol-guide.com) public site API (read only) |
| `legal` | `legal_search_judges`, `legal_get_judge`, `legal_judge_recent_cases`, `legal_search_courts`, `legal_court_judges` | [JudgeFinder](https://judgefinder.vercel.app) JSON API |
| `health` | `health_npi_lookup`, `health_drug_label`, `health_drug_recalls`, `health_drug_adverse_events` | CMS NPPES NPI Registry, FDA openFDA |
| `models` | `models_fit_check`, `models_estimate_vram`, `models_gguf_files`, `models_search_hf`, `models_gpu_catalog` | Hugging Face Hub plus built-in VRAM math |

Every tool is annotated read-only. EMS results are education and reference, not medical direction; health data is not medical advice; legal data is not legal advice. Each response repeats the notice.

## Use it

Server URL: `https://thefiredev.com/mcp` (landing page, docs and pricing: https://thefiredev.com/connectors)

```bash
# Claude Code
claude mcp add --transport http meshvault https://thefiredev.com/mcp --header "Authorization: Bearer $MESHVAULT_API_KEY"
# Codex CLI (~/.codex/config.toml)
# [mcp_servers.meshvault]
# url = "https://thefiredev.com/mcp"
# bearer_token_env_var = "MESHVAULT_API_KEY"
```

Claude and ChatGPT custom connectors use OAuth: add the URL, and the sign-in page asks for a key or creates a free one. `/mcp/try` needs no credentials and allows 10 calls a day per network. Gemini CLI: `gemini extensions install https://github.com/thefiredev-cloud/meshvault-connectors` (set `MESHVAULT_API_KEY`).

Cursor, VS Code and other clients that read an `mcp.json`:

```json
{
  "mcpServers": {
    "meshvault": { "url": "https://thefiredev.com/mcp" }
  }
}
```

The client opens the OAuth sign-in on first use. Registry name: `io.github.thefiredev-cloud/meshvault-connectors` in the [official MCP registry](https://registry.modelcontextprotocol.io/v0/servers?search=meshvault-connectors); also listed on [Glama](https://glama.ai/mcp/connectors/io.github.thefiredev-cloud/meshvault-connectors).

## Plans

| Plan | Calls per UTC day | Price |
| --- | --- | --- |
| Anonymous (`/mcp/try`) | 10 | free |
| Free key | 100 | free |
| Pro | 5,000 | $19 / month (Stripe Checkout) |

Only `tools/call` counts. Calls rejected for bad input or failed by an upstream outage are refunded.

## Architecture

```
api/index.ts          Vercel Function entry (all dynamic routes, via vercel.json rewrites)
src/app.ts            Hono routes: /mcp, /mcp/try, /oauth/*, /api/*, /billing/success, webhook
src/mcp.ts            Stateless MCP server per request, quota + error handling around every tool
src/oauth.ts          OAuth 2.1: DCR (stateless signed client_id), code + PKCE S256, rotating refresh tokens
src/keys.ts           API keys (sha256 at rest), one-time sealed reveal after purchase
src/quota.ts          Per-day counters with compare-and-swap
src/store.ts          Private Vercel Blob store (ETag CAS), file and memory stores for dev and tests
src/billing.ts        Checkout, portal, webhook: issue / upgrade / revoke / downgrade keys, idempotent
src/tools/*.ts        The four tool groups
public/               Landing page, docs, privacy, terms
```

State lives in one private Vercel Blob store (`keys/`, `usage/`, `customers/`, `events/`, `oauth/`). Writes use ETag compare-and-swap, so concurrent calls cannot overspend a quota.

OAuth refresh tokens are claimed by a compare-and-swap update. A reused token, including a losing concurrent refresh request, revokes the family. Access tokens check that family on each request, so revocation does not wait for the token's one-hour expiry.

### Billing behaviour

- Checkout with an existing key upgrades that key. Cancellation downgrades it to Free.
- Checkout without a key issues a new Pro key, shown once on the confirmation page (sealed with AES-256-GCM for 24 hours). Cancellation revokes it.
- Fulfillment runs from both the webhook and the confirmation page. Both check Stripe's current subscription status, customer and configured Pro price before granting access; late event snapshots and reused success links cannot restore a canceled subscription.
- Webhook events handled: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `customer.subscription.updated`, `customer.subscription.deleted`.

## Develop

```bash
pnpm install
pnpm test            # unit and integration tests (MemoryStore, fake Stripe, real MCP SDK client)
pnpm typecheck
pnpm dev             # http://127.0.0.1:8787 with a file-backed store
pnpm exec tsx scripts/smoke.ts http://127.0.0.1:8787     # calls all 18 tools like a customer
```

Environment variables are listed in `.env.example`. Use Stripe test-mode keys until you intentionally go live; `stripe listen --forward-to localhost:8787/api/stripe/webhook` gives a local webhook secret.

## Deploy

Two supported shapes:

**Own Vercel project.** Import this repo (framework: Other; settings are in `vercel.json`), add a private Blob store, set the variables from `.env.example`, add the webhook endpoint `https://<host>/api/stripe/webhook` for the four events above.

**Mounted in another site** (how thefiredev.com runs it). `node scripts/export-mount.mjs --out <host repo> --prefix /connectors` writes one bundled Vercel Function (`api/connectors.js`) and the static pages under `public/connectors/`; `--rewrites <file>` also writes the `vercel.json` rewrites the host must contain. The host sets `CONNECTORS_*` variables (`CONNECTORS_APP_SECRET`, `CONNECTORS_PUBLIC_BASE_URL`, `CONNECTORS_LANDING_PATH`, `CONNECTORS_STRIPE_SECRET_KEY`, `CONNECTORS_STRIPE_PRICE_PRO`, `CONNECTORS_STRIPE_WEBHOOK_SECRET`) and a Blob store connected with variable prefix `CONNECTORS_BLOB`. The service owns `/mcp`, `/oauth/*`, `/.well-known/oauth-*`, `/billing/*`, `/api/keys`, `/api/usage`, `/api/checkout`, `/api/billing`, `/api/stripe`, `/health`.

Then publish `server.json` with `mcp-publisher`.

## License

MIT. Data from third-party sources keeps its own terms; see each source.
