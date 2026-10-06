/** Daily call quota using per-subject, per-UTC-day counters with compare-and-swap increments. */
import { PLANS, type PlanId } from "./config.js";
import { sha256Hex } from "./keys.js";
import { update, type Store } from "./store.js";

export interface Principal {
  plan: PlanId;
  /** `k:<keyId>` for keys, `ip:<hash>` for anonymous callers. */
  subject: string;
  keyId?: string;
}

export interface QuotaResult {
  allowed: boolean;
  used: number;
  limit: number;
  plan: PlanId;
  resetsAt: string;
}

export function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function nextUtcMidnight(now = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return d.toISOString();
}

export function anonymousSubject(ip: string, salt: string): string {
  return `ip:${sha256Hex(`${salt}|${ip}`).slice(0, 20)}`;
}

export async function consume(store: Store, principal: Principal, now = new Date()): Promise<QuotaResult> {
  const plan = PLANS[principal.plan];
  const path = `usage/${principal.subject.replace(":", "-")}/${utcDay(now)}.json`;
  let denied = false;
  let used = 0;
  const written = await update<{ n: number }>(store, path, (cur) => {
    const n = cur?.n ?? 0;
    if (n >= plan.dailyCalls) {
      denied = true;
      used = n;
      return undefined;
    }
    return { n: n + 1 };
  });
  if (written) used = written.n;
  return {
    allowed: !denied,
    used,
    limit: plan.dailyCalls,
    plan: principal.plan,
    resetsAt: nextUtcMidnight(now),
  };
}

/** Counts attempts of a non-tool action (for example free key creation) per IP per day. Returns false when over `max`. */
export async function hit(store: Store, bucket: string, subject: string, max: number, now = new Date()): Promise<boolean> {
  const path = `limits/${bucket}/${subject.replace(":", "-")}/${utcDay(now)}.json`;
  let ok = true;
  await update<{ n: number }>(store, path, (cur) => {
    const n = cur?.n ?? 0;
    if (n >= max) {
      ok = false;
      return undefined;
    }
    return { n: n + 1 };
  });
  return ok;
}

/** Gives one call back, used when an upstream data source failed through no fault of the caller. */
export async function refund(store: Store, principal: Principal, now = new Date()): Promise<void> {
  const path = `usage/${principal.subject.replace(":", "-")}/${utcDay(now)}.json`;
  await update<{ n: number }>(store, path, (cur) => (cur && cur.n > 0 ? { n: cur.n - 1 } : undefined));
}
