// The scoring that decides leaderboard points and had no test before:
//   - Trivia daily: the server times each answer, scores it, and can't be made to score one twice;
//   - Harf after midnight: yesterday's answers are counted across players and rarity bonuses added;
//   - the merge rule used when a device joins a Google account: the first result played each day wins.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const R = require("../site/shared/rules");
const { startServer, hashToken } = require("./helper");

const today = R.todayKey(), yday = R.ydayKey(), se = R.curSeason(), H = R.HARF, T = R.TRIVIA;
const TOK = id => "token-for-" + id.replace(/_(ar|en)$/, "");

/* ---------- Harf: yesterday, eleven English players, letter S ----------
   name: Sam x8 (common, no bonus), Sally x2 (one typed "Saly", corrected to Sally; 2 of 11 is under a fifth: +2 each),
   Sara x1 (nobody else: +5). The first player also wrote four answers nobody else did (+5 each). */
const ans = (name, more = []) => [name, ...more].concat(Array(5).fill({ w: "", ok: 0 })).slice(0, 5);
const ENTRY = a => ({ lg: "en", L: "S", a, c: a.filter(x => x.ok).length, b: 10 * a.filter(x => x.ok).length, sb: 0, rb: null, ok: 0, t: 40000, at: Date.now() - R.DAY });
const harfRows = [
  ["p_hfall00001", ans({ w: "Sam", ok: 1 }, [{ w: "Snake", ok: 1 }, { w: "Sage", ok: 1 }, { w: "Spoon", ok: 1 }, { w: "Spain", ok: 1 }])],
  ...Array.from({ length: 7 }, (_, i) => ["p_hfsam" + String(i).padStart(5, "0"), ans({ w: "Sam", ok: 1 })]),
  ["p_hfsally001", ans({ w: "Sally", ok: 1 })],
  ["p_hfsally002", ans({ w: "Saly", f: "Sally", ok: 1 })],
  ["p_hfsara0001", ans({ w: "Sara", ok: 1 })],
];
const harf = Object.fromEntries(harfRows.map(([id, a], i) => {
  const e = ENTRY(a);
  if (i === 0) { e.ok = 1; e.sb = 1; } // all five valid, on a perfect streak of one
  e.pts = e.b + e.sb;
  return [id + "_en", { token: hashToken(TOK(id)), data: { n: "Harf " + i, c: "#2c56e0", se, streak: 0, best: 0, ls: "", played: 1, wins: e.ok, h: { [yday]: e } } }];
}));

let srv, BASE;
before(async () => { srv = await startServer({ seed: { players: {}, harf } }); BASE = srv.base; });
after(() => srv.stop());
const post = async (path, uid, extra) => {
  const r = await fetch(BASE + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ uid, token: TOK(uid), ...extra }) });
  return { status: r.status, body: await r.json() };
};

test("Harf after midnight: answers counted across players, rarity bonuses added, a correction counts as its word", async () => {
  let b;
  for (let i = 0; i < 50; i++) { // the count runs in the background after the first board request of the day
    b = await (await fetch(BASE + "/api/board?game=harf&lg=en&tab=yday")).json();
    if (b.rows.length && b.rows.every(r => r.d.rb != null)) break;
    await new Promise(r => setTimeout(r, 100));
  }
  const by = Object.fromEntries(b.rows.map(r => [r.id, r]));
  assert.equal(b.rows.length, 11);
  assert.equal(by.p_hfall00001.d.rb, 4 * H.RARE_ONLY, "four answers nobody else gave");
  assert.equal(by.p_hfall00001.pts, 5 * H.BASE + 1 + 4 * H.RARE_ONLY, "points, perfect streak and rarity");
  assert.equal(by.p_hfsam00000.d.rb, 0, "a common answer gets nothing");
  assert.equal(by.p_hfsally001.d.rb, H.RARE_FEW); assert.equal(by.p_hfsally002.d.rb, H.RARE_FEW, "Saly counts as Sally");
  assert.equal(by.p_hfsara0001.d.rb, H.RARE_ONLY);
  assert.equal(b.rows[0].id, "p_hfall00001");
  // counted once: a later board request changes nothing
  const again = await (await fetch(BASE + "/api/board?game=harf&lg=en&tab=yday")).json();
  assert.deepEqual(again.rows.map(r => [r.id, r.pts]), b.rows.map(r => [r.id, r.pts]));
});

test("Trivia daily: server-timed scoring, right answers counted, an answer can't be scored twice", async () => {
  const uid = "p_trivia0001";
  let s = (await post("/api/trivia/daily/state", uid, { n: "Quizzer" })).body;
  assert.equal(s.done, false); assert.equal(s.i, 0);
  const picks = [true, true, false, true, true], got = [];
  for (let i = 0; i < T.QUESTIONS; i++) {
    const q = (await post("/api/trivia/daily/next", uid, { n: "Quizzer" })).body;
    assert.equal(q.i, i); assert.equal(q.opts.length, 4);
    assert.ok(!JSON.stringify(q).includes('"correct"'), "the right answer isn't sent with the question");
    const right = q.opts.findIndex(o => o.en === "Right " + i), pick = picks[i] ? right : (right + 1) % 4;
    const r = await post("/api/trivia/daily/answer", uid, { i, pick });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, picks[i]); assert.equal(r.body.correct, right);
    if (picks[i]) assert.ok(r.body.pts >= 20 && r.body.pts <= R.triviaPoints(true, 0, T.DIFF.normal.ms, false, 0), "points for a right answer: " + r.body.pts);
    else assert.equal(r.body.pts, 0);
    got.push(r.body.pts);
    // the same answer sent again (a double tap) is refused, not scored again
    assert.equal((await post("/api/trivia/daily/answer", uid, { i, pick })).status, 409);
  }
  s = (await post("/api/trivia/daily/state", uid, {})).body;
  assert.equal(s.done, true);
  assert.equal(s.entry.c, 4); assert.equal(s.entry.m, 1); assert.equal(s.entry.s, "11011");
  assert.equal(s.entry.pts, got.reduce((a, x) => a + x, 0));
  assert.equal(s.entry.ok, 1, "4 of 5 passes");
  assert.equal(s.sk, 3, "level: +1 per right answer, -1 per wrong");
  assert.equal((await post("/api/trivia/daily/next", uid, {})).status, 409, "one attempt a day");
  const board = await (await fetch(BASE + "/api/board?game=trivia&tab=today")).json();
  assert.equal(board.rows.find(r => r.id === uid).pts, s.entry.pts);
});

test("merging a device into an account: the first result played each day wins, then streaks are counted again", () => {
  const { mergeDays, FIRST, BEST } = require("../merges");
  const d = (k, e) => ({ se, h: { [k]: e } });
  const ago = n => R.dayKey(R.dayNum() - n);
  const acct = { se, h: { [ago(2)]: { ok: 1, pts: 100, at: 2000 }, [yday]: { ok: 0, pts: 0, at: 5000 } } };
  const dev = { se, h: {
    [ago(2)]: { ok: 1, pts: 300, at: 3000 }, // played later than the account's: the account's stays
    [yday]: { ok: 1, pts: 250, at: 4000 },   // played earlier: replaces the account's miss
    [today]: { ok: 1, pts: 200, at: 9000 },  // missing from the account: added
    [ago(5)]: { s: 1, at: 1 },               // started, never finished: ignored
  } };
  assert.equal(mergeDays(acct, dev, FIRST), 2);
  assert.equal(acct.h[ago(2)].pts, 100); assert.equal(acct.h[yday].pts, 250); assert.equal(acct.h[today].pts, 200);
  assert.equal(acct.h[ago(5)], undefined);
  assert.equal(acct.streak, 3); assert.equal(acct.best, 3); assert.equal(acct.wins, 3); assert.equal(acct.played, 3); assert.equal(acct.ls, today);
  // days from before play times were recorded count as first; where neither has one, the higher score wins
  assert.equal(FIRST({ pts: 5 }, { pts: 9, at: 1 }), false);
  assert.equal(FIRST({ pts: 5 }, { pts: 9 }), true);
  assert.equal(BEST({ pts: 5 }, { pts: 4 }), false);
  // another season's record is never merged in
  assert.equal(mergeDays(d(today, { ok: 0, pts: 0, at: 9 }), { se: se + 1, h: { [today]: { ok: 1, pts: 99, at: 1 } } }, FIRST), 0);
});

test("weeks start on Friday and the season rollover keeps this week's points", () => {
  const dn = (y, m, d) => Math.floor(Date.UTC(y, m - 1, d) / R.DAY);
  assert.equal(R.weekStart(dn(2026, 10, 23)), dn(2026, 10, 23)); // Friday
  assert.equal(R.weekStart(dn(2026, 10, 22)), dn(2026, 10, 16)); // Thursday belongs to the week before
  assert.equal(R.weekStart(dn(2026, 10, 29)), dn(2026, 10, 23));
  assert.ok(R.weekDay() >= 1 && R.weekDay() <= 7); assert.equal(R.weekDay() + R.weekDaysLeft(), 8);
  const before = R.dayKey(R.weekStart() - 1), today = R.todayKey();
  const r = { se: -1, h: { [before]: { ok: 1, pts: 50, a: ["secret"] }, [today]: { ok: 1, pts: 20, a: ["secret"], lg: "ar" } } };
  assert.ok(R.rollover(r));
  assert.deepEqual(r.h, {});
  assert.deepEqual(r.wk, { [today]: { pts: 20, ok: 1, lg: "ar" } });
  assert.deepEqual(R.weekEntries(r).map(e => e.pts), [20]);
});

test("days change at midnight Saudi time (21:00 UTC), not midnight UTC", () => {
  assert.equal(R.keyAt(Date.UTC(2026, 9, 22, 20, 59, 59)), "2026-10-22");
  assert.equal(R.keyAt(Date.UTC(2026, 9, 22, 21, 0, 0)), "2026-10-23");
  assert.equal(R.keyAt(Date.UTC(2026, 9, 23, 0, 30)), "2026-10-23");
  // Daily #1 was 14 Oct Saudi time, which began at 21:00 UTC on 13 Oct
  assert.equal(R.dailyNo(Date.UTC(2026, 9, 13, 21, 0)), 1);
  assert.equal(R.dailyNo(Date.UTC(2026, 9, 13, 20, 59)), 0);
  // the week turns at Thursday 21:00 UTC = Friday 00:00 in Saudi
  assert.equal(R.dayKey(R.weekStart(R.dayNum(Date.UTC(2026, 9, 22, 20, 59)))), "2026-10-16");
  assert.equal(R.dayKey(R.weekStart(R.dayNum(Date.UTC(2026, 9, 22, 21, 0)))), "2026-10-23");
  assert.equal(R.hourKey(Date.UTC(2026, 9, 22, 21, 30)), "2026-10-23T00");
  const left = R.msToMidnight(), next = Date.now() + left;
  assert.ok(left > 0 && left <= R.DAY);
  assert.equal(new Date(next).getUTCHours(), 21); assert.notEqual(R.keyAt(next), R.todayKey());
});

test("Harf rooms: a misspelling of someone else's answer is shared, not rare", () => {
  const v = [0, 1, 0, 0, 0], pts = (a, b, lg) => R.harfRoomPoints({ a: ["", a, "", "", ""], b: ["", b, "", "", ""] }, { a: v, b: v }, lg);
  for (const [a, b, lg] of [["زرفة", "زرافة", "ar"], ["ذيب", "ذئب", "ar"], ["Elefant", "Elephant", "en"], ["Lion", "Lions", "en"]])
    assert.deepStrictEqual(pts(a, b, lg), { a: [0, 5, 0, 0, 0], b: [0, 5, 0, 0, 0] }, a + " / " + b);
  for (const [a, b, lg] of [["أسد", "أسر", "ar"], ["نمر", "نمل", "ar"], ["Cat", "Cow", "en"], ["Bear", "Beaver", "en"]])
    assert.deepStrictEqual(pts(a, b, lg), { a: [0, 10, 0, 0, 0], b: [0, 10, 0, 0, 0] }, a + " / " + b);
});
