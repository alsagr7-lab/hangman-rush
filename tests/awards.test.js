// Weekly medals (boards.js): once a week closes, its top 3 on each board and overall are saved, shown next to the
// winners' names on the boards, and kept as a history per player.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const R = require("../site/shared/rules");
const { startServer, hashToken } = require("./helper");

const se = R.curSeason(), today = R.todayKey();
const lastWk = R.weekStart() - 7, day = i => R.dayKey(lastWk + i); // days of the week that just closed
const rec = (id, n, h) => [id, { token: hashToken("t-" + id), data: { n, c: "#2c56e0", se, played: 1, wins: 1, streak: 0, best: 0, ls: "", h } }];
const hm = pts => ({ ok: 1, pts, t: 1000, m: 0 });
const players = Object.fromEntries([
  rec("p_awardA00001", "Ann", { [day(0)]: hm(150), [day(6)]: hm(150), [today]: hm(10) }),
  rec("p_awardB00001", "Ben", { [day(2)]: hm(200) }),
  rec("p_awardC00001", "Cat", { [day(3)]: hm(100) }),
  rec("p_awardD00001", "Dan", { [day(4)]: hm(50) }),
  rec("p_awardE00001", "Eve", { [R.dayKey(lastWk - 3)]: hm(999) }), // the week before: no medal
]);
const trivia = Object.fromEntries([rec("p_awardB00001", "Ben", { [day(1)]: { ok: 1, pts: 900, t: 1, s: "11111" } })]);
const harf = Object.fromEntries([rec("p_awardA00001_ar", "Ann", { [day(5)]: { lg: "ar", c: 5, pts: 60, ok: 1, rb: 5, a: [] } })]);

let srv, BASE;
before(async () => { srv = await startServer({ seed: { players, trivia, harf }, env: { AWARDS_FIRST: R.dayKey(lastWk) } }); BASE = srv.base; });
after(() => srv.stop());
const get = async p => { const r = await fetch(BASE + p); assert.equal(r.status, 200, p); return r.json(); };

test("a closed week's top 3 are saved for each board and overall", async () => {
  const { weeks } = await get("/api/awards");
  assert.equal(weeks.length, 1);
  const w = weeks[0];
  assert.equal(w.from, R.dayKey(lastWk)); assert.equal(w.to, R.dayKey(lastWk + 6)); assert.equal(w.wk, R.weekNo() - 1);
  assert.deepEqual(w.boards["hangman-en"].map(x => x.n + " " + x.pts), ["Ann 300", "Ben 200", "Cat 100"]);
  assert.deepEqual(w.boards.trivia.map(x => x.n), ["Ben"]);
  assert.deepEqual(w.boards["harf-ar"].map(x => x.n + " " + x.pts), ["Ann 60"]);
  assert.deepEqual(w.boards["harf-en"], []);
  // Ann: Hangman 100 + Harf 100; Ben: Hangman 66.7 + Trivia 100
  assert.deepEqual(w.overall.map(x => x.n), ["Ann", "Ben", "Cat"]);
  assert.ok(!JSON.stringify(w).includes("Eve"));
});

test("winners wear their medals on the boards, overall first", async () => {
  const b = await get("/api/board?game=hangman&lg=en&tab=today");
  const ann = b.rows.find(r => r.id === "p_awardA00001");
  assert.deepEqual(ann.aw, [{ k: "overall", p: 1 }, { k: "hangman-en", p: 1 }, { k: "harf-ar", p: 1 }]);
  assert.equal(b.awards.from, R.dayKey(lastWk));
  const h = await get("/api/board/hub?tab=week");
  assert.deepEqual(h.overall.find(x => x.id === "p_awardA00001").aw[0], { k: "overall", p: 1 });
});

test("each player's medals are kept as a history", async () => {
  const { won } = await get("/api/awards?me=p_awardB00001");
  assert.deepEqual(won.map(x => x.k + " " + x.p).sort(), ["hangman-en 2", "overall 2", "trivia 1"]);
  assert.equal(won[0].from, R.dayKey(lastWk));
  assert.deepEqual((await get("/api/awards?me=p_awardE00001")).won, []);
});
