// The moderation tools: the ال fix for the letter ا, the team and its permissions, agents' guard rails, Harf
// verdicts and per-answer decisions with undo, the review queue and the reading endpoints.
// Run: npm test
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startServer } = require("./helper");

test("letter ا: an ال that belongs to the word counts, the article doesn't", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rush-unit-"));
  process.env.DATA_FILE = path.join(tmp, "d.json"); process.env.DATABASE_URL = "";
  const store = require("../store"); await store.init();
  const harf = require("../harf");
  // ألمانيا is in the word list; typed with or without its hamza it's valid, القاهرة is the article + ق
  const a = await harf.check("ar", "ا", ["", "", "", "", "ألمانيا"], false, true);
  assert.equal(a[4].ok, 1); assert.ok(!a[4].l);
  const b = await harf.check("ar", "ا", ["", "", "", "", "المانيا"], false, true);
  assert.equal(b[4].ok, 1); assert.equal(b[4].f, "ألمانيا");
  const c = await harf.check("ar", "ا", ["", "", "", "", "القاهرة"], false, true);
  assert.equal(c[4].ok, 0); assert.ok(c[4].u, "not in the list under its own key, so it waits for the referee");
  // for its own letter القاهرة is still fine
  const d = await harf.check("ar", "ق", ["", "", "", "", "القاهرة"], false, true);
  assert.equal(d[4].ok, 1);
  fs.rmSync(tmp, { recursive: true, force: true });
});

let srv, BASE;
const OWNER = "owner-key-456";
before(async () => { srv = await startServer({ env: { ADMIN_KEY: OWNER } }); BASE = srv.base; });
after(() => srv.stop());

const req = (method, p, key, body) => fetch(BASE + p, { method, headers: { "Content-Type": "application/json", "x-admin-key": key }, body: body ? JSON.stringify(body) : undefined })
  .then(async r => ({ status: r.status, j: await r.json().catch(() => null) }));
const get = (p, key = OWNER) => req("GET", p, key);
const post = (p, body, key = OWNER) => req("POST", p, key, body);
const act = (act, args, key = OWNER, why = "test") => post("/api/mod/act", { act, args, why }, key);
const daily = (p, body) => fetch(BASE + "/api/harf/daily/" + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(r => r.json());

test("team: roles, permissions and agents' guard rails", async () => {
  assert.equal((await get("/api/mod/me")).j.me.role, "owner");
  assert.equal((await get("/api/mod/me", "nope")).status, 403);

  const m = await post("/api/mod/team", { op: "add", name: "Mona", role: "moderator" });
  assert.equal(m.status, 200); assert.match(m.j.key, /^rg_md_/);
  const MOD = m.j.key;
  assert.equal((await get("/api/mod/me", MOD)).j.me.role, "moderator");
  assert.equal((await get("/api/mod/team", MOD)).status, 403, "only the owner manages the team");
  assert.equal((await act("harf.settings", { style: "strict" }, MOD)).status, 403, "moderators can't change settings");

  const ag = await post("/api/mod/team", { op: "add", name: "Night bot", role: "agent", perms: ["view"] });
  const AG = ag.j.key;
  assert.equal((await act("harf.verdict", { lg: "en", cat: "animal", w: "Zorse", ok: 1 }, AG)).status, 403, "view-only agent");
  await post("/api/mod/team", { op: "update", id: ag.j.member.id, perms: ["view", "review"] });
  assert.equal((await act("harf.verdict", { lg: "en", cat: "animal", w: "Zorse", ok: 1 }, AG, "")).status, 400, "agents must say why");

  // propose mode: the change waits for a person
  await post("/api/mod/agents", { mode: "propose" });
  const pr = await act("harf.verdict", { lg: "en", cat: "animal", w: "Zorse", ok: 1 }, AG, "a zebra-horse cross");
  assert.equal(pr.status, 200); assert.ok(pr.j.proposed);
  const pl = await get("/api/mod/proposals");
  assert.equal(pl.j.list[0].status, "pending");
  const ap = await post("/api/mod/proposals", { id: pr.j.proposed, ok: true }, MOD);
  assert.equal(ap.j.status, "approved");
  const v = await get("/api/harf/admin/verdicts?q=zorse");
  assert.equal(v.j.list[0].src, "mod"); assert.equal(v.j.list[0].ok, 1);

  // paused: nothing goes through; a removed key stops working
  await post("/api/mod/agents", { mode: "act", paused: true });
  assert.equal((await act("harf.verdict", { lg: "en", cat: "animal", w: "Zorse", ok: 0 }, AG, "x")).status, 423);
  await post("/api/mod/team", { op: "remove", id: ag.j.member.id });
  assert.equal((await get("/api/mod/me", AG)).status, 403);

  const log = await get("/api/mod/audit");
  assert.ok(log.j.list.some(e => e.act === "harf.verdict" && e.ok), "the approved change is in the log");
  const man = await fetch(BASE + "/api/mod/manual", { headers: { "x-admin-key": MOD } });
  assert.match(await man.text(), /harf\.verdict/);
});

test("a verdict re-scores today's answers, shows in the queue first, and can be undone", async () => {
  const uid = "p_admintest1", token = "a".repeat(20);
  const s = await daily("start", { uid, token, lg: "en", n: "Tess" });
  const L = s.open.L;
  // unknown words with the right letter: no AI in tests, so they wait unchecked
  const words = ["xa", "xb", "xc", "xd", "xe"].map(x => L + x + "qz");
  const done = await daily("submit", { uid, token, lg: "en", answers: words });
  assert.equal(done.entry.c, 0); assert.ok(done.entry.a.every(a => a.u));

  const q = await get("/api/harf/admin/queue?days=1");
  const it = q.j.list.find(g => g.words.includes(words[1]));
  assert.equal(it.type, "unchecked"); assert.equal(it.n, 1);

  const r = await act("harf.verdict", { k: it.key, ok: 1 });
  assert.equal(r.status, 200); assert.equal(r.j.rescored, 1);
  let me = (await get("/api/harf/admin/player?id=" + uid)).j;
  const today = me.langs.en.days[0];
  assert.equal(today.a[1].ok, 1); assert.equal(today.pts, 10);
  assert.ok(!(await get("/api/harf/admin/queue?days=1")).j.list.some(g => g.key === it.key), "decided words leave the queue");

  // one answer by hand, then undo it
  const one = await act("harf.answer", { id: uid + "_en", day: today.day, i: 2, ok: 1 });
  assert.equal(one.j.changed, 1);
  me = (await get("/api/harf/admin/player?id=" + uid)).j;
  assert.equal(me.langs.en.days[0].pts, 20); assert.equal(me.langs.en.days[0].a[2].mo, 1);
  assert.equal((await post("/api/mod/undo", { id: one.j.log })).status, 200);
  me = (await get("/api/harf/admin/player?id=" + uid)).j;
  assert.equal(me.langs.en.days[0].pts, 10); assert.ok(me.langs.en.days[0].a[2].u);

  // undo the verdict: the answer waits for a check again
  assert.equal((await post("/api/mod/undo", { id: r.j.log })).status, 200);
  me = (await get("/api/harf/admin/player?id=" + uid)).j;
  assert.equal(me.langs.en.days[0].a[1].ok, 0); assert.ok(me.langs.en.days[0].a[1].u);

  const ans = await get("/api/harf/admin/answers?day=" + today.day + "&lg=en");
  assert.ok(ans.j.players.some(p => p.uid === uid));
  const st = await get("/api/harf/admin/stats?days=3");
  assert.equal(st.j.days.length, 3);
  assert.ok(st.j.days[2].en.players >= 1);
});

test("settings change the referee and can be undone", async () => {
  const r = await act("harf.settings", { style: "lenient", appealsPerDay: 3, notes: { ar: "اقبل أسماء الخليج" } });
  assert.equal(r.status, 200);
  let s = (await get("/api/harf/admin/settings")).j.settings;
  assert.equal(s.style, "lenient"); assert.equal(s.appealsPerDay, 3);
  const st = await daily("state", { uid: "p_admintest2", token: "b".repeat(20), lg: "ar" });
  assert.equal(st.appealsLeft, 3);
  await post("/api/mod/undo", { id: r.j.log });
  s = (await get("/api/harf/admin/settings")).j.settings;
  assert.equal(s.style, "normal"); assert.equal(s.notes.ar, "");
});
