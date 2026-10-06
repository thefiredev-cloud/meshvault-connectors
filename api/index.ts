import { createApp } from "../src/app.js";
import { buildDeps } from "../src/runtime.js";

const app = createApp(buildDeps());

export default {
  fetch(request: Request): Response | Promise<Response> {
    return app.fetch(request);
  },
};
