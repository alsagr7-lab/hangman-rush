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

const zOf = (list, x) => { const a = list.reduce((s, v) => s + v, 0) / list.length, sd = Math.sqrt(list.reduce((s, v) => s + (v - a) ** 2, 0) / list.length); return (x - a) / sd; };
test("both boards busy: the overall uses distance above the average in units of the board's spread", async () => {
  const h = await (await fetch(BASE + "/api/board/hub")).json(), G = h.games.harf;
  assert.equal(G.method, "average");
  assert.equal(G.boards.ar.top[0].pts, 200); assert.equal(G.boards.en.top[0].pts, 110);
  const AR = [200, 180, 160, 140, 120, 100], EN = [110, 90, 80, 70, 60, 50];
  const zAr = zOf(AR, 200), zEn = zOf(EN, 110);
  const ov = Object.fromEntries(h.overall.map(x => [x.n, x.score]));
  assert.ok(zEn > zAr); assert.equal(ov.En0, 100); assert.equal(ov.Ar0, Math.round(10 * 100 * zAr / zEn) / 10);
  // below average counts as 0 (the lowest Arabic player)
  assert.equal(ov.Ar5, 0);
});

test("a weak second language never costs anything, and one language is no penalty", async () => {
  // Bi plays both: well above average in Arabic, below average in English; Solo plays only Arabic with the same score
  const R2 = require("../site/shared/rules"), { startServer, hashToken } = require("./helper"), day = R2.todayKey(), s2 = R2.curSeason();
  const mk = (id, n, lg, pts) => [id, { token: hashToken("t-" + id.replace(/_(ar|en)$/, "")), data: { n, c: "#2c56e0", se: s2, played: 1, wins: 0, h: { [day]: { lg, c: 3, pts, t: 60000, ok: 0 } } } }];
  const harf2 = Object.fromEntries([
    ...[100, 90, 80, 70, 60].map((p, i) => mk("p_fill" + String(i).padStart(8, "0") + "_ar", "A" + i, "ar", p)),
    ...[100, 90, 80, 70, 60].map((p, i) => mk("p_film" + String(i).padStart(8, "0") + "_en", "E" + i, "en", p)),
    mk("p_bilingual01_ar", "Bi", "ar", 150), mk("p_bilingual01_en", "Bi", "en", 10), mk("p_solo00000001_ar", "Solo", "ar", 150),
  ]);
  const s = await startServer({ seed: { players: {}, harf: harf2 } });
  try {
    const ov = Object.fromEntries((await (await fetch(s.base + "/api/board/hub")).json()).overall.map(x => [x.n, x.score]));
    assert.equal(ov.Bi, ov.Solo);
  } finally { await s.stop(); }
});

test("a quiet board (5 or fewer players) falls back to comparing with each board's leader", async () => {
  // Hangman here has no players at all, and Trivia has one board
  const h = await (await fetch(BASE + "/api/board/hub")).json();
  assert.equal(h.games.hangman.method, "leader"); assert.equal(h.games.trivia.method, "single");
});
