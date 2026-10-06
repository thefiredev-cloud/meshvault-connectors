import type Stripe from "stripe";
import { createApp } from "../src/app.js";
import type { Deps } from "../src/deps.js";
import { MemoryStore } from "../src/store.js";

export const BASE = "https://connectors.test";

export function makeEnv(extra: Record<string, string> = {}) {
  const vars: Record<string, string> = {
    APP_SECRET: "test-secret-test-secret-test-secret-0123456789",
    PUBLIC_BASE_URL: BASE,
    STRIPE_PRICE_PRO: "price_test_123",
    STRIPE_WEBHOOK_SECRET: "whsec_test",
    ...extra,
  };
  return { get: (n: string) => vars[n] };
}

export type FakeStripe = {
  checkout: { sessions: { create: (p: Record<string, unknown>) => Promise<unknown>; retrieve: (id: string) => Promise<unknown> } };
  billingPortal: { sessions: { create: () => Promise<{ url: string }> } };
  webhooks: { constructEventAsync: (raw: string, sig: string, secret: string) => Promise<unknown> };
  created: Record<string, unknown>[];
  sessions: Map<string, unknown>;
};

export function fakeStripe(): FakeStripe {
  const created: Record<string, unknown>[] = [];
  const sessions = new Map<string, unknown>();
  return {
    created,
    sessions,
    checkout: {
      sessions: {
        create: async (p) => {
          created.push(p);
          return { id: "cs_test_abc", url: "https://checkout.stripe.test/c/pay/cs_test_abc" };
        },
        retrieve: async (id) => {
          const s = sessions.get(id);
          if (!s) throw new Error("no such session");
          return s;
        },
      },
    },
    billingPortal: { sessions: { create: async () => ({ url: "https://billing.stripe.test/p/session" }) } },
    webhooks: {
      constructEventAsync: async (raw, sig, secret) => {
        if (sig !== `valid:${secret}`) throw new Error("No signatures found matching the expected signature for payload");
        return JSON.parse(raw);
      },
    },
  };
}

export function makeApp(opts: { fetchImpl?: typeof fetch; env?: Record<string, string>; stripe?: FakeStripe } = {}) {
  const store = new MemoryStore();
  const stripe = opts.stripe ?? fakeStripe();
  const deps: Deps = {
    store,
    env: makeEnv(opts.env),
    stripe: () => stripe as unknown as Stripe,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  };
  const app = createApp(deps);
  const fetchApp: typeof fetch = (input, init) => Promise.resolve(app.fetch(new Request(input as RequestInfo, init)));
  return { app, deps, store, stripe, fetchApp };
}

/** Canned upstream responses keyed by URL substring; first match wins. */
export function upstream(routes: [string, unknown, number?][]): typeof fetch {
  return async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    for (const [needle, body, status] of routes) {
      if (url.includes(needle)) return new Response(JSON.stringify(body), { status: status ?? 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ error: `no fake for ${url}` }), { status: 599 });
  };
}
