// Player reports: "this question / answer / word is wrong or offensive". Sent from the small Report button on each
// game page (and the footer link); read and closed by the team on the admin page's Reports tab.
//
//   POST /api/report {uid, game, lg, kind, text, ctx}   anyone; a few an hour per address and per player
//   GET  /api/admin/reports?status=open|done|all        team (view)
//   action reports.close {id, done}                      team (review), through the audit log so it can be undone
//
// Kept in one list in harf_meta ("reports"), newest last, at most 1000 (the oldest closed ones go first).
const store = require("./store");
const limits = require("./limits");
const mod = require("./mod");
const { ID_RE, baseId } = require("./ident");

const GAMES = ["hangman", "trivia", "harf", "site"];
const KINDS = ["wrong", "question", "offensive", "bug", "other"];
const MAX = 1000;
const clip = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "").trim().slice(0, n);

let list = null, saving = Promise.resolve();
async function load() { if (!list) { const v = await store.metaGet("reports").catch(() => null); if (!list) list = Array.isArray(v) ? v : []; } return list; }
function save() { saving = saving.then(() => store.metaPut("reports", list)).catch(e => console.error("Reports: saving", e.message)); return saving; }
function trim() {
  while (list.length > MAX) {
    const i = list.findIndex(r => r.status === "done");
    list.splice(i >= 0 ? i : 0, 1);
  }
}

// the page's own description of what was on screen: short strings only
function cleanCtx(c) {
  const out = {};
  if (!c || typeof c !== "object" || Array.isArray(c)) return out;
  for (const [k, v] of Object.entries(c).slice(0, 12)) {
    if (!/^[a-z][a-zA-Z0-9]{0,15}$/.test(k)) continue;
    if (typeof v === "string") out[k] = clip(v, 300);
    else if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    else if (Array.isArray(v)) out[k] = v.slice(0, 8).map(x => clip(x, 80));
  }
  return out;
}

async function add(body, ip) {
  const game = GAMES.includes(body.game) ? body.game : "site";
  const kind = KINDS.includes(body.kind) ? body.kind : "other";
  const text = clip(body.text, 600);
  const ctx = cleanCtx(body.ctx);
  if (!text && !Object.keys(ctx).length) return [400, { error: "Tell us what's wrong" }];
  const uid = ID_RE.test(baseId(String(body.uid || ""))) ? baseId(String(body.uid)) : "";
  if (!limits.take("rep|" + ip, 8, 3600) || (uid && !limits.take("repu|" + uid, 8, 3600))) return [429, { error: "Thanks! That's plenty of reports for now. Try again later." }];
  await load();
  const r = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), at: Date.now(), game, lg: body.lg === "ar" ? "ar" : body.lg === "en" ? "en" : "", kind, text, ctx, uid, status: "open" };
  list.push(r); trim(); await save();
  return [200, { ok: true }];
}

mod.register("reports.close", {
  perm: "review",
  doc: "mark a player report as dealt with (done: true) or open it again (done: false)",
  args: '{"id": "<report id>", "done": true|false}',
  async run(a, who) {
    await load();
    const r = list.find(x => x.id === a.id);
    if (!r) throw new mod.Fail(404, "No such report");
    const was = r.status === "done";
    r.status = a.done === false ? "open" : "done";
    r.by = r.status === "done" ? (who && who.name) || "" : "";
    r.closedAt = r.status === "done" ? Date.now() : 0;
    await save();
    return { sum: `${r.status === "done" ? "closed" : "reopened"} report ${r.id} (${r.game})`, undo: { act: "reports.close", args: { id: r.id, done: was } } };
  },
});

async function handle(req, res, url, { send, readJson, ip }) {
  const p = url.pathname;
  if (p === "/api/report" && req.method === "POST") {
    const [code, out] = await add((await readJson(req)) || {}, ip);
    send(res, code, out);
    return true;
  }
  if (p === "/api/admin/reports" && req.method === "GET") {
    if (!mod.auth(req, res, send, "view")) return true;
    await load();
    const st = url.searchParams.get("status") || "open";
    const out = list.filter(r => st === "all" || r.status === st).slice(-300).reverse();
    send(res, 200, { list: out, open: list.filter(r => r.status === "open").length });
    return true;
  }
  return false;
}

module.exports = { handle, GAMES, KINDS, _reset: () => { list = null; } };
