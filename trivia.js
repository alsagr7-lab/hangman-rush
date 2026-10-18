// Trivia Rush server routes.
//
// Daily: five questions a day, the same for everyone. The server hands out one question at a time, notes when it
// sent it and scores the answer by its own clock, so looking answers up or reading them off the network doesn't
// help. Daily questions come from trivia-daily.enc (unlocked with TRIVIA_KEY) and never appear in rooms or practice.
//
// Rooms and practice: questions come from site/trivia/questions.json. When a round starts, the host asks
// /api/trivia/pick for questions that nobody in the room has seen in the last TRIVIA_COOLDOWN_DAYS days, and every
// player in the room is marked as having seen them.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const R = require("./site/shared/rules");
const store = require("./store");
const limits = require("./limits");
const ident = require("./ident");

const T = R.TRIVIA;
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const COOLDOWN_MS = Math.max(1, Number(process.env.TRIVIA_COOLDOWN_DAYS) || 60) * R.DAY;
const hashToken = t => crypto.createHash("sha256").update(String(t)).digest("hex");

/* ---------- question banks ---------- */
// room/practice bank: [id, category, difficulty 1-3, question en, question ar, [answers en], [answers ar]]; answer 0 is right
let BANK = [], BY_ID = new Map();
try {
  BANK = JSON.parse(fs.readFileSync(path.join(__dirname, "site", "trivia", "questions.json"), "utf8")).q;
  BY_ID = new Map(BANK.map(x => [x[0], x]));
  console.log(`Trivia questions loaded: ${BANK.length}`);
} catch (e) { console.warn("Trivia questions missing:", e.message); }

// daily list: {start: "YYYY-MM-DD", days: [[ [category, difficulty, q en, q ar, [answers en], [answers ar]] x5 ], ...]}
let DAILY = null;
try {
  const { decrypt, FILE } = require("./scripts/trivia-daily");
  DAILY = decrypt(fs.readFileSync(FILE, "utf8"));
  console.log(`Trivia daily sets loaded: ${DAILY.days.length}`);
} catch (e) { console.warn("Trivia daily unavailable (set TRIVIA_KEY):", e.message); }

// the first daily number that has a trivia set; TRIVIA_START (YYYY-MM-DD) overrides the file
function firstDaily() {
  const s = process.env.TRIVIA_START || (DAILY && DAILY.start);
  const ms = Date.parse((s || "") + "T00:00:00Z");
  return isFinite(ms) ? R.dailyNo(ms) : null;
}
function dailySet(n) {
  if (!DAILY) return null;
  const f = firstDaily();
  if (f == null || n < f || n - f >= DAILY.days.length) return null;
  return DAILY.days[n - f];
}

/* ---------- players ---------- */
const EMPTY = () => ({ n: "Player", c: R.COLORS[0], se: R.curSeason(), streak: 0, best: 0, ls: "", played: 0, wins: 0, h: {}, sk: 0 });
function tidy(d) {
  const r = Object.assign(EMPTY(), d && typeof d === "object" ? d : {});
  r.n = R.nm16(r.n); r.c = R.safeColor(r.c); r.sk = R.clampSk(r.sk);
  r.h = r.h && typeof r.h === "object" ? r.h : {};
  for (const k of Object.keys(r.h).sort().slice(0, -40)) delete r.h[k]; // keep 40 days
  return r;
}
// who may write to this id: the device holding its token, checked against the player's records in every game
// checkNew: count a brand-new id against its network's daily allowance (only on calls that create a record)
async function authorize(uid, token, ip, checkNew = true) {
  if (!ID_RE.test(uid || "") || /_(ar|en)$/.test(uid) || typeof token !== "string" || token.length < 16) return { error: [400, "Expected {uid, token}"] };
  const th = hashToken(token);
  const own = await ident.owner(uid, th);
  if (!own.ok) return { error: [403, "This player belongs to another device"] };
  if (own.isNew && checkNew && !limits.allowNewId(ip, uid)) return { error: [429, "Too many new players from this network today"] };
  const tri = own.recs.tri;
  const rec = tidy(tri && tri.data);
  if (R.rollover(rec)) rec.run = null;
  return { th, rec };
}
const publicRec = r => { const o = Object.assign({}, r); delete o.run; delete o.lvd; delete o.lvn; return o; };

// one request at a time per player, so a double tap can't score an answer twice
const locks = new Map();
function withLock(uid, fn) {
  const prev = locks.get(uid) || Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(uid, next.catch(() => {}));
  next.finally(() => { if (locks.get(uid) === next) locks.delete(uid); }).catch(() => {});
  return next;
}

/* ---------- daily run ----------
   rec.run = {d: day key, n, i: next question, at: when question i was sent (0 = not open), f: 50/50 used on i,
              free: free 50/50s left today, res: [{ok, ms, pts, f}]} */
function freshRun(rec, n) { return { d: R.todayKey(), n, i: 0, at: 0, f: 0, free: R.bonusFor(rec.sk) ? 1 : 0, res: [] }; }
function runFor(rec, n) {
  if (!rec.run || rec.run.d !== R.todayKey() || rec.run.n !== n) rec.run = freshRun(rec, n);
  return rec.run;
}
const order = (uid, n, i) => R.shuffledOrder(4, `${uid}|${n}|${i}`); // display slot -> original answer index
function questionOut(uid, n, i, q, run, rec) {
  const ord = order(uid, n, i);
  return {
    i, total: T.QUESTIONS, ms: T.DIFF.normal.ms, c: q[0],
    q: { en: q[2], ar: q[3] },
    opts: ord.map(k => ({ en: q[4][k], ar: q[5][k] })),
    fiftyPct: run.free ? 0 : R.cluePctFor(rec.sk), fifty: !!run.f,
    left: Math.max(0, T.DIFF.normal.ms - (Date.now() - run.at)),
  };
}
// a question whose time ran out counts as wrong
function expire(rec, run) {
  if (run.at && Date.now() - run.at > T.DIFF.normal.ms + T.GRACE_MS) { scoreAnswer(rec, run, -1); return true; }
  return false;
}
function scoreAnswer(rec, run, pickedOriginal) {
  const ms = T.DIFF.normal.ms, used = Math.min(ms, Math.max(0, Date.now() - run.at - 250)); // 250 ms back for the trip in
  const ok = pickedOriginal === 0 && Date.now() - run.at <= ms + T.GRACE_MS;
  const pts = R.triviaPoints(ok, used, ms, run.f === 1, R.cluePctFor(rec.sk));
  run.res.push({ ok: ok ? 1 : 0, ms: ok ? used : ms, pts, f: run.f ? 1 : 0 });
  rec.sk = R.clampSk(rec.sk + (ok ? 1 : -1));
  run.i++; run.at = 0; run.f = 0;
  const k = R.todayKey(), right = run.res.filter(x => x.ok).length;
  const entry = { at: (rec.h[k] && rec.h[k].at) || Date.now(), c: right, t: run.res.reduce((a, x) => a + x.ms, 0), m: run.res.length - right,
    pts: run.res.reduce((a, x) => a + x.pts, 0), hn: run.res.filter(x => x.f).length, s: run.res.map(x => x.ok).join("") };
  if (run.i >= T.QUESTIONS) { entry.ok = right >= T.PASS ? 1 : 0; R.countDaily(rec, !!entry.ok); }
  rec.h[k] = entry;
  return { ok, pts };
}
function stateOut(uid, rec, run, n, q) {
  return { n, total: T.QUESTIONS, i: run.i, done: run.i >= T.QUESTIONS, res: run.res, entry: rec.h[R.todayKey()] || null,
    sk: rec.sk, streak: R.curStreak(rec), best: rec.best, open: run.at && q ? questionOut(uid, n, run.i, q[run.i], run, rec) : null };
}

/* ---------- picking room/practice questions ---------- */
let lastPrune = 0;
async function pick(uids, cat, diff, count, exclude) {
  const D = T.DIFF[diff] || T.DIFF.normal;
  const fits = BANK.filter(x => x[1] === cat && D.pool(x[2]) && !exclude.has(x[0]));
  if (!fits.length) return [];
  const now = Date.now();
  if (R.dayNum(now) !== R.dayNum(lastPrune)) { lastPrune = now; store.seenPrune(now - COOLDOWN_MS).catch(e => console.error("prune", e.message)); }
  const seen = uids.length ? await store.seenAll(uids) : new Map();
  const fresh = fits.filter(x => !(seen.get(x[0]) >= now - COOLDOWN_MS));
  const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  let chosen = shuffle(fresh).slice(0, count);
  if (chosen.length < count) {
    // not enough unseen ones left: top up with the questions this group saw longest ago
    const old = fits.filter(x => !chosen.includes(x)).sort((a, b) => (seen.get(a[0]) || 0) - (seen.get(b[0]) || 0));
    chosen = chosen.concat(old.slice(0, count - chosen.length));
  }
  const ids = chosen.map(x => x[0]);
  if (uids.length) await store.seenMark(uids, ids, now);
  return ids;
}

/* ---------- routes ---------- */
// returns true when it handled the request
async function handle(req, res, url, { send, readJson, ip }) {
  const p = url.pathname;
  if (!p.startsWith("/api/trivia/")) return false;
  const n = R.dailyNo();

  if (p === "/api/trivia/players" && req.method === "GET") {
    const rows = (await store.tAll()).filter(r => !require("./admin").isHidden("trivia", r.id));
    send(res, 200, rows.map(r => ({ id: r.id, data: publicRec(tidy(r.data)) })));
    return true;
  }

  if (p === "/api/trivia/info" && req.method === "GET") {
    const f = firstDaily();
    send(res, 200, { n, daily: !!dailySet(n), first: f, last: DAILY && f != null ? f + DAILY.days.length - 1 : null, bank: BANK.length, cooldownDays: COOLDOWN_MS / R.DAY });
    return true;
  }

  // a past daily, answers included, for the archive (never today's or later)
  const am = p.match(/^\/api\/trivia\/archive\/(\d{1,5})$/);
  if (am && req.method === "GET") {
    const k = Number(am[1]), set = k < n ? dailySet(k) : null;
    if (!set) { send(res, 404, { error: "No past daily with that number" }); return true; }
    send(res, 200, { n: k, q: set });
    return true;
  }

  if (req.method !== "POST") return false;
  const body = await readJson(req);
  if (!body) { send(res, 400, { error: "Body must be JSON" }); return true; }

  if (p === "/api/trivia/pick") {
    // only a real player (their own id and token) may pick, a few rounds a minute per address
    if (!limits.take("pick|" + ip, 12, 6)) { send(res, 429, { error: "Too many rounds. Slow down a little." }); return true; }
    const who = await authorize(String(body.uid || ""), body.token, ip, false);
    if (who.error) { send(res, who.error[0], { error: who.error[1] }); return true; }
    const uids = Array.isArray(body.uids) ? [...new Set(body.uids.filter(u => ID_RE.test(u || "")))].slice(0, 32) : [];
    const cat = T.CATS.includes(body.cat) ? body.cat : null;
    if (!cat) { send(res, 400, { error: "Unknown category" }); return true; }
    const count = Math.max(1, Math.min(10, Number(body.count) || T.QUESTIONS));
    const exclude = new Set(Array.isArray(body.exclude) ? body.exclude.slice(0, 500).map(String) : []);
    send(res, 200, { ids: await pick(uids, cat, String(body.diff || "normal"), count, exclude) });
    return true;
  }

  const uid = String(body.uid || "");
  return withLock(uid, async () => {
    const a = await authorize(uid, body.token, ip, p !== "/api/trivia/daily/state");
    if (a.error) { send(res, a.error[0], { error: a.error[1] }); return true; }
    const { th, rec } = a;
    if (typeof body.n === "string" && body.n.trim().length >= 2) rec.n = R.nm16(body.n.trim());
    if (body.c) rec.c = R.safeColor(body.c);
    const save = () => store.tPut(uid, th, rec);

    // a room result moves the level by at most one step per call. Rooms can lower it by at most 3 steps a day, so
    // nobody can sink their level on purpose to get the extra help in the daily
    if (p === "/api/trivia/level") {
      const d = Math.sign(Number(body.d) || 0), today = R.todayKey();
      const last = levelCalls.get(uid) || 0;
      if (rec.lvd !== today) { rec.lvd = today; rec.lvn = 0; }
      const downOk = d > 0 || R.num(rec.lvn) < 3;
      if (d && downOk && Date.now() - last > 4000) {
        levelCalls.set(uid, Date.now()); rec.sk = R.clampSk(rec.sk + d);
        if (d < 0) rec.lvn = R.num(rec.lvn) + 1;
        await save();
      }
      send(res, 200, { sk: rec.sk });
      return true;
    }

    const set = dailySet(n);
    if (p === "/api/trivia/daily/state") {
      if (!set) { send(res, 200, { n, unavailable: true, sk: rec.sk, streak: R.curStreak(rec), best: rec.best, entry: null }); return true; }
      const run = runFor(rec, n);
      if (expire(rec, run)) await save();
      send(res, 200, stateOut(uid, rec, run, n, set));
      return true;
    }
    if (!set) { send(res, 503, { error: "Today's trivia isn't set up on this server yet" }); return true; }
    const run = runFor(rec, n);
    let changed = expire(rec, run);

    if (p === "/api/trivia/daily/next") {
      if (run.i >= T.QUESTIONS) { if (changed) await save(); send(res, 409, { error: "Today's daily is finished", state: stateOut(uid, rec, run, n, set) }); return true; }
      if (!run.at) { run.at = Date.now(); run.f = 0; changed = true; }
      if (changed) await save();
      send(res, 200, questionOut(uid, n, run.i, set[run.i], run, rec));
      return true;
    }

    if (p === "/api/trivia/daily/fifty") {
      if (!run.at || Number(body.i) !== run.i) { if (changed) await save(); send(res, 409, { error: "That question isn't open" }); return true; }
      const ord = order(uid, n, run.i);
      // remove two wrong answers, the same two every time for this player
      const wrongSlots = ord.map((k, slot) => (k === 0 ? -1 : slot)).filter(s => s >= 0);
      const keep = R.shuffledOrder(3, `${uid}|${n}|${run.i}|f`)[0];
      const removed = wrongSlots.filter((_, j) => j !== keep);
      if (!run.f) { run.f = 1; if (run.free) { run.free--; run.fFree = 1; } await save(); }
      send(res, 200, { removed });
      return true;
    }

    if (p === "/api/trivia/daily/answer") {
      if (!run.at || Number(body.i) !== run.i) {
        if (changed) await save();
        send(res, 409, { error: "That question is closed", state: stateOut(uid, rec, run, n, set) });
        return true;
      }
      const slot = Number(body.pick), ord = order(uid, n, run.i);
      const original = Number.isInteger(slot) && slot >= 0 && slot < 4 ? ord[slot] : -1;
      const wasFree = run.fFree; delete run.fFree;
      const cluePct = R.cluePctFor(rec.sk);
      if (wasFree) run.f = 2; // a free 50/50 costs nothing (scoreAnswer only charges f === 1)
      const r = scoreAnswer(rec, run, original);
      await save();
      send(res, 200, { ok: r.ok, pts: r.pts, correct: ord.indexOf(0), cluePct, state: stateOut(uid, rec, run, n, set) });
      return true;
    }

    send(res, 404, { error: "Not found" });
    return true;
  });
}
const levelCalls = new Map();

module.exports = { handle, firstDaily };
