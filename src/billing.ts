/**
 * Stripe billing: Checkout (subscription), customer portal, and the webhook that issues and revokes keys.
 *
 * Fulfillment is idempotent and runs from both the webhook and the success page, so a late webhook never strands a buyer.
 *  - Checkout started with an existing key  -> that key is upgraded to Pro; cancellation downgrades it back to Free.
 *  - Checkout started without a key         -> a new Pro key is issued; cancellation revokes it.
 */
import { randomBytes } from "node:crypto";
import type Stripe from "stripe";
import { docsUrl, pricingUrl, required } from "./config.js";
import type { Deps } from "./deps.js";
import { getKeyById, issueKey, keyIdForCustomer, openKey, sealKey, setCustomerKey, updateKey } from "./keys.js";
import { ConflictError, update } from "./store.js";

const APP_TAG = "meshvault-connectors";
const REVEAL_WINDOW_MS = 24 * 3600 * 1000;

function randomLetters(n: number): string {
  const bytes = randomBytes(n);
  return Array.from(bytes, (b) => String.fromCharCode(97 + (b % 26))).join("");
}

export interface CheckoutInput {
  base: string;
  keyId?: string;
  email?: string;
}

export async function createCheckoutSession(deps: Deps, input: CheckoutInput): Promise<{ url: string; id: string }> {
  const price = required(deps.env, "STRIPE_PRICE_PRO");
  const stripe = deps.stripe();
  const existing = input.keyId ? await getKeyById(deps.store, input.keyId, true) : null;
  if (input.keyId && (!existing || existing.status !== "active")) throw new Error("key_not_active");
  if (existing?.plan === "pro") throw new Error("already_pro");
  const meta = { app: APP_TAG, key_id: input.keyId ?? "" };
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price, quantity: 1 }],
    success_url: `${input.base}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: pricingUrl(deps.env, input.base),
    allow_promotion_codes: true,
    metadata: meta,
    subscription_data: { metadata: meta },
    integration_identifier: `${APP_TAG}-${randomLetters(8)}`,
    ...(input.keyId ? { client_reference_id: input.keyId } : {}),
    ...(existing?.stripeCustomerId ? { customer: existing.stripeCustomerId } : input.email ? { customer_email: input.email } : {}),
  });
  if (!session.url) throw new Error("stripe_no_url");
  return { url: session.url, id: session.id };
}

export async function createPortalSession(deps: Deps, keyId: string, base: string): Promise<string> {
  const rec = await getKeyById(deps.store, keyId, true);
  if (!rec?.stripeCustomerId) throw new Error("no_customer");
  const s = await deps.stripe().billingPortal.sessions.create({ customer: rec.stripeCustomerId, return_url: docsUrl(deps.env, base) });
  return s.url;
}

const id = (v: string | { id: string } | null | undefined): string | undefined => (typeof v === "string" ? v : v?.id);

/** Turns a paid subscription Checkout Session into entitlement. Safe to call repeatedly. */
export async function fulfillCheckoutSession(deps: Deps, session: Stripe.Checkout.Session): Promise<{ keyId: string; issued: boolean }> {
  if (session.mode !== "subscription") throw new Error("not_subscription");
  if (session.payment_status !== "paid" && session.payment_status !== "no_payment_required") throw new Error("not_paid");
  const customerId = id(session.customer);
  const subscriptionId = id(session.subscription);
  if (!customerId || !subscriptionId) throw new Error("missing_customer_or_subscription");
  const email = session.customer_details?.email ?? session.customer_email ?? undefined;
  const upgradeKeyId = session.metadata?.["key_id"] || undefined;

  if (upgradeKeyId) {
    const rec = await updateKey(deps.store, upgradeKeyId, (cur) => ({
      plan: "pro",
      status: cur.status === "revoked" && cur.origin === "paid" ? "revoked" : cur.status,
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscriptionId,
    }));
    if (!rec) throw new Error("upgrade_key_missing");
    await setCustomerKey(deps.store, customerId, upgradeKeyId);
    return { keyId: upgradeKeyId, issued: false };
  }

  const marker = `fulfilled/${session.id}.json`;
  const prior = await deps.store.get<{ keyId: string }>(marker);
  if (prior) return { keyId: prior.value.keyId, issued: false };
  const { rawKey, record } = await issueKey(deps.store, {
    plan: "pro",
    origin: "paid",
    ...(email ? { email } : {}),
    stripeCustomerId: customerId,
    stripeSubscriptionId: subscriptionId,
  });
  try {
    await deps.store.put(marker, { keyId: record.id, reveal: sealKey(rawKey, required(deps.env, "APP_SECRET")), revealUntil: Date.now() + REVEAL_WINDOW_MS }, { createOnly: true });
  } catch (err) {
    if (err instanceof ConflictError) {
      // A concurrent fulfillment won; discard the key we just made.
      await updateKey(deps.store, record.id, () => ({ status: "revoked", revokedReason: "duplicate_fulfillment" }));
      const won = await deps.store.get<{ keyId: string }>(marker);
      return { keyId: won?.value.keyId ?? record.id, issued: false };
    }
    throw err;
  }
  await setCustomerKey(deps.store, customerId, record.id);
  return { keyId: record.id, issued: true };
}

/** Returns the freshly issued key for a purchase, once the buyer returns from Checkout. */
export async function revealPurchasedKey(
  deps: Deps,
  sessionId: string,
): Promise<{ status: "ready"; key: string } | { status: "expired" } | { status: "upgraded"; keyId: string } | { status: "pending" }> {
  if (!/^cs_(test|live)_[A-Za-z0-9]+$/.test(sessionId)) return { status: "pending" };
  const session = await deps.stripe().checkout.sessions.retrieve(sessionId);
  if (session.metadata?.["app"] !== APP_TAG) return { status: "pending" };
  if (session.payment_status !== "paid" && session.payment_status !== "no_payment_required") return { status: "pending" };
  const out = await fulfillCheckoutSession(deps, session);
  if (!out.issued) {
    const got = await deps.store.get<{ keyId: string; reveal?: string; revealUntil?: number }>(`fulfilled/${sessionId}.json`);
    if (!got) return { status: "upgraded", keyId: out.keyId };
    if (!got.value.reveal || (got.value.revealUntil ?? 0) < Date.now()) return { status: "expired" };
    return { status: "ready", key: openKey(got.value.reveal, required(deps.env, "APP_SECRET")) };
  }
  const got = await deps.store.get<{ reveal: string }>(`fulfilled/${sessionId}.json`);
  return got ? { status: "ready", key: openKey(got.value.reveal, required(deps.env, "APP_SECRET")) } : { status: "pending" };
}

async function keyIdForSubscription(deps: Deps, sub: Stripe.Subscription): Promise<string | null> {
  const meta = sub.metadata?.["key_id"];
  const customerId = id(sub.customer);
  const mapped = customerId ? await keyIdForCustomer(deps.store, customerId) : null;
  return mapped ?? (meta || null);
}

const ENDED = new Set<Stripe.Subscription.Status>(["canceled", "unpaid", "incomplete_expired"]);

async function applySubscription(deps: Deps, sub: Stripe.Subscription): Promise<void> {
  const keyId = await keyIdForSubscription(deps, sub);
  // Subscription events can beat the checkout event; let Stripe retry until the key mapping exists.
  if (!keyId) throw new Error("subscription_key_not_found_yet");
  if (ENDED.has(sub.status)) {
    await updateKey(deps.store, keyId, (cur) =>
      cur.origin === "paid" ? { status: "revoked", revokedReason: `subscription_${sub.status}`, plan: "free" } : { plan: "free" },
    );
  } else if (sub.status === "active" || sub.status === "trialing") {
    await updateKey(deps.store, keyId, () => ({ plan: "pro", stripeSubscriptionId: sub.id }));
  }
}

export type WebhookOutcome = { handled: boolean; type: string; duplicate?: boolean };

export async function handleWebhook(deps: Deps, rawBody: string, signature: string | undefined): Promise<WebhookOutcome> {
  if (!signature) throw new Error("missing_signature");
  const secret = required(deps.env, "STRIPE_WEBHOOK_SECRET");
  const event = await deps.stripe().webhooks.constructEventAsync(rawBody, signature, secret);
  const marker = `events/${event.id}.json`;
  if (await deps.store.get(marker)) return { handled: false, type: event.type, duplicate: true };

  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.metadata?.["app"] !== APP_TAG) return { handled: false, type: event.type };
      if (session.mode === "subscription" && (session.payment_status === "paid" || session.payment_status === "no_payment_required")) {
        await fulfillCheckoutSession(deps, session);
      }
      break;
    }
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      if (sub.metadata?.["app"] !== APP_TAG) return { handled: false, type: event.type };
      await applySubscription(deps, sub);
      break;
    }
    default:
      return { handled: false, type: event.type };
  }
  await update(deps.store, marker, () => ({ at: new Date().toISOString(), type: event.type }));
  return { handled: true, type: event.type };
}
