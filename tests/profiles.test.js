// Player profiles (boards.js): anyone can open one from a leaderboard; a signed-in player can make theirs private.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const R = require("../site/shared/rules");
const { startServer, hashToken } = require("./helper");

const se = R.curSeason(), today = R.todayKey(), lastWk = R.weekStart() - 7, day = i => R.dayKey(lastWk + i);
const TOK = id => "token-" + id.replace(/_(ar|en)$/, "");
const rec = (id, n, h, extra) => [id, { token: hashToken(TOK(id)), data: Object.assign({ n, c: "#d93c30", se, played: Object.keys(h).length, wins: 1, streak: 1, best: 3, ls: today, h }, extra) }];
const hm = pts => ({ ok: 1, pts, t: 1000, m: 0 });
const players = Object.fromEntries([
  rec("p_profA00001", "Ann", { [day(1)]: hm(200), [today]: hm(150) }),
  rec("p_profB00001", "Ben", { [today]: hm(300) }),
  rec("p_profS00001", "Sam", { [today]: hm(100) }), // signed in, will go private
]);
const harf = Object.fromEntries([rec("p_profA00001_ar", "Ann", { [today]: { lg: "ar", c: 4, pts: 40, ok: 0, a: [] } })]);
const acct = { "g:123": { uid: "p_profS00001", tok: "x", at: 1 } };

let srv, BASE;
before(async () => { srv = await startServer({ seed: { players, trivia: {}, harf, acct }, env: { AWARDS_FIRST: R.dayKey(lastWk), GOOGLE_CLIENT_ID: "test-client" } }); BASE = srv.base; });
after(() => srv.stop());
const get = async (p, code = 200) => { const r = await fetch(BASE + p); assert.equal(r.status, code, p); return r.json(); };
const post = async (p, body, code = 200) => { const r = await fetch(BASE + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); assert.equal(r.status, code, p); return r.json(); };

test("a profile: name, tag, each board's week and season points and ranks, and medals", async () => {
  const d = await get("/api/player?id=p_profA00001");
  assert.equal(d.n, "Ann"); assert.equal(d.tag, R.tagOf("p_profA00001")); assert.equal(d.private, false);
  const hmEn = d.boards.find(b => b.game === "hangman" && b.lg === "en");
  assert.equal(hmEn.week.pts, 150); assert.equal(hmEn.week.rank, 2); // Ben 300, Ann 150, Sam 100
  assert.equal(hmEn.season.pts, 350); assert.equal(hmEn.season.days, 2); assert.equal(hmEn.season.rank, 1);
  assert.equal(hmEn.best, 3);
  const hfAr = d.boards.find(b => b.game === "harf" && b.lg === "ar");
  assert.equal(hfAr.week.pts, 40);
  assert.ok(d.medals.some(m => m.k === "hangman-en" && m.p === 1)); // last week's only Hangman player
  assert.equal(d.signedIn, undefined);
});

test("unknown players are not found; bad ids are refused", async () => {
  await get("/api/player?id=p_nobody00001", 404);
  await get("/api/player?id=bad id", 400);
});

test("only a signed-in owner can go private; then others see just the name", async () => {
  await post("/api/privacy", { uid: "p_profA00001", token: TOK("p_profA00001"), private: true }, 403); // not signed in
  await post("/api/privacy", { uid: "p_profS00001", token: "wrong-token-123456", private: true }, 403);
  await post("/api/privacy", { uid: "p_profS00001", token: TOK("p_profS00001"), private: true });
  const other = await get("/api/player?id=p_profS00001");
  assert.deepEqual(Object.keys(other).sort(), ["c", "id", "n", "private", "se", "tag", "wk"]);
  assert.equal(other.private, true); assert.equal(other.n, "Sam");
  // the owner still sees everything
  const own = await post("/api/player", { id: "p_profS00001", uid: "p_profS00001", token: TOK("p_profS00001") });
  assert.equal(own.private, true); assert.equal(own.signedIn, true); assert.ok(Array.isArray(own.boards));
  // and still shows on the leaderboards
  const b = await get("/api/board?game=hangman&lg=en&tab=today");
  assert.ok(b.rows.some(r => r.id === "p_profS00001"));
  await post("/api/privacy", { uid: "p_profS00001", token: TOK("p_profS00001"), private: false });
  assert.ok(Array.isArray((await get("/api/player?id=p_profS00001")).boards));
});
