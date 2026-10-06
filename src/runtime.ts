/** Builds production dependencies from the process environment. */
import Stripe from "stripe";
import { processEnv, required } from "./config.js";
import type { Deps } from "./deps.js";
import { BlobStore, FileStore, type Store } from "./store.js";

export function buildStore(): Store {
  const dir = process.env["LOCAL_STORE_DIR"];
  if (dir) return new FileStore(dir);
  return new BlobStore(process.env["BLOB_READ_WRITE_TOKEN"]);
}

export function buildDeps(): Deps {
  let client: Stripe | undefined;
  return {
    store: buildStore(),
    env: processEnv,
    stripe: () => (client ??= new Stripe(required(processEnv, "STRIPE_SECRET_KEY"), { maxNetworkRetries: 2, appInfo: { name: "meshvault-connectors", version: "0.1.0" } })),
  };
}
