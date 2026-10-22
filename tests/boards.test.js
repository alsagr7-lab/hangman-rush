// The server-side leaderboards (boards.js): rankings for each game and tab, hidden players, your own row past the
// top 50, the hub, your own records, and one name and colour for every game.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const R = require("../site/shared/rules");
const { startServer, hashToken } = require("./helper");

const today = R.todayKey(), yday = R.ydayKey(), se = R.curSeason();
const TOK = id => "token-for-" + id.replace(/_(ar|en)$/, "");
const rec = (id, data) => [id, { token: hashToken(TOK(id)), data: Object.assign({ c: "#2c56e0", se, streak: 0, best: 0, ls: "", played: 0, wins: 0, h: {} }, data) }];

const players = Object.fromEntries([
  // Hangman English: a solve beats a hang whatever the points; ties go to the faster time
  rec("p_alpha000001", { n: "Alpha", played: 2, wins: 2, best: 2, streak: 2, ls: today, h: { [yday]: { ok: 1, pts: 200, t: 30000, m: 1 }, [today]: { ok: 1, pts: 250, t: 20000, m: 0, hn: 1 } } }),
  rec("p_bravo000001", { n: "Bravo", played: 1, wins: 1, best: 1, streak: 1, ls: today, h: { [today]: { ok: 1, pts: 250, t: 15000, m: 2 } } }),
  rec("p_charl000001", { n: "Charlie", played: 1, h: { [today]: { ok: 0, pts: 0, t: 60000, m: 6 } } }),
  rec("p_noname0001", { n: "Player", played: 1, wins: 1, h: { [today]: { ok: 1, pts: 340, t: 1000, m: 0 } } }),
  rec("p_alpha000001_ar", { n: "Alpha", played: 1, wins: 1, h: { [today]: { ok: 1, pts: 280, t: 9000, m: 0 } } }),
  // last season's record: not on this season's boards
  // (only once there is an earlier season: in Season 1 there's none)
  ...(se > 1 ? [rec("p_oldsea0001", { n: "Oldie", se: se - 1, played: 3, wins: 3, h: { "2020-01-01": { ok: 1, pts: 300, t: 1, m: 0 } } })] : []),
  // many players, so "me" lands past the top 50
  ...Array.from({ length: 60 }, (_, i) => rec("p_many" + String(i).padStart(8, "0"), { n: "Many " + i, played: 1, wins: 1, h: { [today]: { ok: 1, pts: 100 + i, t: 30000, m: 1 } } })),
  // played before this week, with one day carried over from last season into this week
  rec("p_weekie0001", { n: "Weekie", played: 1, wins: 1, h: { [R.dayKey(R.weekStart() - 1)]: { ok: 1, pts: 5, t: 1, m: 0 } }, wk: { [R.weekStartKey()]: { ok: 1, pts: 7 } } }),
  rec("p_lastone0001", { n: "Last", played: 1, wins: 1, h: { [today]: { ok: 1, pts: 1, t: 59000, m: 5 } } }),
]);
const trivia = Object.fromEntries([
  rec("p_alpha000001", { n: "Alpha", played: 1, wins: 1, h: { [today]: { ok: 1, pts: 900, t: 30000, s: "11101" } } }),
  rec("p_bravo000001", { n: "Bravo", played: 1, wins: 1, h: { [today]: { ok: 1, pts: 1200, t: 25000, s: "11111" } } }),
]);
const harf = Object.fromEntries([
  rec("p_alpha000001_ar", { n: "Alpha", played: 2, wins: 1, h: {
    [yday]: { lg: "ar", c: 5, pts: 66, t: 50000, ok: 1, rb: 15, L: "س", a: [{ w: "سمير", ok: 1 }, { w: "سمك", ok: 1 }, { w: "", ok: 0 }, { w: "سرير", ok: 1 }, { f: "سوريا", w: "سوريه", ok: 1, why: "secret" }] },
    [today]: { lg: "ar", c: 4, pts: 40, t: 70000, ok: 0, L: "ت", a: [{ w: "تامر", ok: 1 }] } } }),
  rec("p_bravo000001_ar", { n: "Bravo", played: 1, wins: 1, h: { [today]: { lg: "ar", c: 5, pts: 51, t: 60000, ok: 1, rb: null } } }),
]);

let srv, BASE;
before(async () => { srv = await startServer({ seed: { players, trivia, harf } }); BASE = srv.base; });
after(() => srv.stop());
const get = async p => { const r = await fetch(BASE + p); assert.equal(r.status, 200, p); return r.json(); };
const names = b => b.rows.map(r => r.n);

test("Hangman today: solved first, then points, then the faster time; unnamed and last season left out", async () => {
  const b = await get("/api/board?game=hangman&lg=en&tab=today");
  assert.deepEqual(names(b).slice(0, 2), ["Bravo", "Alpha"]);
  assert.ok(!names(b).includes("Player")); assert.ok(!names(b).includes("Oldie"));
  assert.equal(names(b).at(-1) === "Charlie" || b.total > 50, true);
  assert.equal(b.rows.length, 50); assert.equal(b.total, 64);
  const a = b.rows.find(r => r.n === "Alpha");
  assert.deepEqual(a.d, { ok: 1, t: 20000, m: 0, hn: 1 }); assert.equal(a.tag, R.tagOf("p_alpha000001"));
});

test("your own row comes back even when you're past the top 50", async () => {
  const b = await get("/api/board?game=hangman&lg=en&tab=today&me=p_charl000001");
  assert.ok(!b.rows.some(r => r.me));
  assert.equal(b.me.n, "Charlie"); assert.equal(b.me.rank, 64); assert.equal(b.me.me, 1);
  const top = await get("/api/board?game=hangman&lg=en&tab=today&me=p_bravo000001");
  assert.equal(top.rows[0].me, 1); assert.equal(top.me, null);
});

test("Hangman Arabic and season boards", async () => {
  assert.deepEqual(names(await get("/api/board?game=hangman&lg=ar&tab=today")), ["Alpha"]);
  const s = await get("/api/board?game=hangman&lg=en&tab=season");
  assert.equal(s.rows[0].n, "Alpha"); assert.equal(s.rows[0].pts, 450); assert.deepEqual(s.rows[0].d, { w: 2, p: 2, b: 2 });
  assert.deepEqual(names(await get("/api/board?game=hangman&lg=en&tab=yday")), ["Alpha"]);
});

test("Trivia: points first; the marks and time come along", async () => {
  const b = await get("/api/board?game=trivia&tab=today");
  assert.deepEqual(names(b), ["Bravo", "Alpha"]); assert.deepEqual(b.rows[1].d, { t: 30000, s: "11101" });
});

test("Harf: today never shows the letter or answers; yesterday shows words, bonus and letter", async () => {
  const t = await get("/api/board?game=harf&lg=ar&tab=today");
  assert.deepEqual(names(t), ["Bravo", "Alpha"]);
  assert.deepEqual(t.rows[1].d, { c: 4 });
  assert.doesNotMatch(JSON.stringify(t), /تامر|"L"/);
  const y = await get("/api/board?game=harf&lg=ar&tab=yday");
  assert.equal(y.rows[0].d.L, "س"); assert.equal(y.rows[0].d.rb, 15);
  assert.deepEqual(y.rows[0].d.a[4], { w: "سوريا", ok: 1 });
  assert.doesNotMatch(JSON.stringify(y), /secret/);
  assert.equal((await get("/api/board?game=harf&lg=en&tab=today")).rows.length, 0);
});

test("the hub: each game's boards as they are; the overall puts them on one scale", async () => {
  const h = await get("/api/board/hub?tab=season&me=p_alpha000001");
  assert.equal(h.tab, "season");
  // plain boards: season points, no calculations
  assert.deepEqual(h.games.hangman.boards.en.top.map(x => x.n + " " + x.pts), ["Alpha 450", "Bravo 250", "Many 59 159"]);
  assert.equal(h.games.hangman.boards.en.top[0].me, 1);
  assert.deepEqual(h.games.hangman.boards.ar.top.map(x => x.n + " " + x.pts), ["Alpha 280"]);
  assert.deepEqual(h.games.trivia.boards.all.top.map(x => x.n + " " + x.pts), ["Bravo 1200", "Alpha 900"]);
  assert.equal(h.games.hangman.method, "leader"); assert.equal(h.games.trivia.method, "single");
  // overall: Alpha 100 (Hangman, leads both boards) + 75 (Trivia, 900 of 1200) + 100 (Harf) = 275
  assert.equal(h.overall[0].n, "Alpha"); assert.equal(h.overall[0].score, 275);
  assert.deepEqual(Object.keys(h.overall[0].games).sort(), ["hangman", "harf", "trivia"]);
  assert.ok(h.overall.length <= 10);
});

test("/api/me gives your own records in every game, without the run in progress", async () => {
  const m = await get("/api/me?uid=p_alpha000001");
  assert.equal(m.hm.n, "Alpha"); assert.equal(m.hmAr.played, 1); assert.equal(m.tri.h[today].pts, 900); assert.equal(m.hfAr.h[yday].c, 5); assert.equal(m.hfEn, null);
  assert.equal((await fetch(BASE + "/api/me?uid=bad id")).status, 400);
});

test("one rename reaches every game, and the boards show it straight away", async () => {
  const post = (uid, body) => fetch(BASE + "/api/profile", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.assign({ uid, token: TOK(uid) }, body)) });
  assert.equal((await post("p_alpha000001", { n: "Alfa", c: "#d93c30" })).status, 200);
  const m = await get("/api/me?uid=p_alpha000001");
  for (const k of ["hm", "hmAr", "tri", "hfAr"]) { assert.equal(m[k].n, "Alfa", k); assert.equal(m[k].c, "#d93c30", k); }
  assert.equal(m.hm.h[today].pts, 250, "results untouched");
  assert.ok(names(await get("/api/board?game=trivia&tab=today")).includes("Alfa"));
  // someone else's token can't rename you; a bad name changes nothing
  const r = await fetch(BASE + "/api/profile", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ uid: "p_alpha000001", token: "x".repeat(20), n: "Hacked" }) });
  assert.equal(r.status, 403);
  assert.equal((await post("p_alpha000001", { n: "x" })).status, 400);
  // a "Player" who sets a name shows up again
  await post("p_noname0001", { n: "Named Now" });
  assert.equal((await get("/api/board?game=hangman&lg=en&tab=today")).rows[0].n, "Named Now");
});

test("weekly boards: Friday to Thursday, days before Friday left out, last season's days this week kept", async () => {
  const b = await get("/api/board?game=hangman&lg=en&tab=week&me=p_weekie0001");
  // by id: an earlier test renames players
  const pts = id => (b.rows.concat(b.me || []).find(r => r.id === id) || {}).pts;
  assert.equal(pts("p_weekie0001"), 7);
  assert.equal(pts("p_alpha000001"), 250 + (yday >= R.weekStartKey() ? 200 : 0));
  assert.equal(pts("p_bravo000001"), 250);
  assert.ok(!names(b).includes("Player"));
  assert.equal(b.wk, R.weekNo()); assert.equal(b.wleft, R.weekDaysLeft());
  const h = await get("/api/board/hub?me=p_alpha000001");
  assert.equal(h.tab, "week"); assert.equal(h.wleft, R.weekDaysLeft());
  assert.ok(h.games.hangman.boards.en.top.length > 0);
  const hf = await get("/api/board?game=harf&lg=ar&tab=week");
  assert.equal(hf.rows.find(r => r.id === "p_alpha000001").pts, 40 + (yday >= R.weekStartKey() ? 66 : 0));
});
