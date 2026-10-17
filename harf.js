// Harf Rush (حيوان جماد إنسان) server routes.
//
// Daily: one letter a day for everyone (one for Arabic players, one for English), five categories, one attempt,
// 90 seconds timed by the server. Each valid answer is worth 10 at once, and a day with all five valid adds a
// perfect-streak bonus (+1 per day in a row, up to +5; a missed or imperfect day resets it). After midnight the
// server counts how many players gave each answer and adds a rarity bonus, which players see the next day.
//
// Answers are checked in two steps: the first letter here, then whether the word fits its category. That second
// check asks the Claude API (ANTHROPIC_API_KEY) and remembers every verdict, so each word is only ever asked about
// once. Without a key, or when the API can't be reached, answers with the right first letter count, marked as not
// checked; the nightly pass tries those again.
//
// Rooms and solo practice run in the browser; they use /api/harf/check for the same answer check.
const crypto = require("crypto");
const R = require("./site/shared/rules");
const store = require("./store");

const H = R.HARF, N = H.CATS.length;
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const hashToken = t => crypto.createHash("sha256").update(String(t)).digest("hex");
// the daily letter order is shuffled with a secret, so the public code can't tell anyone tomorrow's letter
const SECRET = process.env.HARF_KEY || process.env.DAILY_KEY || "";
const API_KEY = process.env.ANTHROPIC_API_KEY || "";
const API_URL = process.env.HARF_API_URL || "https://api.anthropic.com/v1/messages";
const MODEL = process.env.HARF_MODEL || "claude-haiku-5-5";
// a ceiling on API calls, so a bug or a busy day can't run up a bill
const CALLS_PER_HOUR = Math.max(1, Number(process.env.HARF_API_PER_HOUR) || 60);
const LANGS = ["ar", "en"];

/* ---------- the daily letter ----------
   Each language walks through its letters in a shuffled order, so no letter repeats until all have come up. */
function letterFor(n, lg) {
  const L = H.LETTERS[lg], len = L.length, i = n - 1;
  const cycle = Math.floor(i / len), pos = ((i % len) + len) % len;
  return L[R.shuffledOrder(len, `harf|${lg}|${cycle}|${SECRET}`)[pos]];
}

/* ---------- checking answers ---------- */
const verdicts = new Map(); // "lang|category|key" -> 1 / 0, in memory on top of the database
const vkey = (lg, cat, w) => `${lg}|${cat}|${R.harfKey(w, lg)}`;
let calls = [];

const CAT_RULES = {
  name: "a real person's first name (from any culture or language), or the name of a well-known person",
  animal: "an animal of any kind: mammal, bird, fish, reptile, insect, sea creature",
  plant: "a plant of any kind: tree, flower, fruit, vegetable, herb, grain, grass",
  object: "a non-living physical thing you can see or touch (an object, tool, material, food item that is not a plant, furniture, vehicle). Not an abstract idea, feeling or action",
  place: "a country, city, town, or well-known region, state or island",
};
function prompt(lg, items) {
  const lines = items.map((x, i) => `${i + 1}. category=${x.cat} | letter=${x.letter} | answer=${JSON.stringify(x.w)}`).join("\n");
  return {
    system: `You referee the word game "Name, Animal, Plant, Object, Country" (Arabic: إنسان، حيوان، نبات، جماد، بلاد). ` +
      `Players write one word per category starting with a given letter. Decide for each answer whether it is a real word or name that fits its category.\n\n` +
      `Categories:\n` + Object.entries(CAT_RULES).map(([k, v]) => `- ${k}: ${v}`).join("\n") + `\n\n` +
      `Be fair and lenient about spelling: accept common spellings, small typos, dialect words, plurals and well-known local names when the meaning is clear. ` +
      `${lg === "ar" ? "Answers are in Arabic script; a leading ال doesn't count when checking the letter." : "Answers are in English; a leading \"the\" doesn't count when checking the letter."} ` +
      `Reject made-up words, random letters, words in the wrong category, and answers that don't start with the letter.\n\n` +
      `Reply with JSON only, in the same order as the answers: {"r":[1,0,...]} where 1 means valid and 0 means not valid.`,
    user: `Language: ${lg === "ar" ? "Arabic" : "English"}\n${lines}`,
  };
}
// -> array of 1/0, or null when the API isn't set up, is over its hourly ceiling, or fails
async function askClaude(lg, items) {
  if (!API_KEY || !items.length) return null;
  const now = Date.now();
  calls = calls.filter(t => now - t < 36e5);
  if (calls.length >= CALLS_PER_HOUR) { console.warn("Harf: hourly API ceiling reached"); return null; }
  calls.push(now);
  const p = prompt(lg, items);
  try {
    const r = await fetch(API_URL, {
      method: "POST",
      headers: { "x-api-key": API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 300, temperature: 0, system: p.system, messages: [{ role: "user", content: p.user }] }),
      signal: AbortSignal.timeout(20000),
    });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j) { console.warn("Harf: API error", r.status, j && j.error && j.error.message); return null; }
    const text = (j.content || []).map(c => c.text || "").join("");
    const m = text.match(/\{[\s\S]*\}/);
    const arr = m ? JSON.parse(m[0]).r : null;
    if (!Array.isArray(arr) || arr.length !== items.length) { console.warn("Harf: unexpected API reply", text.slice(0, 200)); return null; }
    return arr.map(v => (Number(v) === 1 ? 1 : 0));
  } catch (e) { console.warn("Harf: API call failed", e.message); return null; }
}
// items [{cat, w, letter}] (letters already checked) -> array of 1 / 0 / null (not checked)
async function judge(lg, items) {
  const keys = items.map(x => vkey(lg, x.cat, x.w));
  const out = keys.map(k => (verdicts.has(k) ? verdicts.get(k) : null));
  const missing = keys.filter((k, i) => out[i] == null);
  if (missing.length) {
    const found = await store.wordsGet([...new Set(missing)]).catch(() => new Map());
    keys.forEach((k, i) => { if (out[i] == null && found.has(k)) { out[i] = Number(found.get(k)); verdicts.set(k, out[i]); } });
  }
  // ask about each unknown word once, in batches
  const ask = [], seen = new Set();
  items.forEach((x, i) => { if (out[i] == null && !seen.has(keys[i])) { seen.add(keys[i]); ask.push({ ...x, k: keys[i] }); } });
  for (let s = 0; s < ask.length; s += 40) {
    const batch = ask.slice(s, s + 40), res = await askClaude(lg, batch);
    if (!res) break;
    const pairs = batch.map((x, j) => [x.k, res[j]]);
    pairs.forEach(([k, v]) => verdicts.set(k, v));
    store.wordsPut(pairs).catch(e => console.error("Harf: saving verdicts", e.message));
  }
  return keys.map((k, i) => (out[i] != null ? out[i] : verdicts.has(k) ? verdicts.get(k) : null));
}
const clean = w => String(w == null ? "" : w).replace(/\s+/g, " ").trim().slice(0, H.MAXLEN);
// -> [{w, ok: 1/0, u?: 1 (not checked), l?: 1 (wrong letter)}] x5
async function check(lg, letter, raw) {
  const words = H.CATS.map((_, i) => clean(Array.isArray(raw) ? raw[i] : ""));
  const out = words.map(w => ({ w, ok: 0 })), todo = [];
  words.forEach((w, i) => {
    if (!w) return;
    if (!R.harfLetterOk(w, letter, lg)) { out[i].l = 1; return; }
    todo.push(i);
  });
  const v = await judge(lg, todo.map(i => ({ cat: H.CATS[i], w: words[i], letter })));
  todo.forEach((i, k) => { if (v[k] == null) { out[i].ok = 1; out[i].u = 1; } else out[i].ok = v[k]; });
  return out;
}

/* ---------- players ---------- */
const EMPTY = () => ({ n: "Player", c: R.COLORS[0], se: R.curSeason(), streak: 0, best: 0, ls: "", played: 0, wins: 0, h: {} });
function tidy(d) {
  const r = Object.assign(EMPTY(), d && typeof d === "object" ? d : {});
  r.n = R.nm16(r.n); r.c = R.safeColor(r.c);
  r.h = r.h && typeof r.h === "object" ? r.h : {};
  for (const k of Object.keys(r.h).sort().slice(0, -40)) delete r.h[k]; // keep 40 days
  return r;
}
// anyone can read the board, so today's answers stay hidden until the day is over
function publicRec(r) {
  const o = Object.assign({}, r), today = R.todayKey();
  delete o.run;
  o.h = {};
  for (const [k, e] of Object.entries(r.h || {})) { o.h[k] = Object.assign({}, e); if (k === today) delete o.h[k].a; }
  return o;
}
// the device holding the player's token may write; a Hangman or Trivia record with the same id counts too
async function authorize(uid, token) {
  if (!ID_RE.test(uid || "") || typeof token !== "string" || token.length < 16) return { error: [400, "Expected {uid, token}"] };
  const th = hashToken(token);
  const [hr, tri, hm] = await Promise.all([store.hGet(uid), store.tGet(uid), store.get(uid)]);
  if ([hr, tri, hm].some(x => x && x.token !== th)) return { error: [403, "This player belongs to another device"] };
  const rec = tidy(hr && hr.data);
  if (R.rollover(rec)) rec.run = null;
  return { th, rec };
}
const locks = new Map();
function withLock(uid, fn) {
  const prev = locks.get(uid) || Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(uid, next.catch(() => {}));
  next.finally(() => { if (locks.get(uid) === next) locks.delete(uid); }).catch(() => {});
  return next;
}

/* ---------- the daily run ----------
   rec.run = {d: day key, n, lg, L: letter, at: start time, dr: latest saved draft [5 words]} */
const deadline = run => run.at + H.DAILY_MS + H.GRACE_MS;
async function finish(rec, run, raw, usedMs) {
  const a = await check(run.lg, run.L, raw);
  const c = a.filter(x => x.ok).length, perfect = c === N;
  R.countDaily(rec, perfect); // a perfect day extends the streak; an imperfect or missed one resets it
  const b = c * H.BASE, sb = perfect ? Math.min(H.STREAK_MAX, rec.streak) : 0;
  rec.h[run.d] = { lg: run.lg, L: run.L, a, c, b, sb, rb: null, pts: b + sb, ok: perfect ? 1 : 0, t: Math.min(H.DAILY_MS, Math.max(0, usedMs)) };
  rec.run = null;
}
// a run whose time ran out (the player closed the page) is scored with its last saved draft
async function expire(rec) {
  const run = rec.run;
  if (!run || run.d !== R.todayKey()) { if (run) rec.run = null; return !!run; }
  if (Date.now() <= deadline(run)) return false;
  await finish(rec, run, run.dr || [], H.DAILY_MS);
  return true;
}
function stateOut(rec, lg) {
  const today = R.todayKey(), n = R.dailyNo(), e = rec.h[today] || null, run = rec.run && rec.run.d === today ? rec.run : null;
  const y = rec.h[R.ydayKey()] || null;
  return {
    n, cats: H.CATS, ms: H.DAILY_MS, api: !!API_KEY, streak: R.curStreak(rec), best: rec.best,
    entry: e, yday: y && y.rb != null ? y : null,
    open: run ? { lg: run.lg, L: run.L, left: Math.max(0, run.at + H.DAILY_MS - Date.now()), dr: run.dr || [] } : null,
  };
}

/* ---------- after midnight: rarity bonuses ----------
   Runs on the first request of a new day (the free server may well have been asleep at midnight). It finishes any
   past day that hasn't been: tries the API again on answers that weren't checked, then counts how many players
   gave each valid answer, per language. Each record is then updated under its player's lock, so a daily being
   played at the same moment isn't overwritten. */
let finalDone = "", finalizing = null;
function ensureFinal() {
  const today = R.todayKey();
  if (finalDone === today) return Promise.resolve();
  if (!finalizing) finalizing = finalizeDays(today).then(() => { finalDone = today; }, e => console.error("Harf: finalize", e))
    .finally(() => { finalizing = null; });
  return finalizing;
}
async function finalizeDays(today) {
  const rows = (await store.hAll()).map(r => ({ id: r.id, data: tidy(r.data) }));
  const days = new Set();
  for (const r of rows) for (const [k, e] of Object.entries(r.data.h)) if (k < today && e && e.rb == null && Array.isArray(e.a)) days.add(k);
  for (const day of [...days].sort()) {
    const entries = rows.map(r => ({ id: r.id, e: r.data.h[day] })).filter(x => x.e && Array.isArray(x.e.a));
    // a second try on unchecked answers
    for (const lg of LANGS) {
      const items = [];
      entries.forEach(x => { if (x.e.lg === lg) x.e.a.forEach((a, i) => { if (a.u && a.ok) items.push({ x, i, cat: H.CATS[i], w: a.w, letter: x.e.L }); }); });
      if (!items.length) continue;
      const v = await judge(lg, items);
      items.forEach((it, j) => { if (v[j] != null) { const a = it.x.e.a[it.i]; a.ok = v[j]; delete a.u; } });
    }
    // count answers per language and category
    const counts = new Map(), players = { ar: 0, en: 0 };
    for (const { e } of entries) {
      if (!LANGS.includes(e.lg)) continue;
      players[e.lg]++;
      e.a.forEach((a, i) => { if (a.ok) { const k = `${e.lg}|${i}|${R.harfKey(a.w, e.lg)}`; counts.set(k, (counts.get(k) || 0) + 1); } });
    }
    const patch = new Map();
    for (const { id, e } of entries) {
      const np = players[e.lg] || 1;
      let rb = 0;
      e.a.forEach((a, i) => {
        if (!a.ok) { delete a.n; return; }
        const cnt = counts.get(`${e.lg}|${i}|${R.harfKey(a.w, e.lg)}`) || 1;
        a.n = cnt;
        if (np < 2) return; // a bonus for rarity needs someone to compare with
        if (cnt === 1) rb += H.RARE_ONLY; else if (cnt / np < H.RARE_SHARE) rb += H.RARE_FEW;
      });
      e.c = e.a.filter(a => a.ok).length; e.b = e.c * H.BASE;
      if (e.c < N) { e.sb = 0; e.ok = 0; }
      e.rb = rb; e.np = np; e.pts = e.b + e.sb + rb;
      patch.set(id, e);
    }
    for (const [id, e] of patch) {
      await withLock(id, async () => {
        const fresh = await store.hGet(id);
        if (!fresh) return;
        const d = tidy(fresh.data);
        if (!d.h[day] || d.h[day].rb != null) return;
        d.h[day] = e;
        await store.hSetData(id, d);
      });
    }
    console.log(`Harf: day ${day} finished for ${patch.size} players`);
  }
}

/* ---------- routes ---------- */
const checkCalls = new Map();
async function handle(req, res, url, { send, readJson }) {
  const p = url.pathname;
  if (!p.startsWith("/api/harf/")) return false;

  if (p === "/api/harf/players" && req.method === "GET") {
    await ensureFinal();
    const rows = await store.hAll();
    send(res, 200, rows.map(r => ({ id: r.id, data: publicRec(tidy(r.data)) })));
    return true;
  }
  if (p === "/api/harf/info" && req.method === "GET") {
    send(res, 200, { n: R.dailyNo(), cats: H.CATS, api: !!API_KEY, letters: H.LETTERS });
    return true;
  }
  if (req.method !== "POST") return false;
  const body = await readJson(req);
  if (!body) { send(res, 400, { error: "Body must be JSON" }); return true; }
  const lgOf = v => (LANGS.includes(v) ? v : "ar");

  // rooms and practice: check one player's answers for a letter (a few seconds apart at most per player)
  if (p === "/api/harf/check") {
    const uid = String(body.uid || "");
    if (!ID_RE.test(uid)) { send(res, 400, { error: "Expected uid" }); return true; }
    const lg = lgOf(body.lg), letter = String(body.L || "");
    if (!H.LETTERS[lg].includes(letter)) { send(res, 400, { error: "Unknown letter" }); return true; }
    const last = checkCalls.get(uid) || 0;
    if (Date.now() - last < 3000) { send(res, 429, { error: "Too fast" }); return true; }
    checkCalls.set(uid, Date.now());
    if (checkCalls.size > 5000) checkCalls.clear();
    send(res, 200, { a: await check(lg, letter, body.answers), api: !!API_KEY });
    return true;
  }

  const uid = String(body.uid || "");
  return withLock(uid, async () => {
    const a = await authorize(uid, body.token);
    if (a.error) { send(res, a.error[0], { error: a.error[1] }); return true; }
    const { th, rec } = a;
    if (typeof body.n === "string" && body.n.trim().length >= 2) rec.n = R.nm16(body.n.trim());
    if (body.c) rec.c = R.safeColor(body.c);
    const save = () => store.hPut(uid, th, rec);
    const today = R.todayKey(), n = R.dailyNo();

    if (p === "/api/harf/daily/state") {
      await ensureFinal();
      // the finishing pass may have just updated this record
      const fresh = await store.hGet(uid);
      if (fresh) { const d = tidy(fresh.data); rec.h = d.h; }
      const changed = await expire(rec);
      if (changed || (fresh && (body.n || body.c))) await save();
      send(res, 200, stateOut(rec, lgOf(body.lg)));
      return true;
    }

    if (p === "/api/harf/daily/start") {
      await expire(rec);
      if (rec.h[today]) { await save(); send(res, 409, { error: "Today's daily is finished", state: stateOut(rec) }); return true; }
      if (!rec.run || rec.run.d !== today) {
        const lg = lgOf(body.lg);
        rec.run = { d: today, n, lg, L: letterFor(n, lg), at: Date.now(), dr: [] };
      }
      await save();
      send(res, 200, stateOut(rec));
      return true;
    }

    if (p === "/api/harf/daily/save") {
      const run = rec.run;
      if (!run || run.d !== today || Date.now() > deadline(run)) { send(res, 409, { error: "No daily in progress" }); return true; }
      run.dr = H.CATS.map((_, i) => clean(Array.isArray(body.dr) ? body.dr[i] : ""));
      await save();
      send(res, 200, { ok: true });
      return true;
    }

    if (p === "/api/harf/daily/submit") {
      const run = rec.run;
      if (!run || run.d !== today) {
        const changed = await expire(rec);
        if (changed) await save();
        send(res, 409, { error: "No daily in progress", state: stateOut(rec) });
        return true;
      }
      if (Date.now() > deadline(run)) await finish(rec, run, run.dr || [], H.DAILY_MS); // too late: the last saved draft counts
      else await finish(rec, run, body.answers, Date.now() - run.at);
      await save();
      send(res, 200, stateOut(rec));
      return true;
    }

    send(res, 404, { error: "Not found" });
    return true;
  });
}

module.exports = { handle, letterFor, check, prompt };
