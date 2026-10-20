// Moving the game server to a new host (e.g. the paid Frankfurt instance) without losing a result.
//
//   MOVE_MODE=readonly   the old server keeps serving pages, boards and rooms, but refuses every write with a friendly
//                        "moving" message, so nothing lands in the old database while it is copied. The owner can
//                        also switch this on and off without a restart: POST /api/move {"mode": "readonly" | ""}
//                        with the ADMIN_KEY in x-admin-key.
//   MOVE_MODE=redirect   after the move, once the old database is gone: the server starts without any database, still
//                        serves the pages (so an old onrender.com bookmark runs the page's own forwarding and carries
//                        the player to rushgames.cc), and sends every API call to MOVE_TO (default
//                        https://api.rushgames.cc) with a 308, which keeps the method and body.
//
// Writes are stopped twice: at the door (POST/PUT answered 503) and in the store (a write that slips past, such as a
// background job, does nothing), so the copy always matches what players were shown.
const R_ONLY = "readonly", REDIRECT = "redirect";
let mode = normal(process.env.MOVE_MODE);
const MOVE_TO = (process.env.MOVE_TO || "https://api.rushgames.cc").replace(/\/+$/, "");
const MSG = "Rush Games is moving to a faster server. Your results are safe; try again in a few minutes.";
let skipped = 0;

function normal(v) { v = String(v || "").trim().toLowerCase(); return v === R_ONLY || v === REDIRECT ? v : ""; }
const readOnly = () => mode === R_ONLY;
const redirecting = () => mode === REDIRECT;

// wraps the store's write methods so they do nothing while read-only
function guard(store, writes) {
  for (const k of writes) {
    const f = store[k];
    store[k] = (...a) => {
      if (!readOnly()) return f(...a);
      if (skipped++ % 50 === 0) console.warn(`Read-only (moving): skipped a ${k} write (${skipped} so far)`);
      return Promise.resolve(k.startsWith("wordsPurge") ? [] : undefined);
    };
  }
}

// -> true when the request was answered here
function handle(req, res, url, { send, readJson }, auth) {
  const p = url.pathname;
  if (redirecting()) {
    if (p === "/healthz") { send(res, 200, "ok (redirect-only)", "text/plain"); return true; }
    if (p.startsWith("/api/") || p === "/admin" || p.startsWith("/admin/")) {
      // never forward to ourselves: that would loop forever
      let same = false; try { same = new URL(MOVE_TO).host === String(req.headers.host || ""); } catch {}
      if (same) { send(res, 503, { error: MSG, moving: true }); return true; }
      res.writeHead(308, { Location: MOVE_TO + p + url.search, "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" });
      res.end();
      return true;
    }
    return false; // pages: served as usual, they forward the player themselves
  }
  if (p === "/api/move") {
    if (req.method === "GET") { send(res, 200, { mode: mode || "normal" }); return true; }
    if (req.method !== "POST") return false;
    return (async () => {
      if (!auth(req, res, send, "team")) return true; // owner only
      const b = await readJson(req);
      const want = normal(b && b.mode);
      if (want === REDIRECT) { send(res, 400, { error: "redirect mode needs MOVE_MODE=redirect and a restart (it runs without a database)" }); return true; }
      mode = want;
      console.log("Move mode:", mode || "normal");
      send(res, 200, { mode: mode || "normal" });
      return true;
    })();
  }
  if (readOnly() && (req.method === "POST" || req.method === "PUT") && p.startsWith("/api/") && p !== "/api/hit") {
    send(res, 503, { error: MSG, moving: true });
    return true;
  }
  return false;
}

module.exports = { handle, guard, readOnly, redirecting, MSG, get mode() { return mode || "normal"; } };
