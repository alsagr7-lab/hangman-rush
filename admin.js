// Admin: page-visit counts (a beacon from each page), an overview per game, and hiding players from leaderboards.
// Admin routes need the ADMIN_KEY in an x-admin-key header; /api/hit is public.
const crypto = require("crypto");
const R = require("./site/shared/rules");
const store = require("./store");
const limits = require("./limits");
const mod = require("./mod");

const PAGES = ["home", "hangman", "trivia", "harf"];
const GAMES = ["hangman", "trivia", "harf"];
const { ID_RE, baseId } = require("./ident");
const DAY = R.DAY;
const dayKey = t => new Date(t).toISOString().slice(0, 10);

// -> true when the request carries a team key with this permission; otherwise answers it (see mod.js)
const checkAdmin = (req, res, send, perm = "view") => !!mod.auth(req, res, send, perm);

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

mod.register("players.hide", {
  perm: "players",
  doc: "hide a player from one game's leaderboards (both languages), or show them again; scores are kept",
  args: '{"game": "hangman|trivia|harf", "id": "<player id>", "hide": true|false}',
  async run(a) {
    if (!GAMES.includes(a.game) || !ID_RE.test(baseId(a.id))) throw new mod.Fail(400, "Expected {game, id, hide}");
    const was = isHidden(a.game, a.id);
    await setHidden(a.game, String(a.id), !!a.hide);
    return { sum: `${a.hide ? "hid" : "showed"} ${baseId(a.id)} on ${a.game}`, undo: { act: "players.hide", args: { game: a.game, id: a.id, hide: was } } };
  },
});

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

async function handle(req, res, url, { send, readJson, ip }) {
  const p = url.pathname;
  if (p === "/api/hit" && req.method === "POST") {
    const body = (await readJson(req)) || {};
    const page = PAGES.includes(body.p) ? body.p : null;
    // a few page loads a minute per address count; anything faster is a script inflating the numbers, ignored quietly
    if (page && limits.take("hit|" + ip, 20, 10)) await hit(page, ID_RE.test(String(body.v || "")) ? String(body.v) : "");
    send(res, 204, "");
    return true;
  }
  if (!p.startsWith("/api/admin/")) return false;
  // admin requests: a limited number a minute per address, so the key can't be guessed by trying many
  if (!limits.take("adm|" + ip, 120, 60)) { send(res, 429, { error: "Too many tries. Wait a minute." }); return true; }
  if (p === "/api/admin/overview" && req.method === "GET") {
    if (!checkAdmin(req, res, send)) return true;
    const [visitsOut, hangman, trivia, harf] = await Promise.all([visitSummary(), gameSummary("hangman"), gameSummary("trivia"), gameSummary("harf")]);
    send(res, 200, { visits: visitsOut, games: { hangman, trivia, harf }, today: R.todayKey() });
    return true;
  }
  // older page: the same as the players.hide action
  if (p === "/api/admin/hide" && req.method === "POST") {
    const w = mod.auth(req, res, send, "players"); if (!w) return true;
    const body = (await readJson(req)) || {};
    try { await mod.run(w, "players.hide", { game: body.game, id: body.id, hide: !!body.hide }, body.why); send(res, 200, { ok: true }); }
    catch (e) { send(res, e.code || 500, { error: e.message }); }
    return true;
  }
  if (!checkAdmin(req, res, send)) return true;
  send(res, 404, { error: "Not found" });
  return true;
}

module.exports = { handle, isHidden, loadHidden, setHidden, checkAdmin };
