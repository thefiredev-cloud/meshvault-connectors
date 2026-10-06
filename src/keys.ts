/** API key lifecycle: issue, verify, upgrade, revoke. Raw keys are never stored, only their SHA-256. */
import { createHash, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { update, type Store } from "./store.js";
import type { PlanId } from "./config.js";

export type KeyPlan = Exclude<PlanId, "anonymous">;

export interface KeyRecord {
  /** Public identifier, first 24 hex chars of sha256(rawKey). Safe to log and to put in Stripe metadata. */
  id: string;
  plan: KeyPlan;
  status: "active" | "revoked";
  /** How the key came to exist: self-served free key, or issued by a completed purchase. */
  origin: "free" | "paid";
  email?: string;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  createdAt: string;
  updatedAt: string;
  revokedReason?: string;
}

export const KEY_PREFIX = "mvc_";

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export function keyIdFor(rawKey: string): string {
  return sha256Hex(rawKey).slice(0, 24);
}

export function looksLikeKey(s: string): boolean {
  return /^mvc_[A-Za-z0-9_-]{43}$/.test(s);
}

export function generateRawKey(): string {
  return KEY_PREFIX + randomBytes(32).toString("base64url");
}

const keyPath = (id: string) => `keys/${id}.json`;

const cache = new Map<string, { until: number; rec: KeyRecord | null }>();
const CACHE_MS = 10_000;

export function clearKeyCache(): void {
  cache.clear();
}

export async function getKeyById(store: Store, id: string, fresh = false): Promise<KeyRecord | null> {
  const now = Date.now();
  const hit = cache.get(id);
  if (!fresh && hit && hit.until > now) return hit.rec;
  const got = await store.get<KeyRecord>(keyPath(id));
  const rec = got?.value ?? null;
  cache.set(id, { until: now + CACHE_MS, rec });
  return rec;
}

/** Returns the active record for a raw key, or null when unknown or revoked. */
export async function verifyRawKey(store: Store, rawKey: string): Promise<KeyRecord | null> {
  if (!looksLikeKey(rawKey)) return null;
  const rec = await getKeyById(store, keyIdFor(rawKey));
  return rec && rec.status === "active" ? rec : null;
}

export async function issueKey(
  store: Store,
  init: { plan: KeyPlan; origin: KeyRecord["origin"]; email?: string; stripeCustomerId?: string; stripeSubscriptionId?: string },
): Promise<{ rawKey: string; record: KeyRecord }> {
  const rawKey = generateRawKey();
  const id = keyIdFor(rawKey);
  const now = new Date().toISOString();
  const record: KeyRecord = { id, status: "active", createdAt: now, updatedAt: now, ...init };
  await store.put(keyPath(id), record, { createOnly: true });
  cache.delete(id);
  return { rawKey, record };
}

export async function updateKey(
  store: Store,
  id: string,
  patch: (rec: KeyRecord) => Partial<KeyRecord>,
): Promise<KeyRecord | undefined> {
  const out = await update<KeyRecord>(store, keyPath(id), (cur) => {
    if (!cur) return undefined;
    return { ...cur, ...patch(cur), updatedAt: new Date().toISOString() };
  });
  cache.delete(id);
  return out;
}

export async function setCustomerKey(store: Store, customerId: string, keyId: string): Promise<void> {
  await update<{ keyId: string }>(store, `customers/${customerId}.json`, () => ({ keyId }));
}

export async function keyIdForCustomer(store: Store, customerId: string): Promise<string | null> {
  const got = await store.get<{ keyId: string }>(`customers/${customerId}.json`);
  return got?.value.keyId ?? null;
}

/* One-time reveal of a freshly purchased key. AES-256-GCM under a server secret; deleted after the reveal window. */

function aesKey(secret: string): Buffer {
  return createHash("sha256").update(`reveal:${secret}`).digest();
}

export function sealKey(rawKey: string, secret: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", aesKey(secret), iv);
  const ct = Buffer.concat([c.update(rawKey, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64url");
}

export function openKey(sealed: string, secret: string): string {
  const b = Buffer.from(sealed, "base64url");
  const d = createDecipheriv("aes-256-gcm", aesKey(secret), b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
}
