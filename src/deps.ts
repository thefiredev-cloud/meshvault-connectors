import type Stripe from "stripe";
import type { Env } from "./config.js";
import type { Store } from "./store.js";

/** Everything the HTTP app needs from the outside world. Tests substitute fakes. */
export interface Deps {
  store: Store;
  env: Env;
  /** Lazily built so routes that never touch Stripe work without a key. */
  stripe: () => Stripe;
  fetchImpl?: typeof fetch;
}
