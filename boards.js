// The leaderboards, worked out on the server for all three games, so a page downloads a short ranked list instead of
// every player's full history.
//
//   GET /api/board?game=hangman|trivia|harf&lg=en|ar&tab=today|yday|season&me=<uid>
//        -> { game, lg, tab, se, day, len, left, total, rows: [...top 50], me: {rank, row} | null }
//   GET /api/board/hub?me=<uid>  -> each game's season leaders (best language, scored against its board's leader) and overall
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
const base = id => String(id || "").replace(/_(ar|en)$/, "");
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
    if (R.seasonOfRec(d) !== se) continue; // a record from an earlier season shows once its owner plays again
    out.push({ id: r.id, b: base(r.id), lg: S.lgOf(r.id), d });
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
const cache = new Map(); // game -> { ver, day, recs, views: Map("lg|tab" -> rows) }
async function view(game, lg, tab) {
  const ver = store.ver[game], day = R.todayKey();
  let c = cache.get(game);
  if (!c || c.ver !== ver || c.day !== day) {
    c = { ver, day, recs: await records(game), views: new Map() };
    // a write that landed while reading means the next request reads again
    if (store.ver[game] === ver) cache.set(game, c);
  }
  const key = lg + "|" + tab;
  if (!c.views.has(key)) c.views.set(key, rank(game, c.recs, lg, tab));
  return c;
}

async function board(game, lg, tab, me) {
  const S = SOURCES[game];
  if (!S.langs.includes(lg)) lg = S.langs[0];
  if (!["today", "yday", "season"].includes(tab)) tab = "today";
  const c = await view(game, lg, tab), rows = c.views.get(lg + "|" + tab);
  const mb = me ? base(me) : "", mi = mb ? rows.findIndex(r => r.id === mb) : -1;
  return {
    game, lg, tab, se: R.curSeason(), day: R.seasonDay(), len: R.SEASON_LEN, left: R.seasonDaysLeft(), total: rows.length,
    rows: rows.slice(0, TOP).map((r, i) => Object.assign({ rank: i + 1 }, r, { tag: R.tagOf(r.id) }, r.id === mb ? { me: 1 } : {})),
    me: mi >= TOP ? Object.assign({ rank: mi + 1 }, rows[mi], { tag: R.tagOf(rows[mi].id), me: 1 }) : null,
  };
}

// ---------- the hub: who leads each game this season, and overall ----------
// Each language board is scored against its own leader (the leader gets 100), so a harder or easier language
// doesn't matter. In a game with two boards, a player's better language counts. The overall ranking adds the three
// game scores, so every game counts the same.
async function hub(me) {
  const mb = me ? base(me) : "", games = {}, overall = new Map();
  for (const game of ["hangman", "trivia", "harf"]) {
    const S = SOURCES[game], per = new Map();
    for (const lg of S.langs) {
      const c = await view(game, lg, "season"), rows = c.views.get(lg + "|season");
      const top = rows.length ? rows[0].pts : 0;
      for (const r of rows) {
        const score = top > 0 ? Math.round(100 * r.pts / top) : 0;
        const x = per.get(r.id);
        if (!x || score > x.score || (score === x.score && r.pts > x.pts)) per.set(r.id, { id: r.id, n: r.n, c: r.c, score, pts: r.pts, lg });
      }
    }
    const list = [...per.values()].sort((a, b) => b.score - a.score || b.pts - a.pts);
    list.forEach((x, i) => {
      const o = overall.get(x.id) || { id: x.id, n: x.n, c: x.c, score: 0, games: {} };
      o.score += x.score; o.games[game] = i + 1;
      overall.set(x.id, o);
    });
    const mi = mb ? list.findIndex(x => x.id === mb) : -1;
    games[game] = { players: list.length, top: list.slice(0, 3).map((x, i) => Object.assign({ rank: i + 1, tag: R.tagOf(x.id) }, x, x.id === mb ? { me: 1 } : {})), me: mi >= 3 ? Object.assign({ rank: mi + 1, tag: R.tagOf(list[mi].id), me: 1 }, list[mi]) : null };
  }
  const all = [...overall.values()].sort((a, b) => b.score - a.score || Object.keys(b.games).length - Object.keys(a.games).length);
  const mi = mb ? all.findIndex(x => x.id === mb) : -1;
  return {
    se: R.curSeason(), day: R.seasonDay(), len: R.SEASON_LEN, left: R.seasonDaysLeft(), games,
    overall: all.slice(0, 10).map((x, i) => Object.assign({ rank: i + 1, tag: R.tagOf(x.id) }, x, x.id === mb ? { me: 1 } : {})),
    me: mi >= 10 ? Object.assign({ rank: mi + 1, tag: R.tagOf(all[mi].id), me: 1 }, all[mi]) : null,
  };
}

// ---------- the player's own records, and one name for every game ----------
async function mine(uid) {
  const b = base(uid);
  const [hm, hmAr, tri, hfAr, hfEn] = await Promise.all([store.get(b), store.get(b + "_ar"), store.tGet(b), store.hGet(b + "_ar"), store.hGet(b + "_en")]);
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
  if (p === "/api/board/hub" && req.method === "GET") { send(res, 200, await hub(url.searchParams.get("me") || "")); return true; }
  if (p === "/api/me" && req.method === "GET") {
    const uid = url.searchParams.get("uid") || "";
    if (!ident.ID_RE.test(uid) || /_(ar|en)$/.test(uid)) { send(res, 400, { error: "Bad player id" }); return true; }
    send(res, 200, await mine(uid));
    return true;
  }
  if (p === "/api/profile" && req.method === "POST") {
    const body = await readJson(req);
    const uid = String((body && body.uid) || "");
    if (!body || !ident.ID_RE.test(uid) || /_(ar|en)$/.test(uid) || typeof body.token !== "string" || body.token.length < 16) { send(res, 400, { error: "Expected {uid, token, n, c}" }); return true; }
    if (!limits.take("prof|" + ip, 20, 10)) { send(res, 429, { error: "Too many changes. Slow down a little." }); return true; }
    const [code, out] = await profile(uid, body.token, body.n, body.c);
    send(res, code, out);
    return true;
  }
  return false;
}

module.exports = { handle, board, hub, mine, profile };
