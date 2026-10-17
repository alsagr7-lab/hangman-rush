// Admin: page-visit counts (a beacon from each page), an overview per game, and hiding players from leaderboards.
// Admin routes need the ADMIN_KEY in an x-admin-key header; /api/hit is public.
const crypto = require("crypto");
const R = require("./site/shared/rules");
const store = require("./store");

const ADMIN_KEY = process.env.ADMIN_KEY || "";
const PAGES = ["home", "hangman", "trivia", "harf"];
const GAMES = ["hangman", "trivia", "harf"];
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const DAY = R.DAY;
const dayKey = t => new Date(t).toISOString().slice(0, 10);

function adminOk(req) {
  const k = String(req.headers["x-admin-key"] || "");
  if (!ADMIN_KEY || !k) return false;
  const a = crypto.createHash("sha256").update(k).digest(), b = crypto.createHash("sha256").update(ADMIN_KEY).digest();
  return crypto.timingSafeEqual(a, b);
}

/* ---------- visits ----------
   Each page load sends {p: page, v: the device's player id}. Counted per UTC day as page views plus unique devices
   (a short hash of the id; no IPs, nothing else). Kept in memory and saved once a minute, 35 days kept. */
const visits = new Map(); // day -> {page: {v, u: Set}}
const loaded = new Set();
let saving = Promise.resolve();
async function dayRec(d) {
  if (!visits.has(d)) {
    visits.set(d, {});
    if (!loaded.has(d)) {
      loaded.add(d);
      const saved = await store.metaGet("visits:" + d).catch(() => null);
      const rec = visits.get(d);
      for (const [p, x] of Object.entries(saved || {})) {
        const cur = rec[p] || { v: 0, u: new Set() };
        cur.v += Number(x.v) || 0;
        for (const h of x.u || []) cur.u.add(h);
        rec[p] = cur;
      }
    }
  }
  return visits.get(d);
}
let dirty = new Set();
async function hit(page, vid) {
  const d = dayKey(Date.now()), rec = await dayRec(d);
  const x = (rec[page] = rec[page] || { v: 0, u: new Set() });
  x.v++;
  if (vid && x.u.size < 20000) x.u.add(crypto.createHash("sha256").update("v|" + vid).digest("hex").slice(0, 10));
  dirty.add(d);
}
function flush() {
  saving = saving.then(async () => {
    const days = [...dirty]; dirty = new Set();
    for (const d of days) {
      const out = {};
      for (const [p, x] of Object.entries(visits.get(d) || {})) out[p] = { v: x.v, u: [...x.u] };
      await store.metaPut("visits:" + d, out).catch(e => { dirty.add(d); console.error("Admin: saving visits", e.message); });
    }
    // forget days older than 2 in memory, and old days in storage now and then
    for (const d of visits.keys()) if (d < dayKey(Date.now() - 2 * DAY)) { visits.delete(d); }
    if (Math.random() < 0.05) await store.metaPruneBefore("visits:", "visits:" + dayKey(Date.now() - 35 * DAY)).catch(() => {});
  });
  return saving;
}
setInterval(flush, 60000).unref();
for (const sig of ["SIGTERM", "SIGINT"]) process.once(sig, () => { flush().finally(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); });

async function visitSummary() {
  await flush();
  const now = Date.now(), from = dayKey(now - 29 * DAY);
  const rows = await store.metaSince("visits:", "visits:" + from).catch(() => []);
  const byDay = {};
  for (const { k, v } of rows) byDay[k.slice(7)] = v || {};
  const span = n => {
    const t = {}, uAll = {};
    for (let i = 0; i < n; i++) {
      const d = dayKey(now - i * DAY), rec = byDay[d] || {};
      for (const p of PAGES) {
        const x = rec[p]; if (!x) continue;
        t[p] = t[p] || { views: 0, visitors: 0 }; uAll[p] = uAll[p] || new Set();
        t[p].views += Number(x.v) || 0; for (const h of x.u || []) uAll[p].add(h);
      }
    }
    const all = new Set(); let views = 0;
    for (const p of Object.keys(t)) { t[p].visitors = uAll[p].size; views += t[p].views; for (const h of uAll[p]) all.add(h); }
    return { pages: t, views, visitors: all.size };
  };
  const days = [];
  for (let i = 0; i < 14; i++) {
    const d = dayKey(now - i * DAY), rec = byDay[d] || {}, all = new Set(); let views = 0;
    for (const p of PAGES) if (rec[p]) { views += Number(rec[p].v) || 0; for (const h of rec[p].u || []) all.add(h); }
    days.push({ d, views, visitors: all.size });
  }
  return { day: span(1), week: span(7), month: span(30), days };
}

/* ---------- hidden players ----------
   {game: [base uid]} — hidden from that game's leaderboards (both languages). Their scores are kept; unhide any time. */
let hidden = { hangman: new Set(), trivia: new Set(), harf: new Set() };
const baseId = id => String(id).replace(/_(ar|en)$/, "");
async function loadHidden() {
  const v = await store.metaGet("hidden_players").catch(() => null);
  for (const g of GAMES) hidden[g] = new Set((v && v[g]) || []);
}
const isHidden = (game, id) => hidden[game] && hidden[game].has(baseId(id));
async function setHidden(game, id, on) {
  const b = baseId(id);
  if (on) hidden[game].add(b); else hidden[game].delete(b);
  const out = {}; for (const g of GAMES) out[g] = [...hidden[g]];
  await store.metaPut("hidden_players", out);
}

/* ---------- overview ---------- */
function langOf(game, id) {
  const m = String(id).match(/_(ar|en)$/);
  if (m) return m[1];
  return game === "hangman" ? "en" : "";
}
function lastDay(d) {
  const keys = Object.keys((d && d.h) || {}).filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k)).sort();
  const ls = d && /^\d{4}-\d{2}-\d{2}$/.test(d.ls || "") ? d.ls : "";
  const last = keys.length ? keys[keys.length - 1] : "";
  return last > ls ? last : ls;
}
async function gameSummary(game) {
  const rows = game === "hangman" ? await store.all() : game === "trivia" ? await store.tAll() : await store.hAll();
  const today = R.todayKey(), wk = dayKey(Date.now() - 6 * DAY);
  const langs = {}, players = new Map();
  for (const r of rows) {
    const d = r.data || {}, lg = langOf(game, r.id), last = lastDay(d), days = Object.keys(d.h || {}).length;
    const L = (langs[lg || "all"] = langs[lg || "all"] || { players: 0, today: 0, week: 0 });
    L.players++; if (last === today) L.today++; if (last >= wk) L.week++;
    const b = baseId(r.id), p = players.get(b) || { id: b, name: "", langs: [], last: "", days: 0, hidden: isHidden(game, b) };
    p.name = p.name || R.nm16(d.n || ""); if (lg) p.langs.push(lg); if (last > p.last) p.last = last; p.days += days;
    players.set(b, p);
  }
  const list = [...players.values()].sort((a, b) => (b.last || "").localeCompare(a.last || "") || b.days - a.days);
  return { langs, total: players.size, list };
}

async function handle(req, res, url, { send, readJson }) {
  const p = url.pathname;
  if (p === "/api/hit" && req.method === "POST") {
    const body = (await readJson(req)) || {};
    const page = PAGES.includes(body.p) ? body.p : null;
    if (page) await hit(page, ID_RE.test(String(body.v || "")) ? String(body.v) : "");
    send(res, 204, "");
    return true;
  }
  if (!p.startsWith("/api/admin/")) return false;
  if (!adminOk(req)) { send(res, 403, { error: "Wrong admin key" }); return true; }
  if (p === "/api/admin/overview" && req.method === "GET") {
    const [visitsOut, hangman, trivia, harf] = await Promise.all([visitSummary(), gameSummary("hangman"), gameSummary("trivia"), gameSummary("harf")]);
    send(res, 200, { visits: visitsOut, games: { hangman, trivia, harf }, today: R.todayKey() });
    return true;
  }
  if (p === "/api/admin/hide" && req.method === "POST") {
    const body = (await readJson(req)) || {};
    if (!GAMES.includes(body.game) || !ID_RE.test(String(body.id || ""))) { send(res, 400, { error: "Expected {game, id, hide}" }); return true; }
    await setHidden(body.game, String(body.id), !!body.hide);
    send(res, 200, { ok: true });
    return true;
  }
  send(res, 404, { error: "Not found" });
  return true;
}

module.exports = { handle, isHidden, loadHidden };
