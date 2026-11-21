// Upload and offline rules shared by the app (app.js), the service worker (sw.js, via importScripts) and the tests.
// Plain functions on globalThis.VenstockSync, with no import/export, so the same file works as a page script, a
// service worker script and a Node module.
(function (root) {
  // What an upload's HTTP status means for a sale saved on this device.
  //   done:   2xx, the server has it (a repeat upload answers 200 too)
  //   failed: 400 or 422, the server will never accept it as it is; a person has to look at it
  //   retry:  everything else: offline (0), logged out (401), suspended (403), unknown shop (404), conflict (409),
  //           too many requests (429), server trouble (5xx). The sale stays queued.
  function classifyUpload(status) {
    if (status >= 200 && status < 300) return "done";
    if (status === 400 || status === 422) return "failed";
    return "retry";
  }

  // One pass over the queue, oldest first. post(sale) resolves to { status, error } (status 0 = no connection).
  // Stops at the first "retry" so a shop that's offline, logged out or having trouble isn't hammered, and so sales
  // keep their order. Returns { pending, failed, stopped } with the sales still queued, the ones newly failed (with
  // the server's reason), and the status that stopped the pass (or null).
  async function uploadPending(queue, post, now = () => new Date().toISOString()) {
    const pending = [...queue], failed = [];
    while (pending.length) {
      const sale = pending[0];
      let r;
      try { r = await post(sale); } catch { r = { status: 0 }; }
      const kind = classifyUpload(r.status);
      if (kind === "retry") return { pending, failed, stopped: r.status };
      pending.shift();
      if (kind === "failed") failed.push({ sale, status: r.status, error: r.error || `Refused (${r.status})`, at: now() });
    }
    return { pending, failed, stopped: null };
  }

  // Service worker strategy for the app shell (never /api). Network first so updates show up:
  //   200-299: cache a copy, show it;
  //   500, 502, 503, 504: the server is having trouble: show the cached copy if there is one;
  //   anything else (404, 403, ...): show it as it is. Never cached, never hidden: an unknown or closed shop must
  //   not look like it still works;
  //   no connection: the cached copy, or the cached app page.
  const SERVER_TROUBLE = new Set([500, 502, 503, 504]);
  async function shellFetch(request, { fetch, cache }) {
    let res;
    try { res = await fetch(request); } catch {
      return (await cache.match(request)) || (await cache.match("/")) || Response.error();
    }
    if (res.ok) { await cache.put(request, res.clone()); return res; }
    if (SERVER_TROUBLE.has(res.status)) return (await cache.match(request)) || res;
    return res;
  }

  // CSV of failed sales, so a vendor can keep a record of them before removing them from the device.
  function failedCsv(failed) {
    const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const rows = ["time,register,payment,items,device_total,discount,notes,reason,sale_id"];
    for (const f of failed) {
      const s = f.sale;
      const sub = (s.items || []).reduce((t, i) => t + (i.qty || 0) * (i.price_cents || 0), 0);
      rows.push([s.created_at, cell(s.register), s.payment_method, cell((s.items || []).map((i) => `${i.qty}x ${i.name}`).join("; ")),
        ((sub - (s.discount_cents || 0)) / 100).toFixed(2), ((s.discount_cents || 0) / 100).toFixed(2), cell(s.notes), cell(f.error), s.client_id].join(","));
    }
    return rows.join("\n");
  }

  root.VenstockSync = { classifyUpload, uploadPending, shellFetch, failedCsv };
})(globalThis);
