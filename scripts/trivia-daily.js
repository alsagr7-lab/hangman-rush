// Encrypts or decrypts the Trivia Rush daily questions. The plain list never goes into git.
//   TRIVIA_KEY=<64 hex chars> node scripts/trivia-daily.js encrypt trivia-daily.json   -> writes trivia-daily.enc
//   TRIVIA_KEY=<64 hex chars> node scripts/trivia-daily.js decrypt > trivia-daily.json
//   node scripts/trivia-daily.js newkey                                                -> prints a fresh key
// trivia-daily.json is {start: "YYYY-MM-DD", days: [[five questions], ...]}; each question is
// [category, difficulty 1-3, question en, question ar, [4 answers en], [4 answers ar]] with the right answer first.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const FILE = process.env.TRIVIA_DAILY_FILE || path.join(__dirname, "..", "trivia-daily.enc"); // the variable is for tests

function key() {
  const k = process.env.TRIVIA_KEY || "";
  if (!/^[0-9a-f]{64}$/i.test(k)) throw new Error("TRIVIA_KEY must be 64 hex characters");
  return Buffer.from(k, "hex");
}
function encrypt(list) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([c.update(JSON.stringify(list), "utf8"), c.final()]);
  return JSON.stringify({ v: 1, iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: data.toString("base64") });
}
function decrypt(text) {
  const o = JSON.parse(text);
  const d = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(o.iv, "base64"));
  d.setAuthTag(Buffer.from(o.tag, "base64"));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(o.data, "base64")), d.final()]).toString("utf8"));
}
module.exports = { decrypt, FILE };

if (require.main === module) {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "newkey") console.log(crypto.randomBytes(32).toString("hex"));
  else if (cmd === "encrypt") { fs.writeFileSync(FILE, encrypt(JSON.parse(fs.readFileSync(arg, "utf8")))); console.log("wrote", FILE); }
  else if (cmd === "decrypt") process.stdout.write(JSON.stringify(decrypt(fs.readFileSync(FILE, "utf8")), null, 1) + "\n");
  else { console.error("usage: newkey | encrypt <trivia-daily.json> | decrypt"); process.exit(1); }
}
