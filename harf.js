// Harf Rush (حيوان جماد إنسان) server routes.
//
// Daily: one letter a day for everyone (one for Arabic players, one for English), five categories, one attempt,
// 90 seconds timed by the server. Each valid answer is worth 10 at once, and a day with all five valid adds a
// perfect-streak bonus (+1 per day in a row, up to +5; a missed or imperfect day resets it). After midnight the
// server counts how many players gave each answer and adds a rarity bonus, which players see the next day.
//
// Answers are checked in steps, cheapest first:
//   1. the first letter, here;
//   2. the built-in word lists in content/harf/ (common names, animals, plants, objects and places), no AI needed;
//   3. verdicts saved from earlier checks (harf_words);
//   4. only then the Claude API (ANTHROPIC_API_KEY), whose verdict is saved so each word is only ever asked about once.
// Without a key, or when the API can't be reached, an unknown word with the right first letter counts, marked as
// not checked; the nightly pass tries those again.
//
// Rooms and solo practice run in the browser; they use /api/harf/check for the same answer check.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const R = require("./site/shared/rules");
const store = require("./store");

const H = R.HARF, N = H.CATS.length, num = R.num;
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
const verdicts = new Map(); // "lang|category|key" -> {ok: 1/0, fix: correct spelling or null}, in memory on top of the database
const vkey = (lg, cat, w) => `${lg}|${cat}|${R.harfKey(w, lg)}`;

// the built-in word lists: content/harf/<lang>.json = {category: [words]}
const KNOWN = new Set();
for (const lg of ["ar", "en"]) {
  try {
    const list = JSON.parse(fs.readFileSync(path.join(__dirname, "content", "harf", lg + ".json"), "utf8"));
    for (const cat of H.CATS) for (const w of list[cat] || []) KNOWN.add(vkey(lg, cat, w));
  } catch (e) { console.warn(`Harf: word list ${lg} missing:`, e.message); }
}
console.log(`Harf word list: ${KNOWN.size} words`);
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
      `Be fair and lenient about spelling: accept misspellings when it's clear which word was meant (e.g. "catapilar" for caterpillar), as well as common spellings, dialect words, plurals and well-known local names. ` +
      `${lg === "ar" ? "Answers are in Arabic script; a leading ال doesn't count when checking the letter." : "Answers are in English; a leading \"the\" doesn't count when checking the letter."} ` +
      `Reject made-up words, random letters, words in the wrong category, and answers that don't start with the letter.\n\n` +
      `Reply with JSON only, in the same order as the answers: {"r":[1,0,...],"fix":[null,"Caterpillar",...]}. ` +
      `In "r", 1 means valid and 0 means not valid. In "fix", give the correctly spelled word for a valid answer that was misspelled, ` +
      `and null when it was already spelled right (or isn't valid). Keep the same script as the answer and don't add "ال" or "the".`,
    user: `Language: ${lg === "ar" ? "Arabic" : "English"}\n${lines}`,
  };
}
// one request to the Claude API -> the parsed JSON object in its reply, or null when the API isn't set up, is over
// its hourly ceiling, or fails
async function callModel(model, system, user, maxTokens) {
  if (!API_KEY) return null;
  const now = Date.now();
  calls = calls.filter(t => now - t < 36e5);
  if (calls.length >= CALLS_PER_HOUR) { console.warn("Harf: hourly API ceiling reached"); return null; }
  calls.push(now);
  try {
    const r = await fetch(API_URL, {
      method: "POST",
      headers: { "x-api-key": API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }),
      signal: AbortSignal.timeout(25000),
    });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j) { console.warn("Harf: API error", r.status, j && j.error && j.error.message); return null; }
    const text = (j.content || []).map(c => c.text || "").join("");
    const m = text.match(/\{[\s\S]*\}/);
    try { if (m) return JSON.parse(m[0]); } catch {}
    console.warn("Harf: unexpected API reply", j.stop_reason, text.slice(0, 200));
    return null;
  } catch (e) { console.warn("Harf: API call failed", e.message); return null; }
}
// -> array of {ok: 1/0, fix: correct spelling or null}, or null
async function askClaude(lg, items) {
  if (!items.length) return null;
  const p = prompt(lg, items), o = await callModel(MODEL, p.system, p.user, 300 + 30 * items.length);
  const arr = o && o.r;
  if (!Array.isArray(arr) || arr.length !== items.length) { if (o) console.warn("Harf: reply didn't match the answers"); return null; }
  const fixes = Array.isArray(o.fix) ? o.fix : [];
  return arr.map((v, i) => {
    const ok = Number(v) === 1 || v === true ? 1 : 0;
    let fix = ok && typeof fixes[i] === "string" ? clean(fixes[i]) : null;
    // only a real correction: same first letter, and a different word once spelling variants are set aside
    if (fix && (!R.harfLetterOk(fix, items[i].letter, lg) || R.harfKey(fix, lg) === R.harfKey(items[i].w, lg))) fix = null;
    return { ok, fix };
  });
}

/* ---------- appeals ----------
   A player can appeal an answer that was turned down for its category (not one with the wrong first letter).
   A stronger model takes a second look, told to allow rare, classical, regional and dialect words. If it agrees,
   the saved verdict flips to valid, so the word counts for everyone from then on. A few appeals per player a day. */
const APPEAL_MODEL = process.env.HARF_APPEAL_MODEL || "claude-sonnet-5-5";
const APPEALS_PER_DAY = Math.max(1, Number(process.env.HARF_APPEALS_PER_DAY) || 5);
const appealsToday = new Map(); // "day|uid" -> count, for rooms and practice (the daily counts in the record)
// -> {ok: 1/0, why} or null when the second look couldn't happen
async function appealWord(lg, cat, w, letter) {
  if (!R.harfLetterOk(w, letter, lg)) return { ok: 0, why: "" };
  const k = vkey(lg, cat, w);
  if (KNOWN.has(k)) return { ok: 1, why: "" };
  const o = await callModel(APPEAL_MODEL,
    `You are the appeals referee for the word game "Name, Animal, Plant, Object, Country" (إنسان، حيوان، نبات، جماد، بلاد). ` +
    `A first referee turned this answer down and the player has appealed. Take a careful second look.\n\n` +
    `Categories:\n` + Object.entries(CAT_RULES).map(([c, v]) => `- ${c}: ${v}`).join("\n") + `\n\n` +
    `Accept the answer if it is a genuine word or name that fits the category, including rare, classical (فصحى), regional, ` +
    `dialect and transliterated words, alternative spellings, and well-known proper nouns. Turn it down if it is made up, ` +
    `in the wrong category, or doesn't start with the letter (a leading ال or "the" doesn't count).\n\n` +
    `Reply with JSON only, nothing else: {"ok":1 or 0,"why":"one short sentence (under 20 words) for the player, in ${lg === "ar" ? "Arabic" : "English"}"}`,
    `Language: ${lg === "ar" ? "Arabic" : "English"}\ncategory=${cat} | letter=${letter} | answer=${JSON.stringify(w)}`, 600);
  // the referee may answer 1/0, true/false or "yes"/"no"
  const v = o && (o.ok !== undefined ? o.ok : o.valid);
  const yes = v === true || v === 1 || /^(1|true|yes|valid)$/i.test(String(v));
  const no = v === false || v === 0 || /^(0|false|no|invalid)$/i.test(String(v));
  if (!yes && !no) { if (o) console.warn("Harf: unexpected appeal reply", JSON.stringify(o).slice(0, 200)); return null; }
  const ok = yes ? 1 : 0, why = String(o.why || o.reason || "").slice(0, 200);
  if (ok) { verdicts.set(k, { ok: 1, fix: null }); store.wordsPut([[k, { ok: 1, fix: null }]]).catch(e => console.error("Harf: saving verdict", e.message)); }
  console.log(`Harf appeal: ${lg} ${cat} ${w} -> ${ok ? "upheld" : "turned down"}`);
  return { ok, why };
}
// items [{cat, w, letter}] (letters already checked) -> array of {ok: 1/0, fix} or null (not checked)
async function judge(lg, items) {
  const keys = items.map(x => vkey(lg, x.cat, x.w));
  const out = keys.map(k => (KNOWN.has(k) ? { ok: 1, fix: null } : verdicts.has(k) ? verdicts.get(k) : null));
  const missing = keys.filter((k, i) => out[i] == null);
  if (missing.length) {
    const found = await store.wordsGet([...new Set(missing)]).catch(() => new Map());
    keys.forEach((k, i) => { if (out[i] == null && found.has(k)) { out[i] = found.get(k); verdicts.set(k, out[i]); } });
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
// -> [{w, ok: 1/0, f?: correct spelling, u?: 1 (not checked), l?: 1 (wrong letter)}] x5
async function check(lg, letter, raw) {
  const words = H.CATS.map((_, i) => clean(Array.isArray(raw) ? raw[i] : ""));
  const out = words.map(w => ({ w, ok: 0 })), todo = [];
  words.forEach((w, i) => {
    if (!w) return;
    if (!R.harfLetterOk(w, letter, lg)) { out[i].l = 1; return; }
    todo.push(i);
  });
  const v = await judge(lg, todo.map(i => ({ cat: H.CATS[i], w: words[i], letter })));
  todo.forEach((i, k) => { if (v[k] == null) { out[i].ok = 1; out[i].u = 1; } else { out[i].ok = v[k].ok; if (v[k].ok && v[k].fix) out[i].f = v[k].fix; } });
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
// anyone can read the board
function publicRec(r) {
  const o = Object.assign({}, r), today = R.todayKey();
  delete o.run;
  o.h = {};
  // today's answers and letter stay hidden until the day is over, so the board can't give the letter away
  for (const [k, e] of Object.entries(r.h || {})) { o.h[k] = Object.assign({}, e); delete o.h[k].pre; if (k === today) { delete o.h[k].a; delete o.h[k].L; } }
  return o;
}
// Each player has one record per language ("<uid>_ar", "<uid>_en"): the Arabic and English dailies have their own
// letter, streak, perfect streak and leaderboard, and a player may play both each day.
const rowId = (uid, lg) => `${uid}_${lg}`;
// the device holding the player's token may write; a Hangman or Trivia record with the same id counts too
async function authorize(uid, token, lg) {
  if (!ID_RE.test(uid || "") || typeof token !== "string" || token.length < 16) return { error: [400, "Expected {uid, token}"] };
  const th = hashToken(token);
  const [hr, tri, hm] = await Promise.all([store.hGet(rowId(uid, lg)), store.tGet(uid), store.get(uid)]);
  if ([hr, tri, hm].some(x => x && x.token !== th)) return { error: [403, "This player belongs to another device"] };
  const rec = tidy(hr && hr.data);
  rec.lg = lg;
  if (R.rollover(rec)) rec.run = null;
  return { th, rec };
}

/* ---------- one-time move to per-language records ----------
   Records from before the split (id "<uid>", both languages in one) are split by each day's language into
   "<uid>_ar" and "<uid>_en", with streaks counted again from the days themselves, and the old record removed. */
let migrated = null;
function ensureMigrated() {
  if (!migrated) migrated = migrate().catch(e => { console.error("Harf: migration", e); migrated = null; });
  return migrated;
}
async function migrate() {
  const legacy = (await store.hAll()).filter(r => !/_(ar|en)$/.test(r.id));
  for (const { id } of legacy) {
    const old = await store.hGet(id);
    if (!old) continue;
    const d = tidy(old.data);
    for (const lg of LANGS) {
      const days = Object.keys(d.h).filter(k => d.h[k] && d.h[k].lg === lg).sort();
      const runHere = d.run && d.run.lg === lg ? d.run : null;
      if (!days.length && !runHere) continue;
      const r = Object.assign(EMPTY(), { n: d.n, c: d.c, se: d.se, lg, h: {}, run: runHere });
      let prev = null;
      for (const k of days) {
        const e = d.h[k]; r.h[k] = e; r.played++;
        const dn = Math.round(Date.parse(k + "T00:00:00Z") / R.DAY);
        if (e.ok) { r.wins++; r.streak = prev === dn - 1 ? r.streak + 1 : 1; r.ls = k; r.best = Math.max(r.best, r.streak); } else r.streak = 0;
        prev = dn;
      }
      if (d.apd) { r.apd = d.apd; r.ap = d.ap; }
      const existing = await store.hGet(rowId(id, lg));
      if (!existing) await store.hPut(rowId(id, lg), old.token, r);
    }
    await store.hDel(id);
  }
  if (legacy.length) console.log(`Harf: split ${legacy.length} record(s) by language`);
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
  const before = { ls: rec.ls, streak: rec.streak, best: rec.best, wins: rec.wins };
  R.countDaily(rec, perfect); // a perfect day extends the streak; an imperfect or missed one resets it
  const b = c * H.BASE, sb = perfect ? Math.min(H.STREAK_MAX, rec.streak) : 0;
  rec.h[run.d] = { lg: run.lg, L: run.L, a, c, b, sb, rb: null, pts: b + sb, ok: perfect ? 1 : 0, t: Math.min(H.DAILY_MS, Math.max(0, usedMs)), pre: before };
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
function stateOut(rec) {
  const appealsLeft = rec.apd === R.todayKey() ? Math.max(0, APPEALS_PER_DAY - num(rec.ap)) : APPEALS_PER_DAY;
  const today = R.todayKey(), n = R.dailyNo(), e = rec.h[today] || null, run = rec.run && rec.run.d === today ? rec.run : null;
  const y = rec.h[R.ydayKey()] || null;
  return {
    n, lg: rec.lg, cats: H.CATS, ms: H.DAILY_MS, api: !!API_KEY, streak: R.curStreak(rec), best: rec.best, appealsLeft,
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
      items.forEach((it, j) => { if (v[j] != null) { const a = it.x.e.a[it.i]; a.ok = v[j].ok; if (v[j].ok && v[j].fix) a.f = v[j].fix; delete a.u; } });
    }
    // count answers per language and category
    const counts = new Map(), players = { ar: 0, en: 0 };
    for (const { e } of entries) {
      if (!LANGS.includes(e.lg)) continue;
      players[e.lg]++;
      // a misspelt answer counts as its correct spelling
      e.a.forEach((a, i) => { if (a.ok) { const k = `${e.lg}|${i}|${R.harfKey(a.f || a.w, e.lg)}`; counts.set(k, (counts.get(k) || 0) + 1); } });
    }
    const patch = new Map();
    for (const { id, e } of entries) {
      const np = players[e.lg] || 1;
      let rb = 0;
      e.a.forEach((a, i) => {
        if (!a.ok) { delete a.n; return; }
        const cnt = counts.get(`${e.lg}|${i}|${R.harfKey(a.f || a.w, e.lg)}`) || 1;
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
  await ensureMigrated();

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

  // rooms and practice: a second look at one answer
  if (p === "/api/harf/appeal" && !body.daily) {
    const uid = String(body.uid || "");
    if (!ID_RE.test(uid)) { send(res, 400, { error: "Expected uid" }); return true; }
    const lg = lgOf(body.lg), letter = String(body.L || ""), cat = H.CATS[Number(body.i)], w = clean(body.w);
    if (!H.LETTERS[lg].includes(letter) || !cat || !w) { send(res, 400, { error: "Expected {lg, L, i, w}" }); return true; }
    const key = R.todayKey() + "|" + uid, used = appealsToday.get(key) || 0;
    if (used >= APPEALS_PER_DAY) { send(res, 429, { error: "No appeals left today", left: 0 }); return true; }
    const r = await appealWord(lg, cat, w, letter);
    if (!r) { send(res, 503, { error: "Appeals aren't available right now" }); return true; }
    appealsToday.set(key, used + 1);
    if (appealsToday.size > 5000) appealsToday.clear();
    send(res, 200, { ok: r.ok, why: r.why, left: APPEALS_PER_DAY - used - 1 });
    return true;
  }

  const uid = String(body.uid || ""), lg = lgOf(body.lg), id = rowId(uid, lg);
  return withLock(id, async () => {
    const a = await authorize(uid, body.token, lg);
    if (a.error) { send(res, a.error[0], { error: a.error[1] }); return true; }
    const { th, rec } = a;
    if (typeof body.n === "string" && body.n.trim().length >= 2) rec.n = R.nm16(body.n.trim());
    if (body.c) rec.c = R.safeColor(body.c);
    const save = () => store.hPut(id, th, rec);
    const today = R.todayKey(), n = R.dailyNo();

    if (p === "/api/harf/daily/state") {
      await ensureFinal();
      // the finishing pass may have just updated this record
      const fresh = await store.hGet(id);
      if (fresh) { const d = tidy(fresh.data); rec.h = d.h; }
      const changed = await expire(rec);
      if (changed || (fresh && (body.n || body.c))) await save();
      send(res, 200, stateOut(rec));
      return true;
    }

    if (p === "/api/harf/daily/start") {
      await expire(rec);
      if (rec.h[today]) { await save(); send(res, 409, { error: "Today's daily is finished", state: stateOut(rec) }); return true; }
      if (!rec.run || rec.run.d !== today) rec.run = { d: today, n, lg, L: letterFor(n, lg), at: Date.now(), dr: [] };
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

    // the daily: appeal one of today's answers; a win adds its points (and the perfect streak, if that makes five)
    if (p === "/api/harf/appeal") {
      const e = rec.h[today], i = Number(body.i);
      const a = e && Array.isArray(e.a) && Number.isInteger(i) ? e.a[i] : null;
      if (!a || !a.w || a.ok || a.l || a.ap) { send(res, 409, { error: "That answer can't be appealed", state: stateOut(rec) }); return true; }
      rec.ap = rec.apd === today ? num(rec.ap) : 0; rec.apd = today;
      if (rec.ap >= APPEALS_PER_DAY) { send(res, 429, { error: "No appeals left today", left: 0, state: stateOut(rec) }); return true; }
      const r = await appealWord(e.lg, H.CATS[i], a.w, e.L);
      if (!r) { send(res, 503, { error: "Appeals aren't available right now", state: stateOut(rec) }); return true; }
      rec.ap++;
      a.ap = r.ok ? 1 : -1; if (r.why) a.why = r.why;
      if (r.ok) {
        a.ok = 1;
        e.c = e.a.filter(x => x.ok).length; e.b = e.c * H.BASE;
        if (e.c === N && !e.ok && e.pre) {
          // count the day again as perfect, from the streak it started with
          Object.assign(rec, { ls: e.pre.ls, streak: e.pre.streak, best: e.pre.best, wins: e.pre.wins });
          rec.played = Math.max(0, num(rec.played) - 1);
          R.countDaily(rec, true);
          e.ok = 1; e.sb = Math.min(H.STREAK_MAX, rec.streak);
        }
        e.pts = e.b + e.sb + num(e.rb);
      }
      await save();
      send(res, 200, { ok: r.ok, why: r.why, left: APPEALS_PER_DAY - rec.ap, state: stateOut(rec) });
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
