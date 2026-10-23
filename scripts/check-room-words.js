// Room and practice words live in the page (site/hangman/index.html); the daily words are encrypted. A word in both
// would let anyone practise today's daily, so the two lists must never share a word.
//
//   DAILY_KEY=... DAILY_AR_KEY=... node scripts/check-room-words.js   -> lists any room word that is also a daily word
//
// The game server runs the same check at start-up and logs only how many it found (never the words).
const fs = require("fs");
const path = require("path");

const PAGE = path.join(__dirname, "..", "site", "hangman", "index.html");
const AR_SAME = { "أ": "ا", "إ": "ا", "آ": "ا", "ٱ": "ا", "ة": "ه", "ى": "ي", "ئ": "ي", "ؤ": "و" };
const norm = w => [...String(w || "").toUpperCase()].map(c => AR_SAME[c] || c).join("");

// the room words of one language, read from the page source: {en: Set, ar: Set}
function roomWords(html = fs.readFileSync(PAGE, "utf8")) {
  const grab = name => {
    const m = html.match(new RegExp("const " + name + "=(\\{[\\s\\S]*?\\});\\n"));
    if (!m) return new Set();
    const obj = JSON.parse(m[1].replace(/(^|[{,\n])\s*([a-z]+):/g, '$1"$2":'));
    return new Set(Object.values(obj).flat().map(e => norm(e[0])));
  };
  return { en: grab("ROOM_WORDS"), ar: grab("ROOM_WORDS_AR") };
}

// lists: {en: [[cat, word, ...]], ar: [...]} -> {en: [words in both], ar: [...]}; from: the first list index to
// check (days already played don't matter: their words are out)
function overlaps(lists, rooms = roomWords(), from = 0) {
  const out = { en: [], ar: [] };
  for (const lg of ["en", "ar"]) (lists[lg] || []).forEach((e, i) => { if (i >= from && rooms[lg].has(norm(e[1]))) out[lg].push(e[1]); });
  return out;
}
module.exports = { roomWords, overlaps };

if (require.main === module) {
  const { decrypt, FILE, FILE_AR } = require("./daily-words");
  const lists = { en: [], ar: [] };
  try { lists.en = decrypt(fs.readFileSync(FILE, "utf8")); } catch (e) { console.log("English daily list not checked:", e.message); }
  try { lists.ar = decrypt(fs.readFileSync(FILE_AR, "utf8"), "DAILY_AR_KEY"); } catch (e) { console.log("Arabic daily list not checked:", e.message); }
  const rooms = roomWords(), o = overlaps(lists, rooms);
  console.log(`room words: ${rooms.en.size} English, ${rooms.ar.size} Arabic`);
  for (const lg of ["en", "ar"]) console.log(`${lg}: ${o[lg].length ? o[lg].length + " also in the daily list: " + o[lg].join(", ") : "no overlap"}`);
  process.exitCode = o.en.length || o.ar.length ? 1 : 0;
}
