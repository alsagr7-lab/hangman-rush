// Rules shared by Hangman Rush, Trivia Rush and the server: days and seasons, streaks, player levels,
// scoring and player tags. Loaded by the browser as window.RushRules and by Node with require().
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.RushRules = api;
})(typeof self !== "undefined" ? self : this, function () {
  const num = v => { v = Number(v); return isFinite(v) ? v : 0; };

  /* ---------- days and seasons ----------
     Daily #1 was 14 Oct 2026. Both games use the same numbering and the same 30-day seasons. */
  const DAY = 864e5, EPOCH_DAY = Math.floor(Date.UTC(2026, 9, 13) / DAY), SEASON_LEN = 30;
  const dayNum = (x = Date.now()) => Math.floor(x / DAY);
  const dayKey = dn => new Date(dn * DAY).toISOString().slice(0, 10);
  const todayKey = () => dayKey(dayNum());
  const ydayKey = () => dayKey(dayNum() - 1);
  const dailyNo = (x = Date.now()) => dayNum(x) - EPOCH_DAY;
  const keyOfDaily = n => dayKey(n + EPOCH_DAY);
  const seasonOf = dn => Math.floor((dn - EPOCH_DAY - 1) / SEASON_LEN) + 1;
  const curSeason = () => Math.max(1, seasonOf(dayNum()));
  const seasonDay = () => ((dayNum() - EPOCH_DAY - 1) % SEASON_LEN + SEASON_LEN) % SEASON_LEN + 1; // 1..30
  const seasonDaysLeft = () => SEASON_LEN - seasonDay() + 1; // includes today
  const msToMidnight = () => (dayNum() + 1) * DAY - Date.now();

  /* ---------- player records (one per game) ----------
     {n name, c colour, se season, streak, best, ls last solved day, played, wins, h:{day:{ok,t,m,pts,hn,...}}, prev, sk level} */
  const COLORS = ["#2c56e0", "#d93c30", "#178a5c", "#c27a00", "#8a3ffc", "#d6337f"];
  const safeColor = c => (COLORS.includes(c) ? c : COLORS[0]);
  // names that would pass for the site's staff show as "Player"
  const RESERVED = /^(admin|administrator|moderator|mod|system|staff|support|owner|official|rushgames|مشرف|المشرف|الاداره|اداره|ادمن|الادمن|الدعم|دعم)$/;
  const nameKey = s => String(s).toLowerCase().replace(/[أإآ]/g, "ا").replace(/ة/g, "ه").replace(/[^a-z0-9ء-ي]+/g, "");
  const nm16 = v => { const s = String(v || "Player").slice(0, 16); return RESERVED.test(nameKey(s)) ? "Player" : s; };
  const seasonOfRec = r => num(r.se) || curSeason();
  function rollover(r) {
    // a record from an earlier season starts fresh, keeping a summary of the old one
    if (seasonOfRec(r) >= curSeason()) return false;
    r.prev = { se: seasonOfRec(r), best: r.best, wins: r.wins, played: r.played, pts: seasonPts(r) };
    r.se = curSeason(); r.streak = 0; r.best = 0; r.ls = ""; r.played = 0; r.wins = 0; r.h = {};
    return true;
  }
  function seasonPts(r) { return Object.values(r.h || {}).reduce((a, e) => a + num(e.pts), 0); }
  function curStreak(r) { return r.ls === todayKey() || r.ls === ydayKey() ? num(r.streak) : 0; }
  // count a finished daily: a solved day extends the streak, anything else breaks it
  function countDaily(r, solved) {
    const k = todayKey(), y = ydayKey();
    r.played = num(r.played) + 1;
    if (solved) { r.wins = num(r.wins) + 1; r.streak = r.ls === y ? num(r.streak) + 1 : (r.ls === k ? num(r.streak) : 1); r.ls = k; r.best = Math.max(num(r.best), r.streak); }
    else r.streak = 0;
  }

  /* ---------- levels ----------
     +1 for every correct result, -1 for every miss (rooms and the daily only, never solo practice).
     The paid hint costs 50% of the round score, +5 points per level (25%..90%).
     Players two or more levels below the start get extra help. */
  const SK_MIN = -5, SK_MAX = 8;
  const clampSk = v => Math.max(SK_MIN, Math.min(SK_MAX, Math.round(num(v))));
  const cluePctFor = sk => Math.max(25, Math.min(90, 50 + 5 * clampSk(sk)));
  const bonusFor = sk => (clampSk(sk) <= -4 ? 2 : clampSk(sk) <= -2 ? 1 : 0);

  /* ---------- scoring ----------
     Every scored item, a Hangman word or a trivia question: 100 for getting it, up to +240 for speed. */
  const speedBonus = (msUsed, ms) => Math.round(240 * Math.max(0, ms - msUsed) / ms);

  /* ---------- trivia ---------- */
  const TRIVIA = {
    QUESTIONS: 5,          // per daily and per room round
    PASS: 3,               // correct answers needed for the daily to count as solved (keeps the streak)
    REVEAL_MS: 3500,       // answer shown between room questions
    COUNT_MS: 3000,        // countdown before a round or the daily
    GRACE_MS: 700,         // network allowance on server-timed answers
    FAST_MS: 1000,         // once everyone in a room or practice has answered, the timer drains over this long
    DIFF: {
      easy: { ms: 20000, help: true, pool: d => d <= 2 },
      normal: { ms: 15000, help: true, pool: () => true },
      hard: { ms: 10000, help: false, pool: d => d >= 2 },
    },
    CATS: ["geography", "history", "science", "space", "animals", "sports", "football", "food", "saudi", "tech", "gaming", "cars"],
    VOTE_OPTIONS: 5,       // categories offered in each vote
  };
  // points for one trivia question; the 50/50 takes cluePct% of it, unless it was free
  function triviaPoints(correct, msUsed, ms, fifty, cluePct) {
    if (!correct) return 0;
    let p = Math.max(20, 100 + speedBonus(msUsed, ms));
    if (fifty) p = Math.round(p * (100 - cluePct) / 100);
    return p;
  }

  /* ---------- harf (حيوان جماد إنسان): one letter, five categories ---------- */
  const HARF = {
    CATS: ["name", "animal", "plant", "object", "place"], // إنسان، حيوان، نبات، جماد، بلاد
    DAILY_MS: 90000,       // the daily: one attempt, 90 seconds
    ROOM_MS: [60000, 90000, 120000],
    COUNT_MS: 3000,        // countdown before a round or the daily
    GRACE_MS: 5000,        // network allowance on the daily's deadline
    STOP_MS: 5000,         // after someone presses STOP in a room, everyone else gets this long
    MAXLEN: 30,
    BASE: 10,              // daily: per valid answer, shown at once
    STREAK_MAX: 5,         // daily: +1 per day in a row with all five valid, up to +5
    RARE_ONLY: 5,          // daily, revealed next day: nobody else wrote it
    RARE_FEW: 2,           //   fewer than RARE_SHARE of that day's players wrote it
    RARE_SHARE: 0.2,
    ROOM_UNIQUE: 10,       // rooms: valid and nobody else in the round wrote it
    ROOM_SHARED: 5,        //   valid but someone else wrote it too
    // hard letters (ث ذ ض ظ غ, q u x z) are left out
    LETTERS: {
      ar: ["ا", "ب", "ت", "ج", "ح", "خ", "د", "ر", "ز", "س", "ش", "ص", "ط", "ع", "ف", "ق", "ك", "ل", "م", "ن", "ه", "و", "ي"],
      en: ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P", "R", "S", "T", "V", "W", "Y"],
    },
  };
  // Arabic: drop diacritics and tatweel, treat أ/إ/آ/ا, ة/ه, ى/ي, ؤ/و and ئ/ي alike.
  // English: lower case, no accents. Both keep letters and single spaces only.
  function harfNorm(s, lg) {
    s = String(s || "").normalize("NFC");
    if (lg === "ar") {
      s = s.replace(/[ً-ٰٟۖ-ۭـ]/g, "").replace(/[أإآٱ]/g, "ا").replace(/ة/g, "ه")
        .replace(/ى/g, "ي").replace(/ؤ/g, "و").replace(/ئ/g, "ي").replace(/[^ء-ي ]+/g, " ");
    } else {
      s = s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z ]+/g, " ");
    }
    return s.replace(/\s+/g, " ").trim();
  }
  // the word without its leading "ال" or "the", which don't count for the letter or for matching
  function harfStem(s, lg) {
    const n = harfNorm(s, lg);
    if (lg === "ar") return n.startsWith("ال") && n.replace(/ /g, "").length > 4 ? n.slice(2).trim() : n;
    return n.startsWith("the ") ? n.slice(4) : n;
  }
  const harfKey = (s, lg) => harfStem(s, lg).replace(/ /g, "");
  const harfLetterOk = (s, letter, lg) => { const k = harfKey(s, lg); return k.length >= 2 && k[0] === harfNorm(letter, lg)[0]; };
  // a room round: answers {player: [5 words]}, valid {player: [1/0 x5]} -> points {player: [pts x5]}
  function harfRoomPoints(answers, valid, lg) {
    const counts = HARF.CATS.map(() => new Map()), out = {};
    for (const p of Object.keys(answers)) HARF.CATS.forEach((_, i) => {
      if (!(valid[p] && valid[p][i])) return;
      const k = harfKey(answers[p][i], lg); counts[i].set(k, (counts[i].get(k) || 0) + 1);
    });
    for (const p of Object.keys(answers)) out[p] = HARF.CATS.map((_, i) => {
      if (!(valid[p] && valid[p][i])) return 0;
      return counts[i].get(harfKey(answers[p][i], lg)) > 1 ? HARF.ROOM_SHARED : HARF.ROOM_UNIQUE;
    });
    return out;
  }

  /* ---------- tags: a short, permanent code per player so same-named players stay distinguishable ---------- */
  const TAG_ABC = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  function tagOf(id) {
    if (!id || id === "me") return "";
    let h = 2166136261;
    for (const ch of String(id)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
    let s = ""; for (let i = 0; i < 4; i++) { s += TAG_ABC[h % 32]; h = Math.floor(h / 32); }
    return s;
  }

  // seeded shuffle, so a player sees the same answer order every time they look at a question
  function seeded(str) { let h = 2166136261; for (const ch of String(str)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; } return () => { h ^= h << 13; h >>>= 0; h ^= h >>> 17; h ^= h << 5; h >>>= 0; return h / 4294967296; }; }
  function shuffledOrder(n, seed) { const r = seeded(seed), a = [...Array(n).keys()]; for (let i = n - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

  return {
    num, DAY, EPOCH_DAY, SEASON_LEN, dayNum, dayKey, todayKey, ydayKey, dailyNo, keyOfDaily, seasonOf, curSeason, seasonDay, seasonDaysLeft, msToMidnight,
    COLORS, safeColor, nm16, seasonOfRec, rollover, seasonPts, curStreak, countDaily,
    SK_MIN, SK_MAX, clampSk, cluePctFor, bonusFor, speedBonus, TRIVIA, triviaPoints, tagOf, shuffledOrder,
    HARF, harfNorm, harfStem, harfKey, harfLetterOk, harfRoomPoints,
  };
});
