(() => {
  const origin = location.origin;
  for (const el of document.querySelectorAll("[data-origin]")) el.textContent = origin + el.getAttribute("data-origin");
  for (const el of document.querySelectorAll("[data-origin-block]")) el.textContent = el.textContent.replaceAll("__ORIGIN__", origin);

  const tabs = [...document.querySelectorAll('[role="tab"]')];
  for (const tab of tabs) {
    tab.addEventListener("click", () => {
      for (const t of tabs) {
        const on = t === tab;
        t.setAttribute("aria-selected", String(on));
        document.getElementById(t.getAttribute("aria-controls")).hidden = !on;
      }
    });
  }

  const text = (tag, s, cls) => {
    const e = document.createElement(tag);
    e.textContent = s;
    if (cls) e.className = cls;
    return e;
  };

  async function post(path, body, headers) {
    const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    let j = {};
    try { j = await r.json(); } catch { /* non-JSON error body */ }
    return { ok: r.ok, status: r.status, body: j };
  }

  const validEmail = (s) => /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/.test(s);

  document.getElementById("free-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const out = document.getElementById("free-out");
    out.replaceChildren();
    const email = document.getElementById("free-email").value.trim();
    if (!validEmail(email)) return void out.append(text("p", "Enter a valid email address.", "err"));
    const res = await post("/api/keys/free", { email });
    if (!res.ok) return void out.append(text("p", res.status === 429 ? "Too many keys from this network today. Try again tomorrow." : "Could not create a key. Try again.", "err"));
    out.append(text("p", "Your key. Save it now, it is shown once:"), text("pre", res.body.api_key));
  });

  document.getElementById("pro-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const out = document.getElementById("pro-out");
    out.replaceChildren();
    const email = document.getElementById("pro-email").value.trim();
    const key = document.getElementById("pro-key").value.trim();
    if (!key && !validEmail(email)) return void out.append(text("p", "Enter a valid email address.", "err"));
    const res = await post("/api/checkout", validEmail(email) ? { email } : {}, key ? { authorization: `Bearer ${key}` } : {});
    if (res.ok && res.body.url) return void (location.href = res.body.url);
    const msg = res.body.error === "already_pro" ? "That key is already on Pro." : res.status === 401 ? "That key was not recognized." : "Checkout is unavailable right now. Try again shortly.";
    out.append(text("p", msg, "err"));
  });
})();
