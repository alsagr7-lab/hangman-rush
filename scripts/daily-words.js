// Encrypts or decrypts the daily word lists. The plain lists never go into git.
//   DAILY_KEY=<64 hex chars> node scripts/daily-words.js encrypt words.json        -> writes daily-words.enc
//   DAILY_KEY=<64 hex chars> node scripts/daily-words.js decrypt > words.json
//   DAILY_AR_KEY=<64 hex chars> node scripts/daily-words.js encrypt words-ar.json --ar   -> writes daily-words-ar.enc
//   DAILY_AR_KEY=<64 hex chars> node scripts/daily-words.js decrypt --ar > words-ar.json
//   node scripts/daily-words.js newkey                                             -> prints a fresh key
// words.json is an array of [category, WORD, English clue, Arabic clue, Arabic meaning]; entry n-1 is used on daily #n.
// words-ar.json is the Arabic daily: [category, Arabic word, English clue, Arabic clue, English meaning], Arabic letters
// only (no spaces or diacritics).
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
// DAILY_WORDS_FILE / DAILY_WORDS_AR_FILE point somewhere else (the tests use a list of their own)
const FILE = process.env.DAILY_WORDS_FILE || path.join(__dirname, "..", "daily-words.enc");
const FILE_AR = process.env.DAILY_WORDS_AR_FILE || path.join(__dirname, "..", "daily-words-ar.enc");

function key(name = "DAILY_KEY") {
  const k = process.env[name] || "";
  if (!/^[0-9a-f]{64}$/i.test(k)) throw new Error(name + " must be 64 hex characters");
  return Buffer.from(k, "hex");
}
function encrypt(list, name) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key(name), iv);
  const data = Buffer.concat([c.update(JSON.stringify(list), "utf8"), c.final()]);
  return JSON.stringify({ v: 1, iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: data.toString("base64") });
}
function decrypt(text, name) {
  const o = JSON.parse(text);
  const d = crypto.createDecipheriv("aes-256-gcm", key(name), Buffer.from(o.iv, "base64"));
  d.setAuthTag(Buffer.from(o.tag, "base64"));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(o.data, "base64")), d.final()]).toString("utf8"));
}
module.exports = { decrypt, FILE, FILE_AR };

if (require.main === module) {
  const args = process.argv.slice(2), ar = args.includes("--ar"), [cmd, arg] = args.filter(a => a !== "--ar");
  const file = ar ? FILE_AR : FILE, name = ar ? "DAILY_AR_KEY" : "DAILY_KEY";
  if (cmd === "newkey") console.log(crypto.randomBytes(32).toString("hex"));
  else if (cmd === "encrypt") { fs.writeFileSync(file, encrypt(JSON.parse(fs.readFileSync(arg, "utf8")), name)); console.log("wrote", file); }
  else if (cmd === "decrypt") process.stdout.write(JSON.stringify(decrypt(fs.readFileSync(file, "utf8"), name), null, 1) + "\n");
  else { console.error("usage: newkey | encrypt <words.json> [--ar] | decrypt [--ar]"); process.exit(1); }
}
