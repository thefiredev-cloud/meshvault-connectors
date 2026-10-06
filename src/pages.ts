/** Tiny server-rendered pages (OAuth consent, billing result). Marketing pages live in /public. */

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] as string);
}

const CSS = `
:root{color-scheme:light dark;--fg:#16181c;--bg:#fbfaf8;--mut:#5d6470;--line:#dedad3;--acc:#b8400f;--card:#fff}
@media (prefers-color-scheme:dark){:root{--fg:#ecebe8;--bg:#141516;--mut:#9aa0a8;--line:#2c2e31;--acc:#f0763a;--card:#1b1c1e}}
*{box-sizing:border-box}
body{margin:0;font:16px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--fg);display:grid;place-items:start center;min-height:100vh;padding:48px 20px}
main{width:min(460px,100%);background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px}
h1{font-size:1.35rem;line-height:1.25;margin:0 0 .6rem;letter-spacing:-.01em}
p{margin:.5rem 0;color:var(--mut)}
label{display:block;font-weight:600;margin:1.1rem 0 .35rem;font-size:.9rem}
input[type=password],input[type=email],input[type=text]{width:100%;padding:11px 12px;border:1px solid var(--line);border-radius:9px;background:transparent;color:inherit;font:inherit}
input:focus-visible,button:focus-visible,a:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
button{margin-top:.9rem;width:100%;padding:11px 14px;border-radius:9px;border:0;background:var(--acc);color:#fff;font:inherit;font-weight:600;cursor:pointer}
button.secondary{background:transparent;color:var(--fg);border:1px solid var(--line)}
.or{text-align:center;margin:1.2rem 0 0}
.err{color:#b3261e;font-weight:600}
.fine{font-size:.82rem}
pre.key{background:rgba(127,127,127,.12);padding:12px;border-radius:9px;overflow-wrap:anywhere;white-space:pre-wrap;font:.88rem ui-monospace,SFMono-Regular,Menlo,monospace;user-select:all}
a{color:var(--acc)}
`;

export function pageShell(title: string, body: string, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title><style>${CSS}</style></head><body><main>${body}</main></body></html>`;
  return new Response(html, { status: init.status ?? 200, headers: { "content-type": "text/html; charset=utf-8", ...init.headers } });
}
