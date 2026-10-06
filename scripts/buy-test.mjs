// Completes a Stripe Checkout Session in TEST mode with the standard 4242 test card, like a customer would.
// Usage: node scripts/buy-test.mjs <checkout-url> <screenshot-dir>   (needs playwright-core and a Chromium)
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const [url, shotDir = "/tmp/mvc-shots"] = process.argv.slice(2);
if (!url || !/^https:\/\/checkout\.stripe\.com\/c\/pay\/cs_test_/.test(url)) {
  console.error("Refusing: URL must be a TEST-mode Stripe Checkout URL (cs_test_).");
  process.exit(2);
}
mkdirSync(shotDir, { recursive: true });
const exe = process.env.CHROMIUM_PATH ?? `${process.env.HOME}/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`;
const browser = await chromium.launch({ executablePath: exe, headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 1300 } });
await page.goto(url, { waitUntil: "load" });
await page.waitForSelector("#cardNumber, #email, [data-testid=card-accordion-item-button]", { state: "attached", timeout: 60_000 });
await page.waitForTimeout(2500);
await page.screenshot({ path: `${shotDir}/1-checkout.png` });
if (await page.locator("#email").count()) await page.locator("#email").fill("buyer-test@example.com");
if (!(await page.locator("#cardNumber").isVisible().catch(() => false))) {
  // The Card row is a custom accordion with no radio input: click the visible "Card" label.
  const rect = await page.evaluate(() => {
    const el = [...document.querySelectorAll("span,div,p")].find((e) => e.children.length === 0 && e.textContent?.trim() === "Card" && e.getBoundingClientRect().width > 0);
    const r = el?.getBoundingClientRect();
    return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
  });
  if (!rect) throw new Error("Card payment row not found");
  await page.mouse.click(rect.x, rect.y);
}
await page.waitForSelector("#cardNumber", { state: "visible", timeout: 30_000 });
// Do not create a Link account: untick "Save my information".
const save = page.locator("#enableStripePass");
if (await save.count()) {
  if (await save.isChecked()) await save.uncheck();
}
await page.locator("#cardNumber").fill("4242424242424242");
await page.locator("#cardExpiry").fill("12 / 34");
await page.locator("#cardCvc").fill("123");
const name = page.locator("#billingName");
if (await name.count()) await name.fill("Test Buyer");
const zip = page.locator("#billingPostalCode");
if (await zip.count()) await zip.fill("90210");
await page.screenshot({ path: `${shotDir}/2-filled.png` });
await page.locator("button[type=submit]").first().click();
await page.waitForURL(/\/billing\/success/, { timeout: 120_000 });
await page.waitForLoadState("load");
await page.screenshot({ path: `${shotDir}/3-success.png` });
const body = await page.locator("main").innerText();
console.log(JSON.stringify({ finalUrl: page.url().replace(/session_id=[^&]+/, "session_id=<redacted>"), text: body }));
await browser.close();
