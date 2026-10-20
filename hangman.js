// Hangman Rush daily, run by the server like Trivia and Harf: the word never leaves the server until the player has
// finished. The page sends one letter at a time and gets back where it appears; the server keeps the clock, the
// misses and the hints, scores the word with the page's own formula and writes the result into the same Hangman
// records the board already reads (players/<uid> for English, players/<uid>_ar for Arabic).
//
//   GET  /api/hangman/info?lg=en|ar       -> {n, lg, ok}            whether today's word is set up
//   POST /api/hangman/daily/state  {uid, token, lg}                  -> state (finishes a run whose time is up)
//   POST /api/hangman/daily/start  {uid, token, lg, n?, c?}          -> state
//   POST /api/hangman/daily/guess  {uid, token, lg, L}               -> state
//   POST /api/hangman/daily/hint   {uid, token, lg, kind: letter|clue} -> state
//
// state = {n, lg, entry: today's result or null, open: the run in progress or null, word: {w, c, en, ar, m} once
//          finished, rec: this language's record, recEn: the English record (holds the level) for an Arabic run}
const fs = require("fs");
const R = require("./site/shared/rules");
const store = require("./store");
const limits = require("./limits");
const ident = require("./ident");

/* ---------- today's word ----------
   Stored encrypted (daily-words.enc with DAILY_KEY, daily-words-ar.enc with DAILY_AR_KEY). */
const LISTS = { en: [], ar: [] };
try { const { decrypt, FILE } = require("./scripts/daily-words"); LISTS.en = decrypt(fs.readFileSync(FILE, "utf8")); console.log(`Daily words loaded: ${LISTS.en.length}`); }
catch (e) { console.warn("Daily words unavailable (set DAILY_KEY):", e.message); }
try { const { decrypt, FILE_AR } = require("./scripts/daily-words"); LISTS.ar = decrypt(fs.readFileSync(FILE_AR, "utf8"), "DAILY_AR_KEY"); console.log(`Arabic daily words loaded: ${LISTS.ar.length}`); }
catch (e) { console.warn("Arabic daily words unavailable (set DAILY_AR_KEY):", e.message); }
// -> [category, word, English clue, Arabic clue, meaning] for daily n, or null
function wordFor(n, lg) {
  const L = LISTS[lg]; if (!L.length) return null;
  return L[((n - 1) % L.length + L.length) % L.length];
}

/* ---------- the rules, as on the page (site/hangman/index.html) ---------- */
const MS = 60000, MAX_MISS = 6, HINT_LETTER = 30, COUNT_MS = 3000, GRACE_MS = 1500;
const AR_SAME = { "أ": "ا", "إ": "ا", "آ": "ا", "ٱ": "ا", "ة": "ه", "ى": "ي", "ئ": "ي", "ؤ": "و" };
const keyOf = ch => AR_SAME[ch] || ch;
const KEYS = { en: new Set("QWERTYUIOPASDFGHJKLZXCVBNM"), ar: new Set("ضصثقفغعهخحجشسيبلاتنمكءرزوظطذد") };
const letterHints = w => (w.length >= 7 ? 3 : w.length === 6 ? 2 : 1);
const bonusLettersFor = sk => (sk <= -4 ? 2 : sk <= -2 ? 1 : 0);
const vowels = w => [...w].filter(c => "AEIOU".includes(c)).length;
const num = R.num;
const hiddenKeys = (w, g) => [...new Set([...w].map(keyOf))].filter(k => !g.includes(k));
function points(run, t) {
  let pts = Math.max(20, 100 + R.speedBonus(t, MS) - run.miss * 10 - run.hints * HINT_LETTER);
  if (run.clue) pts = Math.round(pts * (100 - run.cluePct) / 100);
  return pts;
}

/* ---------- records ---------- */
const rowId = (uid, lg) => uid + (lg === "ar" ? "_ar" : "");
const EMPTY = () => ({ n: "Player", c: R.COLORS[0], streak: 0, best: 0, ls: "", played: 0, wins: 0, h: {}, se: R.curSeason(), sk: 0, prev: null });
// a record from an earlier season starts fresh here (the page used to do this through its own saves)
const tidy = d => { const r = Object.assign(EMPTY(), d && typeof d === "object" ? d : {}); r.h = r.h && typeof r.h === "object" && !Array.isArray(r.h) ? r.h : {}; if (R.seasonOfRec(r) < R.curSeason()) R.rollover(r); return r; };
// the board shows records without the run in progress
const publicRec = r => { const o = Object.assign({}, r); delete o.run; return o; };

const withLock = ident.locker();

// writes the finished word into the record, exactly like the page's recordDaily(), and moves the level
function finish(rec, recEn, run, W, solved, now) {
  const t = Math.min(MS, Math.max(0, now - run.at)), k = run.d;
  R.rollover(rec);
  rec.h[k] = { ok: solved ? 1 : 0, t, m: run.miss, pts: solved ? points(run, t) : 0, hn: run.hints + (run.clue ? 1 : 0), at: run.at };
  R.countDaily(rec, solved);
  recEn.sk = R.clampSk(num(recEn.sk) + (solved ? 1 : -1)); // the level lives in the English record, shared by both words
  delete rec.run;
}

function stateOut(n, lg, rec, recEn, W) {
  const today = R.todayKey(), e = rec.h[today] && "ok" in rec.h[today] ? rec.h[today] : null, run = rec.run && rec.run.d === today ? rec.run : null;
  const out = { n, lg, entry: e, open: null, word: null, rec: publicRec(rec) };
  if (lg === "ar") out.recEn = publicRec(recEn);
  if (e && W) out.word = { c: W[0], w: W[1], en: W[2], ar: W[3], m: W[4] };
  if (run && W && !e) {
    const w = W[1], now = Date.now();
    out.open = {
      c: W[0], p: [...w].map(ch => (run.g.includes(keyOf(ch)) ? ch : "_")).join(""), g: run.g, miss: run.miss, maxMiss: MAX_MISS,
      hints: run.hints, maxHints: run.maxHints, bonus: run.bonus, cluePct: run.cluePct, hd: hiddenKeys(w, run.g).length,
      v: lg === "en" ? vowels(w) : null, clue: run.clue ? { en: W[2], ar: W[3] } : null,
      wait: Math.max(0, run.at - now), left: Math.max(0, run.at + MS - now), ms: MS,
    };
  }
  return out;
}

async function handle(req, res, url, { send, readJson, ip }) {
  const p = url.pathname;
  if (!p.startsWith("/api/hangman/")) return false;
  if (p === "/api/hangman/info" && req.method === "GET") {
    const lg = url.searchParams.get("lg") === "ar" ? "ar" : "en", n = R.dailyNo();
    send(res, 200, { n, lg, ok: !!wordFor(n, lg) });
    return true;
  }
  if (req.method !== "POST" || !p.startsWith("/api/hangman/daily/")) return false;
  const body = await readJson(req);
  if (!body) { send(res, 400, { error: "Body must be JSON" }); return true; }
  const uid = String(body.uid || ""), lg = body.lg === "ar" ? "ar" : "en";
  if (!ident.isUid(uid) || typeof body.token !== "string" || body.token.length < 16) { send(res, 400, { error: "Expected {uid, token}" }); return true; }
  if (!limits.take("hmd|" + ip, 120, 40)) { send(res, 429, { error: "Too fast" }); return true; }

  // one request at a time per player (both languages share the level in the English record)
  return withLock(uid, async () => {
    const th = ident.hashToken(body.token), own = await ident.owner(uid, th);
    if (!own.ok) { send(res, 403, { error: "This player belongs to another device" }); return true; }
    const n = R.dailyNo(), W = wordFor(n, lg), today = R.todayKey(), now = Date.now();
    if (!W) { send(res, 503, { error: "Today's word isn't set up on this server yet" }); return true; }
    const recEn = tidy(own.recs.hm && own.recs.hm.data), rec = lg === "ar" ? tidy(own.recs.hmAr && own.recs.hmAr.data) : recEn;
    // a guess or hint mid-word changes nothing the boards show, so it leaves their cache alone; a finished word, a new
    // name or colour, or a level change does not
    const shown = JSON.stringify([rec.n, rec.c, rec.h[today], recEn.sk]);
    // a first Arabic record takes the name and colour from the English one
    if (lg === "ar" && !(own.recs.hmAr && own.recs.hmAr.data) && own.recs.hm && own.recs.hm.data) { rec.n = recEn.n; rec.c = recEn.c; }
    if (typeof body.n === "string" && body.n.trim().length >= 2) rec.n = R.nm16(body.n.trim());
    if (body.c) rec.c = R.safeColor(body.c);
    let changed = false;
    const save = async () => {
      if (own.isNew && !limits.allowNewId(ip, uid)) { send(res, 429, { error: "Too many new players from this network today" }); return false; }
      const opt = { quiet: !own.isNew && JSON.stringify([rec.n, rec.c, rec.h[today], recEn.sk]) === shown };
      await store.put(rowId(uid, lg), th, rec, opt);
      if (lg === "ar") await store.put(uid, th, recEn, opt);
      return true;
    };
    const reply = async () => { if (changed && !(await save())) return true; send(res, 200, stateOut(n, lg, rec, recEn, W)); return true; };

    // a run from an earlier day is dropped; one whose time is up is scored as hanged
    if (rec.run && rec.run.d !== today) { delete rec.run; changed = true; }
    const run = rec.run, done = rec.h[today] && "ok" in rec.h[today];
    const overdue = lim => run && now > run.at + MS + lim;

    if (p === "/api/hangman/daily/state") {
      if (overdue(0)) { finish(rec, recEn, run, W, false, now); changed = true; }
      return reply();
    }
    if (p === "/api/hangman/daily/start") {
      if (done) { send(res, 409, { error: "Today's word is finished", state: stateOut(n, lg, rec, recEn, W) }); return true; }
      if (!run) {
        const sk = num(recEn.sk), bonus = bonusLettersFor(sk);
        rec.run = { d: today, at: now + COUNT_MS, g: [keyOf(W[1][0])], miss: 0, hints: 0, clue: 0, bonus, maxHints: letterHints(W[1]) + bonus, cluePct: R.cluePctFor(sk) };
        changed = true;
      }
      return reply();
    }
    // guesses and hints need a run that has started and isn't over (a little allowance for the trip in)
    if (!run || done || now < run.at) { send(res, 409, { error: "No word in progress", state: stateOut(n, lg, rec, recEn, W) }); return true; }
    if (overdue(GRACE_MS)) { finish(rec, recEn, run, W, false, now); changed = true; return reply(); }
    const w = W[1];

    if (p === "/api/hangman/daily/guess") {
      const L = String(body.L || "");
      if (!KEYS[lg].has(L)) { send(res, 400, { error: "Unknown letter" }); return true; }
      if (!run.g.includes(L)) {
        run.g.push(L); changed = true;
        if ([...w].some(ch => keyOf(ch) === L)) { if (!hiddenKeys(w, run.g).length) finish(rec, recEn, run, W, true, now); }
        else if (++run.miss >= MAX_MISS) finish(rec, recEn, run, W, false, now);
      }
      return reply();
    }
    if (p === "/api/hangman/daily/hint") {
      if (body.kind === "clue") { if (!run.clue) { run.clue = 1; changed = true; } }
      else {
        const left = hiddenKeys(w, run.g);
        // never the last letter
        if (run.hints < run.maxHints && left.length >= 2) { run.g.push(left[Math.floor(Math.random() * left.length)]); run.hints++; changed = true; }
      }
      return reply();
    }
    send(res, 404, { error: "Not found" });
    return true;
  });
}

module.exports = { handle, wordFor, publicRec, withLock, tidy };
