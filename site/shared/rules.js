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
  /* weeks run Friday to Thursday (UTC days, like the dailies), so the weekly boards close at midnight going into
     Friday. Week 1 is the week of Daily #1. */
  const weekStart = (dn = dayNum()) => dn - ((dn + 6) % 7); // day 0 (1 Jan 1970) was a Thursday
  const weekStartKey = () => dayKey(weekStart());
  const weekDay = () => dayNum() - weekStart() + 1; // 1..7, Friday is 1
  const weekDaysLeft = () => 8 - weekDay(); // includes today
  const weekNo = () => Math.floor((weekStart() - weekStart(EPOCH_DAY + 1)) / 7) + 1;

  /* ---------- player records (one per game) ----------
     {n name, c colour, se season, streak, best, ls last solved day, played, wins, h:{day:{ok,t,m,pts,hn,...}}, prev, sk level} */
  const COLORS = ["#2c56e0", "#d93c30", "#178a5c", "#c27a00", "#8a3ffc", "#d6337f"];
  const safeColor = c => (COLORS.includes(c) ? c : COLORS[0]);
  // names that would pass for the site's staff show as "Player"
  const RESERVED = /^(admin|administrator|moderator|mod|system|staff|support|owner|official|rushgames|مشرف|المشرف|الاداره|اداره|ادمن|الادمن|الدعم|دعم)$/;
  const nameKey = s => String(s).toLowerCase().replace(/[أإآ]/g, "ا").replace(/ة/g, "ه").replace(/[^a-z0-9ء-ي]+/g, "");
  /* Names with insults or slurs (English and Arabic) also show as "Player" on every board, and the pages ask for
     another name. Checked on a folded copy of the name: lower case, look-alike digits and symbols as letters (f4ck,
     $hit), Arabic letter forms joined (أ إ آ -> ا, ة -> ه, ى -> ي, no tashkeel or tatweel), and repeated letters
     squeezed (fuuuck). PART words are caught anywhere in the name; WORD words only on their own, so names like
     Dickson, Essex, Grape or كسرى stay fine. */
  const PART = ["fuck", "fuk", "fck", "shit", "cunt", "bitch", "whore", "porn", "pussy", "asshole", "motherf", "wank", "twat", "retard", "hitler", "nazi", "faggot", "dildo", "blowjob",
    "شرموط", "قحبه", "منيوك", "متناك", "منيك", "معرص", "ديوث", "عاهره", "نيكني", "انيكك", "يلعن", "لعنه", "زبي", "كسمك", "كسختك", "كس امك", "طيزك"];
  const RAW = ["nigger", "nigga"]; // not squeezed: "niger" would catch Niger and Nigeria
  const WORD = ["dick", "cock", "slut", "rape", "rapist", "fag", "ass", "sex", "sexy", "penis", "vagina", "boobs", "tits", "cum", "kys", "anal", "nude", "nudes", "horny",
    "كس", "زب", "نيك", "خول", "لوطي", "زاني", "زانيه", "كلب", "حمار", "حيوان", "خرا", "طيز", "عرص", "بزاز", "سكس", "حقير", "تافه", "غبي"];
  const LEET = { "0": "o", "1": "i", "!": "i", "3": "e", "4": "a", "@": "a", "5": "s", "$": "s", "7": "t", "8": "b" };
  const fold = s => String(s).toLowerCase().normalize("NFKC").replace(/[\u064B-\u065F\u0670\u0640]/g, "").replace(/[أإآٱ]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي")
    .replace(/[0134578!@$]/g, c => LEET[c]);
  const squeeze = s => s.replace(/(.)\1+/gu, "$1");
  const letters = s => s.replace(/[^a-zء-ي]+/g, "");
  const PART_K = PART.map(w => squeeze(letters(fold(w)))), WORD_K = new Set(WORD.map(w => letters(fold(w))));
  function badName(v) {
    const f = fold(v), all = letters(f), sq = squeeze(all);
    if (RAW.some(w => all.includes(w))) return true;
    if (PART_K.some(w => sq.includes(w))) return true;
    // whole words, as typed and squeezed (asss), and the name run together when it's one short word spaced out (d i c k)
    const words = f.split(/[^a-zء-ي]+/).filter(Boolean);
    // Arabic words also without a leading ال or يا (الكلب, ياكلب)
    const forms = w => [w, squeeze(w), w.replace(/^(ال|يا|وال)(?=..)/, "")];
    if (words.some(w => forms(w).some(x => WORD_K.has(x)))) return true;
    if (words.length > 1 && words.every(w => w.length === 1) && (WORD_K.has(all) || WORD_K.has(sq))) return true;
    return false;
  }
  const nm16 = v => { const s = String(v || "Player").slice(0, 16); return RESERVED.test(nameKey(s)) || badName(s) ? "Player" : s; };
  const seasonOfRec = r => num(r.se) || curSeason();
  function rollover(r) {
    // a record from an earlier season starts fresh, keeping a summary of the old one
    if (seasonOfRec(r) >= curSeason()) return false;
    r.prev = { se: seasonOfRec(r), best: r.best, wins: r.wins, played: r.played, pts: seasonPts(r) };
    // this week's days from the old season stay on the weekly board (just the points, not the answers)
    const from = weekStartKey();
    r.wk = {};
    for (const [k, e] of Object.entries(r.h || {})) if (e && k >= from) r.wk[k] = { pts: num(e.pts), ok: e.ok ? 1 : 0, lg: e.lg };
    r.se = curSeason(); r.streak = 0; r.best = 0; r.ls = ""; r.played = 0; r.wins = 0; r.h = {};
    return true;
  }
  const namedRec = r => { const n = r && typeof r.n === "string" ? r.n.trim() : ""; return n.length > 0 && n.toLowerCase() !== "player"; };
  // the record's days this week (Friday to today), including any carried over from last season
  function weekEntries(r) {
    const from = weekStartKey(), to = todayKey(), days = Object.assign({}, r.wk || {}, r.h || {});
    return Object.keys(days).filter(k => days[k] && k >= from && k <= to).map(k => days[k]);
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
  // the word without its leading "ال" or "the", which don't count for the letter or for matching. An ال written with
  // a hamza or madda (ألمانيا، إلياس، ألماس، آلاء) is part of the word, not the article, so it stays.
  function harfStem(s, lg) {
    const n = harfNorm(s, lg);
    if (lg === "ar") return n.startsWith("ال") && n.replace(/ /g, "").length > 4 && !/^\s*[أإآ]ل/.test(String(s || "").normalize("NFC")) ? n.slice(2).trim() : n;
    return n.startsWith("the ") ? n.slice(4) : n;
  }
  const harfKey = (s, lg) => harfStem(s, lg).replace(/ /g, "");
  const harfLetterOk = (s, letter, lg) => { const k = harfKey(s, lg); return k.length >= 2 && k[0] === harfNorm(letter, lg)[0]; };
  /* the same answer for rare and shared answers: singular and plural count as one word in the animal, plant and
     object categories (تمرة, تمرات and تمر; cherries and cherry; mice and mouse). Names and places are left alone,
     since a final ة or s is part of them (فاطمة, Paris). Irregular plurals no rule can catch (قطط for قطة) come from
     the referee as the answer's singular form (`base`, see harf.js). */
  const EN_IRREG = { mice: "mouse", geese: "goose", teeth: "tooth", feet: "foot", oxen: "ox", lice: "louse", children: "child", people: "person",
    men: "man", women: "woman", leaves: "leaf", loaves: "loaf", knives: "knife", wives: "wife", wolves: "wolf", calves: "calf", halves: "half",
    shelves: "shelf", scarves: "scarf", thieves: "thief", potatoes: "potato", tomatoes: "tomato", mangoes: "mango", heroes: "hero",
    cacti: "cactus", fungi: "fungus", dice: "die", octopi: "octopus" };
  function singular(w, lg) {
    if (lg === "ar") {
      if (w.length >= 5 && w.endsWith("ات")) return w.slice(0, -2);          // تمرات -> تمر, سيارات -> سيار(ة)
      if (w.length >= 3 && w.endsWith("ه")) return w.slice(0, -1);           // تمره (تمرة) -> تمر
      return w;
    }
    if (EN_IRREG[w]) return EN_IRREG[w];
    if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";       // cherries -> cherry
    if (w.length > 4 && /(ches|shes|sses|xes|zes)$/.test(w)) return w.slice(0, -2); // peaches, boxes
    if (w.length > 3 && w.endsWith("s") && !/(ss|us|is)$/.test(w)) return w.slice(0, -1); // cats, horses
    return w;
  }
  function harfGroup(s, lg, cat) {
    if (cat === "name" || cat === "place") return harfKey(s, lg);
    const words = harfStem(s, lg).split(" ").filter(Boolean);
    if (words.length) words[words.length - 1] = singular(words[words.length - 1], lg);
    return words.join("");
  }
  // a room round: answers {player: [5 words]}, valid {player: [1/0 x5]} -> points {player: [pts x5]}
  function harfRoomPoints(answers, valid, lg) {
    const counts = HARF.CATS.map(() => new Map()), out = {};
    for (const p of Object.keys(answers)) HARF.CATS.forEach((c, i) => {
      if (!(valid[p] && valid[p][i])) return;
      const k = harfGroup(answers[p][i], lg, c); counts[i].set(k, (counts[i].get(k) || 0) + 1);
    });
    for (const p of Object.keys(answers)) out[p] = HARF.CATS.map((c, i) => {
      if (!(valid[p] && valid[p][i])) return 0;
      return counts[i].get(harfGroup(answers[p][i], lg, c)) > 1 ? HARF.ROOM_SHARED : HARF.ROOM_UNIQUE;
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
    num, DAY, EPOCH_DAY, SEASON_LEN, dayNum, dayKey, todayKey, ydayKey, dailyNo, keyOfDaily, seasonOf, curSeason, seasonDay, seasonDaysLeft, msToMidnight, weekStart, weekStartKey, weekDay, weekDaysLeft, weekNo, weekEntries,
    COLORS, safeColor, nm16, badName, namedRec, seasonOfRec, rollover, seasonPts, curStreak, countDaily,
    SK_MIN, SK_MAX, clampSk, cluePctFor, bonusFor, speedBonus, TRIVIA, triviaPoints, tagOf, shuffledOrder,
    HARF, harfNorm, harfStem, harfKey, harfGroup, harfLetterOk, harfRoomPoints,
  };
});
