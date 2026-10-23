// Replaces future Arabic daily words that are also room/practice words, so practising never shows a future daily.
//
//   DAILY_AR_KEY=<64 hex> node scripts/swap-daily-words.js <new-words.json> [--keep N]
//   (or DAILY_AR_KEY_FILE=<path to a file holding the key> instead of DAILY_AR_KEY)
//
// <new-words.json> is a list of replacement entries in the daily format: [category, Arabic word, English clue,
// Arabic clue, English meaning]. It's private: it holds future daily words, so it never goes into git.
// Dailies #1 .. #N stay exactly as they are (N = --keep, at least today's daily: a day already being played never changes;
// tomorrow's can, as long as the new list is live before it starts).
// Each later daily whose word is a room word (read from site/hangman/index.html) gets the next replacement that is
// neither a room word nor already a daily word. Writes daily-words-ar.enc and prints counts only, never words.
const fs = require("fs");
const crypto = require("crypto");
const R = require("../site/shared/rules");
const { FILE_AR } = require("./daily-words");
const { roomWords } = require("./check-room-words");

const AR_SAME = { "أ": "ا", "إ": "ا", "آ": "ا", "ٱ": "ا", "ة": "ه", "ى": "ي", "ئ": "ي", "ؤ": "و" };
const norm = w => [...String(w || "").toUpperCase()].map(c => AR_SAME[c] || c).join("");
const CATS = ["animals", "food", "countries", "cities", "sports", "hotel", "jobs", "house", "space", "tech"];
const okEntry = e => Array.isArray(e) && e.length === 5 && CATS.includes(e[0]) && /^[ء-ي]+$/.test(e[1]) && !/^ال/.test(e[1])
  && e.slice(2).every(s => typeof s === "string" && s.trim()) && !norm(e[3]).includes(norm(e[1])); // the clue never gives the word away

function keyBuf() {
  let k = process.env.DAILY_AR_KEY || "";
  if (!k && process.env.DAILY_AR_KEY_FILE) k = fs.readFileSync(process.env.DAILY_AR_KEY_FILE, "utf8");
  k = k.trim();
  if (!/^[0-9a-f]{64}$/i.test(k)) throw new Error("DAILY_AR_KEY (or the file in DAILY_AR_KEY_FILE) must be 64 hex characters");
  return Buffer.from(k, "hex");
}
function decrypt(text, key) {
  const o = JSON.parse(text), d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(o.iv, "base64"));
  d.setAuthTag(Buffer.from(o.tag, "base64"));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(o.data, "base64")), d.final()]).toString("utf8"));
}
function encrypt(list, key) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([c.update(JSON.stringify(list), "utf8"), c.final()]);
  return JSON.stringify({ v: 1, iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: data.toString("base64") });
}

// -> { list, kept, clashing, replaced, poolLeft } (pure, for tests)
function swap(list, pool, rooms, keep) {
  const out = list.map(e => e.slice()), clashes = [];
  for (let i = keep; i < out.length; i++) if (rooms.has(norm(out[i][1]))) clashes.push(i);
  const used = new Set(out.map((e, i) => (clashes.includes(i) ? null : norm(e[1]))).filter(Boolean));
  const fresh = pool.filter(okEntry).filter(e => !rooms.has(norm(e[1])));
  let p = 0;
  for (const i of clashes) {
    while (p < fresh.length && used.has(norm(fresh[p][1]))) p++;
    if (p >= fresh.length) throw new Error(`not enough replacement words: ${clashes.length} needed`);
    out[i] = fresh[p].slice(); used.add(norm(fresh[p][1])); p++;
  }
  return { list: out, kept: keep, clashing: clashes.length, replaced: clashes.length, poolLeft: fresh.length - p };
}
module.exports = { swap, norm };

if (require.main === module) {
  const args = process.argv.slice(2), ki = args.indexOf("--keep");
  const poolFile = args.find((a, i) => !a.startsWith("--") && (ki < 0 || i !== ki + 1));
  if (!poolFile) { console.error("usage: node scripts/swap-daily-words.js <new-words.json> [--keep N]"); process.exit(1); }
  // never change a daily that has started (today's, by Saudi date)
  const keep = Math.max(ki >= 0 ? Number(args[ki + 1]) || 0 : 0, R.dailyNo());
  const key = keyBuf(), list = decrypt(fs.readFileSync(FILE_AR, "utf8"), key);
  const rooms = roomWords().ar;
  if (!rooms.size) throw new Error("no Arabic room words in site/hangman/index.html: put them back first");
  const r = swap(list, JSON.parse(fs.readFileSync(poolFile, "utf8")), rooms, keep);
  // check before writing: the kept days are identical and no later day is a room word
  for (let i = 0; i < keep && i < list.length; i++) if (JSON.stringify(list[i]) !== JSON.stringify(r.list[i])) throw new Error("a kept day changed");
  const left = r.list.slice(keep).filter(e => rooms.has(norm(e[1]))).length;
  if (left) throw new Error(left + " future dailies are still room words");
  fs.writeFileSync(FILE_AR, encrypt(r.list, key));
  if (JSON.stringify(decrypt(fs.readFileSync(FILE_AR, "utf8"), key)) !== JSON.stringify(r.list)) throw new Error("the written file didn't read back");
  console.log(`Arabic daily list: ${r.list.length} days; #1-#${keep} unchanged; ${r.replaced} later days replaced (they were room words); ${r.poolLeft} spare words left. Wrote ${FILE_AR}`);
}
