// The leaderboards, worked out on the server for all three games, so a page downloads a short ranked list instead of
// every player's full history.
//
//   GET /api/board?game=hangman|trivia|harf&lg=en|ar&tab=today|yday|week|season&me=<uid>
//        -> { game, lg, tab, se, day, len, left, total, rows: [...top 50], me: {rank, row} | null }
//   GET /api/board/hub?tab=week|season&me=<uid>  -> each game's leaders this week (Friday to Thursday) or season (best language, scored against its board's leader) and overall
//   GET /api/awards[?me=<uid>]  -> every week's saved medals (or just that player's), newest first
//   GET /api/me?uid=<uid>        -> the player's own public records in every game (what the board would show)
//   POST /api/profile {uid, token, n, c} -> sets the name and colour on every record the player has, in every game
//
// Rankings are kept per game until that game's records change (store.ver), so a busy board costs one pass, not one
// per viewer. Hidden players (admin) and unnamed "Player" records are left out, as on the old boards.
const store = require("./store");
const ident = require("./ident");
const R = require("./site/shared/rules");
const admin = require("./admin");
const hangman = require("./hangman");
const trivia = require("./trivia");
const harf = require("./harf");

const TOP = 50;
const num = R.num;
const base = ident.baseId;
const lgOfId = id => (/_ar$/.test(id) ? "ar" : /_en$/.test(id) ? "en" : "");

// ---------- the records each game shows ----------
const SOURCES = {
  hangman: { all: () => store.all(), tidy: hangman.tidy, pub: hangman.publicRec, langs: ["en", "ar"], lgOf: id => (/_ar$/.test(id) ? "ar" : "en") },
  trivia: { all: () => store.tAll(), tidy: trivia.tidy, pub: trivia.publicRec, langs: [""], lgOf: () => "" },
  harf: { all: () => store.hAll(), tidy: harf.tidy, pub: harf.publicRec, langs: ["ar", "en"], lgOf: lgOfId },
};

async function records(game) {
  const S = SOURCES[game], se = R.curSeason();
  if (game === "harf") harf.ensureFinal();
  const rows = await S.all();
  const out = [];
  for (const r of rows) {
    if (admin.isHidden(game, r.id) || !R.namedRec(r.data)) continue;
    const d = S.pub(S.tidy(r.data));
    d.n = R.nm16(d.n); // names saved before a filter was added show as "Player" too, and drop off like unnamed ones
    if (!R.namedRec(d)) continue;
    // a record from an earlier season is only on the weekly board (for this week's days), and on the others once its
    // owner plays again
    const rs = R.seasonOfRec(d);
    if (rs < se - 1 || rs > se) continue;
    out.push({ id: r.id, b: base(r.id), lg: S.lgOf(r.id), d, cur: rs === se });
  }
  return out;
}

// ---------- one row as the page draws it ----------
function dayDetail(game, e, tab) {
  if (game === "hangman") return { ok: e.ok ? 1 : 0, t: num(e.t), m: num(e.m), hn: num(e.hn) };
  if (game === "trivia") return { t: num(e.t), s: String(e.s || "") };
  // Harf: today's letter and answers stay hidden until the day is over
  const o = { c: num(e.c) };
  if (tab === "yday") { if (e.L) o.L = e.L; o.rb = e.rb == null ? null : num(e.rb); if (Array.isArray(e.a)) o.a = e.a.map(a => (a ? { w: a.f || a.w || "", ok: a.ok ? 1 : 0 } : null)); }
  return o;
}
const head = (p, pts, extra) => Object.assign({ id: p.b, n: p.d.n, c: p.d.c, pts, streak: R.curStreak(p.d) }, extra);

function rank(game, recs, lg, tab) {
  if (tab === "week") {
    const done = game === "harf" ? e => e.lg === lg : e => "ok" in e;
    return recs.filter(p => p.lg === lg).map(p => {
      const es = R.weekEntries(p.d).filter(done);
      return { p, pts: es.reduce((a, e) => a + num(e.pts), 0), n: es.length, w: es.filter(e => e.ok).length };
    }).filter(x => x.n > 0).sort((a, b) => b.pts - a.pts || b.w - a.w || R.curStreak(b.p.d) - R.curStreak(a.p.d))
      .map(x => head(x.p, x.pts, { d: { w: x.w, p: x.n } }));
  }
  recs = recs.filter(p => p.cur);
  if (tab === "season") {
    if (game === "harf") {
      return recs.filter(p => p.lg === lg).map(p => {
        const es = Object.values(p.d.h).filter(e => e && e.lg === lg);
        return { p, pts: es.reduce((a, e) => a + num(e.pts), 0), n: es.length, w: es.filter(e => e.ok).length };
      }).filter(x => x.n > 0).sort((a, b) => b.pts - a.pts || R.curStreak(b.p.d) - R.curStreak(a.p.d))
        .map(x => head(x.p, x.pts, { d: { w: x.w, p: x.n } }));
    }
    return recs.filter(p => p.lg === lg && num(p.d.played) > 0)
      .map(p => ({ p, pts: R.seasonPts(p.d) }))
      .sort((a, b) => b.pts - a.pts || R.curStreak(b.p.d) - R.curStreak(a.p.d) || (game === "hangman" ? num(b.p.d.best) - num(a.p.d.best) : 0))
      .map(x => head(x.p, x.pts, { d: { w: num(x.p.d.wins), p: num(x.p.d.played), b: num(x.p.d.best) } }));
  }
  const k = tab === "yday" ? R.ydayKey() : R.todayKey();
  const has = game === "harf" ? p => p.lg === lg && p.d.h[k] && p.d.h[k].lg === lg : p => p.lg === lg && p.d.h[k] && "ok" in p.d.h[k];
  const cmp = game === "hangman"
    ? (a, b) => num(b.ok) - num(a.ok) || num(b.pts) - num(a.pts) || num(a.t) - num(b.t)
    : (a, b) => num(b.pts) - num(a.pts) || num(a.t) - num(b.t);
  return recs.filter(has).sort((a, b) => cmp(a.d.h[k], b.d.h[k]))
    .map(p => head(p, num(p.d.h[k].pts), { d: dayDetail(game, p.d.h[k], tab) }));
}

// ---------- cache: per game, until its records change or the day turns ----------
// Requests that arrive while the records are being read share that one read instead of each starting their own.
const cache = new Map(); // game -> { ver, day, recs, views: Map("lg|tab" -> rows) }
const reading = new Map(); // game -> { ver, day, p: promise of the cache entry }
async function view(game, lg, tab) {
  const ver = store.ver[game], day = R.todayKey();
  let c = cache.get(game);
  if (!c || c.ver !== ver || c.day !== day) {
    let r = reading.get(game);
    if (!r || r.ver !== ver || r.day !== day) {
      r = { ver, day, p: records(game).then(recs => {
        const e = { ver, day, recs, views: new Map() };
        // a write that landed while reading means the next request reads again
        if (store.ver[game] === ver) cache.set(game, e);
        return e;
      }) };
      reading.set(game, r);
      r.p.finally(() => { if (reading.get(game) === r) reading.delete(game); }).catch(() => {});
    }
    c = await r.p;
  }
  const key = lg + "|" + tab;
  if (!c.views.has(key)) c.views.set(key, rank(game, c.recs, lg, tab));
  return c;
}

// ---------- weekly medals ----------
// Once a week has closed (Friday 00:00 Saudi time), its top 3 on each of the five boards and overall are saved for
// good under meta "awards:<the week's Friday>". Each row on every board then carries its player's medals from the
// latest saved week ("aw": [{k, p}], k = "overall", "hangman-en", "trivia", ...), until the next week's are saved.
// Medals belong to the player's id, never their name (the saved name is only what they were called that week), so
// a new name keeps them. When a device's player is merged into another (signing in to an account that already has
// progress, merges.js), meta "awlink:<old id>" points at the new id and the medals follow it.
// A week waits until Harf has added the rarity bonuses for its last day (or two days have passed), so the medals
// match the final points. Players are kept by their base id, with the name and colour they had that week.
const AW_BOARDS = [["hangman", "en"], ["hangman", "ar"], ["trivia", ""], ["harf", "ar"], ["harf", "en"]];
const awKey = (g, lg) => (lg ? g + "-" + lg : g);
// the first week with medals: the week of 16 Oct 2026, when the weekly board started (AWARDS_FIRST="YYYY-MM-DD" for tests)
const AW_FIRST = R.weekStart(R.dayNum(Date.parse((/^\d{4}-\d{2}-\d{2}$/.test(process.env.AWARDS_FIRST || "") ? process.env.AWARDS_FIRST : "2026-10-16") + "T12:00:00Z")));
async function weekBoard(game, lg, from, to) {
  const S = SOURCES[game], done = game === "harf" ? e => e.lg === lg : e => "ok" in e;
  let pending = false;
  const out = [];
  for (const r of await S.all()) {
    if (S.lgOf(r.id) !== lg || admin.isHidden(game, r.id)) continue;
    const d = r.data || {}, n = R.nm16(d.n);
    if (!R.namedRec({ n })) continue;
    // straight from the saved record (not tidied): a season change since then mustn't drop the week's days
    const days = Object.assign({}, d.wk || {}, d.h || {});
    const es = Object.keys(days).filter(k => k >= from && k <= to && days[k] && done(days[k])).map(k => days[k]);
    if (!es.length) continue;
    if (game === "harf" && es.some(e => e.rb == null && Array.isArray(e.a))) pending = true;
    out.push({ id: base(r.id), n, c: R.safeColor(d.c), pts: es.reduce((a, e) => a + num(e.pts), 0), w: es.filter(e => e.ok).length });
  }
  out.sort((a, b) => b.pts - a.pts || b.w - a.w);
  return { rows: out, pending };
}
async function decideWeek(ws) {
  const from = R.dayKey(ws), to = R.dayKey(ws + 6), boards = {}, byGame = {};
  let pending = false;
  for (const [g, lg] of AW_BOARDS) {
    const b = await weekBoard(g, lg, from, to);
    pending = pending || b.pending;
    boards[awKey(g, lg)] = b.rows;
    (byGame[g] = byGame[g] || []).push({ lg, rows: b.rows });
  }
  // the bonuses for the last day are added after midnight; wait for them, but not for ever
  if (pending && R.dayNum() <= ws + 8) return null;
  const overall = new Map();
  for (const [g, bs] of Object.entries(byGame)) {
    const byAvg = bs.length > 1 && bs.every(b => b.rows.length >= MIN_ACTIVE);
    for (const x of gameScores(bs, byAvg).values()) {
      const o = overall.get(x.id) || { id: x.id, n: x.n, c: x.c, score: 0 };
      o.score = one(o.score + x.score); overall.set(x.id, o);
    }
  }
  const top = rows => rows.slice(0, 3).map(x => ({ id: x.id, n: x.n, c: x.c, pts: x.pts }));
  const out = { wk: R.weekNoOf(ws), from, to, at: Date.now(), boards: {} };
  for (const k of Object.keys(boards)) out.boards[k] = top(boards[k]);
  out.overall = [...overall.values()].filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 3)
    .map(x => ({ id: x.id, n: x.n, c: x.c, score: x.score }));
  return out;
}
// the medals now on show: the latest saved week, deciding any closed week that isn't saved yet (at most every 5 min)
let shown = null, deciding = null, decideTry = 0, links = null;
async function loadLinks() {
  if (!links) links = new Map((await store.metaSince("awlink:", "awlink:").catch(() => [])).map(x => [x.k.slice(7), String(x.v)]));
  return links;
}
// the id a player has now, following merges (a few steps at most, and never round in a circle)
function current(id) {
  const seen = new Set([id]);
  while (links && links.has(id) && seen.size < 10) { id = links.get(id); if (seen.has(id)) break; seen.add(id); }
  return id;
}
function forgetAwards() { shown = null; links = null; decideTry = 0; }
function medalMap(a) {
  const m = new Map(), add = (id, k, p) => { id = current(id); if (!m.has(id)) m.set(id, []); const l = m.get(id); if (!l.some(x => x.k === k && x.p === p)) l.push({ k, p }); };
  (a.overall || []).forEach((x, i) => add(x.id, "overall", i + 1));
  for (const [k, rows] of Object.entries(a.boards || {})) rows.forEach((x, i) => add(x.id, k, i + 1));
  for (const l of m.values()) l.sort((x, y) => (y.k === "overall") - (x.k === "overall") || x.p - y.p);
  return m;
}
async function awardsNow() {
  const last = R.weekStart() - 7; // the week that closed most recently
  if (shown && shown.ws === last) return shown;
  if (!deciding && Date.now() - decideTry > 5 * 60000) {
    decideTry = Date.now();
    deciding = (async () => {
      await loadLinks();
      const saved = await store.metaSince("awards:", "awards:" + R.dayKey(AW_FIRST)).catch(() => []);
      const have = new Set(saved.map(x => x.k));
      for (let ws = Math.max(AW_FIRST, last - 7 * 6); ws <= last; ws += 7) {
        if (have.has("awards:" + R.dayKey(ws))) continue;
        const a = await decideWeek(ws);
        if (!a) break; // still waiting on this week's last bonuses
        await store.metaPut("awards:" + R.dayKey(ws), a);
      }
      const all = await store.metaSince("awards:", "awards:" + R.dayKey(AW_FIRST)).catch(() => []);
      const newest = all.sort((a, b) => (a.k < b.k ? 1 : -1))[0];
      if (newest) shown = { ws: R.dayNum(Date.parse(newest.k.slice(7) + "T12:00:00Z")), a: newest.v, map: medalMap(newest.v) };
    })().catch(e => console.error("awards", e)).finally(() => { deciding = null; });
  }
  if (deciding) await deciding;
  return shown;
}
const medalsOf = (aw, id) => (aw && aw.map.get(id)) || null;
const awInfo = aw => (aw ? { wk: aw.a.wk, from: aw.a.from, to: aw.a.to } : null);
async function history(me) {
  await loadLinks();
  const all = (await store.metaSince("awards:", "awards:" + R.dayKey(AW_FIRST)).catch(() => [])).sort((a, b) => (a.k < b.k ? 1 : -1)).map(x => x.v);
  if (!me) return { weeks: all };
  const mb = current(base(me)), won = [];
  for (const a of all) { const l = medalMap(a).get(mb); if (l) l.forEach(x => won.push(Object.assign({ wk: a.wk, from: a.from, to: a.to }, x))); }
  return { won };
}

async function board(game, lg, tab, me) {
  const S = SOURCES[game];
  if (!S.langs.includes(lg)) lg = S.langs[0];
  if (!["today", "yday", "week", "season"].includes(tab)) tab = "today";
  const c = await view(game, lg, tab), rows = c.views.get(lg + "|" + tab), aw = await awardsNow();
  const mb = me ? base(me) : "", mi = mb ? rows.findIndex(r => r.id === mb) : -1;
  const medals = r => { const m = medalsOf(aw, r.id); return m ? { aw: m } : {}; };
  return { awards: awInfo(aw),
    game, lg, tab, se: R.curSeason(), day: R.seasonDay(), len: R.SEASON_LEN, left: R.seasonDaysLeft(), wk: R.weekNo(), wleft: R.weekDaysLeft(), total: rows.length,
    rows: rows.slice(0, TOP).map((r, i) => Object.assign({ rank: i + 1 }, r, { tag: R.tagOf(r.id) }, medals(r), r.id === mb ? { me: 1 } : {})),
    me: mi >= TOP ? Object.assign({ rank: mi + 1 }, rows[mi], { tag: R.tagOf(rows[mi].id), me: 1 }, medals(rows[mi])) : null,
  };
}

// ---------- the hub: who leads each game this week (or season), and overall ----------
// Each game's column on the hub is just its week (or season) boards as they are (top three per language, plain points).
// The overall ranking is where the boards are put on one scale:
//  - two-board games (Hangman, Harf): when both language boards have more than 5 active players, each
//    player is measured by how far above their board's average they are, in units of how spread out that board is
//    (a standard score), so standing out on a busy, close board counts for more; with 5 or fewer, against the leader;
//  - a player's better board counts in full and the other adds a tenth, but only if it's above average: a weak
//    second language never costs anything, and playing one language is never a penalty;
//  - the game's top player gets 100, everyone else a share of that (below average counts as 0); Trivia (one board)
//    is its points against the leader;
//  - the three games' contributions (up to 100 each) are added up, so every game counts the same.
// Scores keep one decimal.
const MIN_ACTIVE = 6;
const one = d => Math.round(d * 10) / 10;
function gameScores(boards, byAvg) {
  const per = new Map();
  for (const { rows } of boards) {
    const n = rows.length, top = n ? rows[0].pts : 0, avg = n ? rows.reduce((a, r) => a + r.pts, 0) / n : 0;
    const sd = n ? Math.sqrt(rows.reduce((a, r) => a + (r.pts - avg) ** 2, 0) / n) : 0;
    const z = byAvg && sd > 0;
    for (const r of rows) {
      const x = per.get(r.id) || { id: r.id, n: r.n, c: r.c, shares: [] };
      x.shares.push({ share: z ? (r.pts - avg) / sd : top > 0 ? r.pts / top : 0, pts: r.pts });
      per.set(r.id, x);
    }
  }
  for (const x of per.values()) {
    x.shares.sort((a, b) => b.share - a.share || b.pts - a.pts);
    x.raw = Math.max(0, x.shares[0].share + (x.shares[1] ? Math.max(0, x.shares[1].share) / 10 : 0)); delete x.shares;
  }
  const topRaw = Math.max(0, ...[...per.values()].map(x => x.raw));
  for (const x of per.values()) { x.score = topRaw > 0 ? one(100 * x.raw / topRaw) : 0; delete x.raw; }
  return per;
}

async function hub(me, tab) {
  if (tab !== "season") tab = "week";
  const mb = me ? base(me) : "", games = {}, overall = new Map(), aw = await awardsNow();
  const medals = id => { const m = medalsOf(aw, id); return m ? { aw: m } : {}; };
  const mark = (x, i) => Object.assign({ rank: i + 1, tag: R.tagOf(x.id), id: x.id, n: x.n, c: x.c, pts: x.pts }, medals(x.id), x.id === mb ? { me: 1 } : {});
  for (const game of ["hangman", "trivia", "harf"]) {
    const S = SOURCES[game], boards = [];
    for (const lg of S.langs) boards.push({ lg, rows: (await view(game, lg, tab)).views.get(lg + "|" + tab) });
    // the column: each board as it is
    const out = {};
    for (const { lg, rows } of boards) {
      const mi = mb ? rows.findIndex(r => r.id === mb) : -1;
      out[lg || "all"] = { players: rows.length, top: rows.slice(0, 3).map(mark), me: mi >= 3 ? mark(rows[mi], mi) : null };
    }
    const byAvg = boards.length > 1 && boards.every(b => b.rows.length >= MIN_ACTIVE);
    games[game] = { method: byAvg ? "average" : boards.length > 1 ? "leader" : "single", boards: out };
    // the overall: this game's contribution
    const list = [...gameScores(boards, byAvg).values()].sort((a, b) => b.score - a.score);
    list.forEach((x, i) => {
      const o = overall.get(x.id) || { id: x.id, n: x.n, c: x.c, score: 0, games: {} };
      o.score = one(o.score + x.score); o.games[game] = i + 1;
      overall.set(x.id, o);
    });
  }
  const all = [...overall.values()].sort((a, b) => b.score - a.score || Object.keys(b.games).length - Object.keys(a.games).length);
  const mi = mb ? all.findIndex(x => x.id === mb) : -1;
  return {
    tab, awards: awInfo(aw), se: R.curSeason(), day: R.seasonDay(), len: R.SEASON_LEN, left: R.seasonDaysLeft(), wk: R.weekNo(), wleft: R.weekDaysLeft(), games,
    overall: all.slice(0, 10).map((x, i) => Object.assign({ rank: i + 1, tag: R.tagOf(x.id) }, x, medals(x.id), x.id === mb ? { me: 1 } : {})),
    me: mi >= 10 ? Object.assign({ rank: mi + 1, tag: R.tagOf(all[mi].id), me: 1 }, all[mi], medals(all[mi].id)) : null,
  };
}

// ---------- the player's own records, and one name for every game ----------
async function mine(uid) {
  const { hm, hmAr, tri, hfAr, hfEn } = await ident.records(uid);
  const pub = (S, r) => (r ? S.pub(S.tidy(r.data)) : null);
  return { hm: pub(SOURCES.hangman, hm), hmAr: pub(SOURCES.hangman, hmAr), tri: pub(SOURCES.trivia, tri), hfAr: pub(SOURCES.harf, hfAr), hfEn: pub(SOURCES.harf, hfEn) };
}

async function profile(uid, token, n, c) {
  const th = ident.hashToken(token), own = await ident.owner(uid, th);
  if (!own.ok) return [403, { error: "This player belongs to another device" }];
  const name = typeof n === "string" && n.trim().length >= 2 ? R.nm16(n.trim()) : null, colour = c ? R.safeColor(c) : null;
  if (!name && !colour) return [400, { error: "Nothing to change" }];
  const set = d => { if (name) d.n = name; if (colour) d.c = colour; return d; };
  // each write under that game's own lock, re-reading the record inside it, so a daily answer at the same moment isn't lost
  const jobs = [];
  for (const id of [uid, uid + "_ar"]) jobs.push(hangman.withLock(uid, async () => { const r = await store.get(id); if (r && r.token === th) await store.put(id, th, set(r.data)); }));
  jobs.push(trivia.withLock(uid, async () => { const r = await store.tGet(uid); if (r && r.token === th) await store.tPut(uid, th, set(r.data)); }));
  for (const id of [uid + "_ar", uid + "_en"]) jobs.push(harf.withLock(id, async () => { const r = await store.hGet(id); if (r && r.token === th) await store.hPut(id, th, set(r.data)); }));
  await Promise.all(jobs);
  return [200, { ok: true }];
}

// ---------- routes ----------
async function handle(req, res, url, { send, readJson, ip }, limits) {
  const p = url.pathname;
  if (p === "/api/board" && req.method === "GET") {
    const game = url.searchParams.get("game");
    if (!SOURCES[game]) { send(res, 400, { error: "Unknown game" }); return true; }
    send(res, 200, await board(game, url.searchParams.get("lg") || "", url.searchParams.get("tab") || "today", url.searchParams.get("me") || ""));
    return true;
  }
  if (p === "/api/board/hub" && req.method === "GET") { send(res, 200, await hub(url.searchParams.get("me") || "", url.searchParams.get("tab") || "week")); return true; }
  if (p === "/api/awards" && req.method === "GET") {
    const me = url.searchParams.get("me") || "";
    if (me && !ident.isUid(me)) { send(res, 400, { error: "Bad player id" }); return true; }
    await awardsNow();
    send(res, 200, await history(me));
    return true;
  }
  if (p === "/api/me" && req.method === "GET") {
    const uid = url.searchParams.get("uid") || "";
    if (!ident.isUid(uid)) { send(res, 400, { error: "Bad player id" }); return true; }
    send(res, 200, await mine(uid));
    return true;
  }
  if (p === "/api/profile" && req.method === "POST") {
    const body = await readJson(req);
    const uid = String((body && body.uid) || "");
    if (!body || !ident.isUid(uid) || typeof body.token !== "string" || body.token.length < 16) { send(res, 400, { error: "Expected {uid, token, n, c}" }); return true; }
    if (!limits.take("prof|" + ip, 20, 10)) { send(res, 429, { error: "Too many changes. Slow down a little." }); return true; }
    const [code, out] = await profile(uid, body.token, body.n, body.c);
    send(res, code, out);
    return true;
  }
  return false;
}

module.exports = { handle, board, hub, mine, profile, awardsNow, decideWeek, forgetAwards };
