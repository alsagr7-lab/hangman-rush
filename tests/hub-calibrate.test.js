// The hub puts two language boards on one scale by their averages once both have more than 5 players this season.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const R = require("../site/shared/rules");
const { startServer, hashToken } = require("./helper");

const today = R.todayKey(), se = R.curSeason();
const rec = (id, n, lg, pts) => [id, { token: hashToken("tok-" + id.replace(/_(ar|en)$/, "")), data: { n, c: "#2c56e0", se, played: 1, wins: 0, streak: 0, best: 0, ls: "", h: { [today]: { lg, c: 3, pts, t: 60000, ok: 0 } } } }];
// Arabic: everyone scores high (average 150). English: lower scores (average about 77), but its leader is further ahead.
const harf = Object.fromEntries([
  ...[200, 180, 160, 140, 120, 100].map((p, i) => rec("p_arab" + String(i).padStart(8, "0") + "_ar", "Ar" + i, "ar", p)),
  ...[110, 90, 80, 70, 60, 50].map((p, i) => rec("p_engl" + String(i).padStart(8, "0") + "_en", "En" + i, "en", p)),
]);
let srv, BASE;
before(async () => { srv = await startServer({ seed: { players: {}, harf } }); BASE = srv.base; });
after(() => srv.stop());

test("both boards busy: the overall compares by averages; the game's own boards stay plain", async () => {
  const h = await (await fetch(BASE + "/api/board/hub")).json(), G = h.games.harf;
  assert.equal(G.method, "average");
  assert.equal(G.boards.ar.top[0].n, "Ar0"); assert.equal(G.boards.ar.top[0].pts, 200);
  assert.equal(G.boards.en.top[0].n, "En0"); assert.equal(G.boards.en.top[0].pts, 110);
  // overall: En0 is 110 / 76.7 = 1.43x its board's average, Ar0 is 200 / 150 = 1.33x
  const ov = Object.fromEntries(h.overall.map(x => [x.n, x.score]));
  assert.equal(ov.En0, 100); assert.equal(ov.Ar0, Math.round(10 * 100 * (200 / 150) / (110 / (460 / 6))) / 10);
});

test("a quiet board (5 or fewer players) falls back to comparing with each board's leader", async () => {
  // Hangman here has no players at all, and Trivia has one board
  const h = await (await fetch(BASE + "/api/board/hub")).json();
  assert.equal(h.games.hangman.method, "leader"); assert.equal(h.games.trivia.method, "single");
});
