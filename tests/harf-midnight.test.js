// Harf daily runs that cross midnight Saudi time are scored for the day they began on (not thrown away), and the
// team's "reset today" lets a player play today again with the streak they had going into today.
// Run: npm test
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const R = require("../site/shared/rules");
const { startServer, hashToken } = require("./helper");

const OWNER = "owner-key-midnight";
const today = R.todayKey(), yday = R.ydayKey(), before2 = R.dayKey(R.dayNum() - 2);
const tok = id => "token-for-" + id;
const base = n => ({ n, c: "#2c56e0", se: R.curSeason(), played: 3, wins: 3, streak: 3, best: 3, ls: before2, h: {} });
const run = (at, dr = []) => ({ d: yday, n: R.dailyNo() - 1, lg: "en", L: "B", at, dr });
const ids = { live: "p_midlive0001", gone: "p_midgone0001", reset: "p_midreset001" };
const players = Object.fromEntries(Object.values(ids).map(id => [id, { token: hashToken(tok(id)), data: { n: id } }]));
const harf = {
  // started 30 seconds before midnight and still being played
  [ids.live + "_en"]: { token: hashToken(tok(ids.live)), data: Object.assign(base("Live"), { run: run(Date.now() - 30000) }) },
  // started before midnight, then the page was closed: its last saved draft counts for that day
  [ids.gone + "_en"]: { token: hashToken(tok(ids.gone)), data: Object.assign(base("Gone"), { run: run(Date.now() - 10 * 6e4, ["Bob", "", "", "", ""]) }) },
  [ids.reset + "_en"]: { token: hashToken(tok(ids.reset)), data: Object.assign(base("Reset"), { ls: yday }) },
};

let srv, BASE;
before(async () => { srv = await startServer({ seed: { players, harf }, env: { ADMIN_KEY: OWNER } }); BASE = srv.base; });
after(() => srv.stop());

const daily = (p, id, extra = {}) => fetch(BASE + "/api/harf/daily/" + p, { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify(Object.assign({ uid: id, token: tok(id), lg: "en" }, extra)) }).then(async r => ({ status: r.status, j: await r.json() }));
const admin = (method, p, body) => fetch(BASE + p, { method, headers: { "Content-Type": "application/json", "x-admin-key": OWNER }, body: body ? JSON.stringify(body) : undefined })
  .then(async r => ({ status: r.status, j: await r.json().catch(() => null) }));
const player = async id => (await admin("GET", "/api/harf/admin/player?id=" + id)).j.langs.en;

test("a run still being played at midnight is scored for the day it began, then today starts fresh", async () => {
  const st = await daily("state", ids.live);
  assert.equal(st.j.open, null, "it isn't today's run");
  assert.ok(!st.j.entry);
  const s = await daily("submit", ids.live, { answers: ["Bxqz", "", "", "", ""] });
  assert.equal(s.status, 200);
  assert.equal(s.j.late.d, yday); assert.equal(s.j.late.L, "B");
  assert.equal(s.j.late.a[0].w, "Bxqz");
  assert.ok(!s.j.entry, "nothing counted for today");
  const p = await player(ids.live);
  assert.ok(p.days.some(d => d.day === yday && d.L === "B"), "kept as yesterday's game");
  const t = await daily("start", ids.live);
  assert.equal(t.status, 200); assert.ok(t.j.open.L, "today's run"); assert.notEqual(t.j.open.left, 0);
});

test("a run left open past midnight counts its last draft for its own day instead of vanishing", async () => {
  await daily("state", ids.gone);
  const p = await player(ids.gone);
  const y = p.days.find(d => d.day === yday);
  assert.ok(y, "yesterday kept"); assert.equal(y.a[0].w, "Bob");
  assert.equal(p.open, null);
  assert.equal((await daily("start", ids.gone)).status, 200);
});

test("reset today: the player plays again with the streak they had, and it can be undone", async () => {
  const L = (await daily("start", ids.reset)).j.open.L;
  const done = await daily("submit", ids.reset, { answers: [L + "qzx", "", "", "", ""] });
  assert.ok(done.j.entry); assert.equal(done.j.streak, 0, "an imperfect day resets the streak");

  const r = await admin("POST", "/api/mod/act", { act: "harf.resetToday", args: { id: ids.reset + "_en" }, why: "saw the wrong letter" });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(r.j.streak, 3, "back to the streak going into today");
  let p = await player(ids.reset);
  assert.ok(!p.days.some(d => d.day === today)); assert.equal(p.played, 3);
  assert.equal((await daily("state", ids.reset)).j.streak, 3);

  // undo puts the result back
  const u = await admin("POST", "/api/mod/undo", { id: r.j.log });
  assert.equal(u.status, 200, JSON.stringify(u.j));
  p = await player(ids.reset);
  assert.ok(p.days.some(d => d.day === today)); assert.equal(p.streak, 0);

  // reset again, giving back a streak a bug broke; then they can play today
  const g = await admin("POST", "/api/mod/act", { act: "harf.resetToday", args: { id: ids.reset + "_en", streak: 7 }, why: "bug broke it" });
  assert.equal(g.j.streak, 7);
  p = await player(ids.reset); assert.equal(p.best, 7);
  const again = await daily("start", ids.reset);
  assert.equal(again.status, 200); assert.ok(again.j.open);

  // nothing to reset for someone who hasn't played today
  const none = await admin("POST", "/api/mod/act", { act: "harf.resetToday", args: { id: "p_nobody00001_en" }, why: "x" });
  assert.notEqual(none.status, 200);
});
