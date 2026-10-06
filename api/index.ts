import { createApp } from "../src/app.js";
import { buildDeps } from "../src/runtime.js";

const app = createApp(buildDeps());

/**
 * vercel.json rewrites every public path to this single function and passes the original path in `__path`,
 * so routing never depends on how the platform reports the rewritten URL.
 */
function restoreOriginalPath(request: Request): Request {
  const url = new URL(request.url);
  const original = url.searchParams.get("__path");
  if (!original) return request;
  url.searchParams.delete("__path");
  url.pathname = original.startsWith("/") ? original : `/${original}`;
  return new Request(url, request);
}

export default {
  fetch(request: Request): Response | Promise<Response> {
    return app.fetch(restoreOriginalPath(request));
  },
};
