// The server-run Hangman daily (hangman.js): the word stays on the server, the score is the page's own formula,
// results land in the same records as before, and records saved the old way come through untouched.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const R = require("../site/shared/rules");
const { startServer, hashToken } = require("./helper");

const today = R.todayKey(), yday = R.ydayKey(), ago = n => R.dayKey(R.dayNum() - n);
// records saved by the old page, in the shapes found on the live board (missing hn or sk, empty days, Arabic records)
const OLD = {
  p_old0000001: { n: "Old One", c: "#2c56e0", h: { [ago(3)]: { m: 0, t: 17614, hn: 0, ok: 1, pts: 270 }, [ago(2)]: { m: 6, t: 35813, hn: 0, ok: 0, pts: 0 }, [yday]: { m: 3, t: 40939, hn: 0, ok: 1, pts: 146 } }, ls: yday, se: R.curSeason(), sk: 4, best: 1, prev: null, wins: 2, played: 3, streak: 1 },
  p_old0000001_ar: { n: "Old One", c: "#2c56e0", h: { [yday]: { m: 1, t: 11689, hn: 0, ok: 1, pts: 283 } }, ls: yday, se: R.curSeason(), sk: 0, best: 1, prev: null, wins: 1, played: 1, streak: 1 },
  p_old0000002: { n: "Player", c: "#2c56e0", h: { [ago(3)]: { m: 5, t: 60000, ok: 0, pts: 0 } }, ls: "", se: R.curSeason(), best: 0, prev: null, wins: 0, played: 1, streak: 0 },
  p_old0000003: { n: "خالد", c: "#8a3ffc", h: {}, ls: "", se: R.curSeason(), sk: -4, best: 0, prev: null, wins: 0, played: 0, streak: 0 },
};
const TOK = id => "token-for-" + id.replace(/_ar$/, "");
const seed = { players: Object.fromEntries(Object.entries(OLD).map(([id, data]) => [id, { token: hashToken(TOK(id)), data }])) };

let srv, BASE;
before(async () => { srv = await startServer({ seed }); BASE = srv.base; });
after(() => srv.stop());

const board = async () => Object.fromEntries((await (await fetch(BASE + "/api/players")).json()).map(r => [r.id, r.data]));
const call = async (path, uid, extra) => {
  const r = await fetch(BASE + "/api/hangman/daily/" + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ uid, token: TOK(uid), ...extra }) });
  return { status: r.status, body: await r.json() };
};
const play = (path, uid, extra) => call(path, uid, extra).then(r => r.body);
const waitStart = s => new Promise(r => setTimeout(r, (s.open ? s.open.wait : 0) + 50));

test("old records come through the new server unchanged", async () => {
  const b = await board();
  for (const [id, data] of Object.entries(OLD)) assert.deepEqual(b[id], data, id);
});

test("a full English daily: word hidden until the end, page's score, result in the same record", async () => {
  const uid = "p_old0000001";
  let s = await play("start", uid, { lg: "en" });
  assert.equal(s.open.p, "G______"); // the first letter is free
  assert.equal(s.open.hd, 5);
  assert.ok(!JSON.stringify(s).includes("GIRAFFE"), "the word must not be sent before the end");
  assert.equal((await call("guess", uid, { lg: "en", L: "R" })).status, 409, "no guesses during the countdown");
  await waitStart(s);
  s = await play("guess", uid, { lg: "en", L: "Z" });
  assert.equal(s.open.miss, 1);
  s = await play("guess", uid, { lg: "en", L: "F" });
  assert.equal(s.open.p, "G___FF_");
  for (const L of ["I", "R", "A"]) s = await play("guess", uid, { lg: "en", L });
  assert.ok(!JSON.stringify(s).includes("GIRAFFE"));
  s = await play("guess", uid, { lg: "en", L: "E" });
  assert.equal(s.open, null);
  assert.equal(s.word.w, "GIRAFFE");
  const e = s.entry;
  assert.equal(e.ok, 1); assert.equal(e.m, 1); assert.equal(e.hn, 0);
  assert.equal(e.pts, Math.max(20, 100 + R.speedBonus(e.t, 60000) - 10));
  // same record, old days kept, counts moved on like the page did
  const r = (await board())[uid];
  assert.deepEqual(Object.keys(r.h).sort(), [ago(3), ago(2), yday, today]);
  assert.equal(r.h[yday].pts, 146);
  assert.equal(r.played, 4); assert.equal(r.wins, 3); assert.equal(r.streak, 2); assert.equal(r.ls, today); assert.equal(r.sk, 5);
  assert.equal(r.run, undefined);
  // one attempt a day
  assert.equal((await call("start", uid, { lg: "en" })).status, 409);
});

test("a save from a page that hasn't caught up can't undo the server's result", async () => {
  const uid = "p_old0000001", stale = OLD[uid];
  const r = await fetch(`${BASE}/api/players/${uid}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: TOK(uid), data: { ...stale, n: "Renamed" } }) });
  assert.equal(r.status, 200);
  const b = (await board())[uid];
  assert.equal(b.n, "Renamed");
  assert.equal(b.h[today].ok, 1); assert.equal(b.played, 4); assert.equal(b.streak, 2);
});

test("Arabic daily: hints, clue, the level moves on the English record", async () => {
  const uid = "p_old0000003"; // level -4: two bonus letters
  let s = await play("start", uid, { lg: "ar" });
  assert.equal(s.open.maxHints, 1 + 2);
  assert.equal(s.open.cluePct, 30);
  await waitStart(s);
  s = await play("hint", uid, { lg: "ar", kind: "clue" });
  assert.equal(s.open.clue.en, "King of the jungle");
  s = await play("hint", uid, { lg: "ar", kind: "letter" });
  assert.equal(s.open.hints, 1); assert.equal(s.open.hd, 1);
  s = await play("hint", uid, { lg: "ar", kind: "letter" });
  assert.equal(s.open.hints, 1, "never the last letter");
  // guessing with the plain alef counts for أ (the keyboard has no hamza forms)
  const left = ["ا", "س", "د"].filter(L => !s.open.g.includes(L));
  for (const L of left) s = await play("guess", uid, { lg: "ar", L });
  assert.equal(s.word.w, "أسد");
  const e = s.entry;
  assert.equal(e.ok, 1); assert.equal(e.hn, 2);
  assert.equal(e.pts, Math.round(Math.max(20, 100 + R.speedBonus(e.t, 60000) - 30) * 70 / 100));
  const b = await board();
  assert.equal(b[uid + "_ar"].h[today].pts, e.pts);
  assert.equal(b[uid].sk, -3);
  assert.deepEqual(b[uid].h, {});
});

test("hanged after six misses; time running out is scored as hanged", async () => {
  const uid = "p_old0000002";
  let s = await play("start", uid, { lg: "en" });
  await waitStart(s);
  for (const L of ["Q", "W", "X", "Y", "U", "P"]) s = await play("guess", uid, { lg: "en", L });
  assert.equal(s.entry.ok, 0); assert.equal(s.entry.pts, 0); assert.equal(s.entry.m, 6);
  assert.equal((await board())[uid].h[ago(3)].t, 60000, "older days untouched");
});

test("a run left past its time is finished as hanged on the next visit", async () => {
  const id = "p_timeout01", tok = "token-for-p_timeout01";
  const srv2 = await startServer({ seed: { players: { [id]: { token: hashToken(tok), data: {
    n: "Late", h: {}, se: R.curSeason(), sk: 0, played: 0, wins: 0, streak: 0, best: 0, ls: "",
    run: { d: today, at: Date.now() - 70000, g: ["G"], miss: 2, hints: 0, clue: 0, bonus: 0, maxHints: 3, cluePct: 50 } } } } } });
  try {
    const r = await fetch(srv2.base + "/api/hangman/daily/state", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ uid: id, token: tok, lg: "en" }) });
    const s = await r.json();
    assert.equal(s.entry.ok, 0); assert.equal(s.entry.t, 60000); assert.equal(s.entry.m, 2);
    assert.equal(s.word.w, "GIRAFFE");
  } finally { await srv2.stop(); }
});

test("only the device holding the token can play an id; the run isn't shown on the board", async () => {
  const r = await fetch(BASE + "/api/hangman/daily/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ uid: "p_old0000002", token: "someone-elses-token", lg: "en" }) });
  assert.equal(r.status, 403);
  const fresh = "p_fresh00001";
  await play("start", fresh, { lg: "en", n: "Newbie" });
  const b = (await board())[fresh];
  assert.equal(b.n, "Newbie"); assert.equal(b.run, undefined);
});

test("the old /api/daily still answers for pages from before", async () => {
  const d = await (await fetch(BASE + "/api/daily")).json();
  assert.equal(d.w, "GIRAFFE");
});

test("a save arriving at the same moment as the winning guess doesn't wipe the result", async () => {
  const uid = "p_race000001";
  let s = await play("start", uid, { lg: "en", n: "Racer" });
  const staleRec = s.rec; // what the page had before the result
  await waitStart(s);
  for (const L of ["I", "R", "A", "F"]) s = await play("guess", uid, { lg: "en", L });
  const putStale = () => fetch(`${BASE}/api/players/${uid}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: TOK(uid), data: staleRec }) });
  await Promise.all([putStale(), play("guess", uid, { lg: "en", L: "E" }), putStale()]);
  const b = (await board())[uid];
  assert.equal(b.h[today].ok, 1); assert.equal(b.played, 1); assert.equal(b.run, undefined);
});
