// Starts the real server on a temporary JSON file (optionally seeded with records), with a test word list and a test
// Trivia daily set.
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const KEY = crypto.randomBytes(32).toString("hex");
function encrypt(list) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", Buffer.from(KEY, "hex"), iv);
  const data = Buffer.concat([c.update(JSON.stringify(list), "utf8"), c.final()]);
  return JSON.stringify({ v: 1, iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: data.toString("base64") });
}
const hashToken = t => crypto.createHash("sha256").update(t).digest("hex");

async function startServer({ env = {}, seed = null } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rush-test-"));
  const port = 3900 + Math.floor(Math.random() * 1000), base = `http://127.0.0.1:${port}`;
  fs.writeFileSync(path.join(tmp, "en.enc"), encrypt([["animals", "GIRAFFE", "Tallest animal", "أطول حيوان", "زرافة"]]));
  fs.writeFileSync(path.join(tmp, "ar.enc"), encrypt([["animals", "أسد", "King of the jungle", "ملك الغابة", "Lion"]]));
  // one Trivia daily set, starting today: question i's right answer is "Right i" (the server always lists it first)
  const q = i => ["science", 1, "Question " + i, "سؤال " + i, ["Right " + i, "Wrong a", "Wrong b", "Wrong c"], ["صح " + i, "خطأ أ", "خطأ ب", "خطأ ج"]];
  fs.writeFileSync(path.join(tmp, "trivia.enc"), encrypt({ start: new Date(Date.now() + 3 * 36e5).toISOString().slice(0, 10), days: [[0, 1, 2, 3, 4].map(q)] }));
  if (seed) fs.writeFileSync(path.join(tmp, "data.json"), JSON.stringify(seed));
  const proc = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, PORT: String(port), DATA_FILE: path.join(tmp, "data.json"), DATABASE_URL: "", ANTHROPIC_API_KEY: "",
      DAILY_KEY: KEY, DAILY_AR_KEY: KEY, DAILY_WORDS_FILE: path.join(tmp, "en.enc"), DAILY_WORDS_AR_FILE: path.join(tmp, "ar.enc"),
      TRIVIA_KEY: KEY, TRIVIA_DAILY_FILE: path.join(tmp, "trivia.enc"), ...env },
  });
  let log = "";
  proc.stdout.on("data", d => (log += d)); proc.stderr.on("data", d => (log += d));
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + "/healthz")).ok) break; } catch {}
    if (i === 99) throw new Error("server didn't start:\n" + log);
    await new Promise(r => setTimeout(r, 100));
  }
  const exited = new Promise(r => proc.once("exit", r));
  return { base, log: () => log, async stop() { proc.kill(); await exited; fs.rmSync(tmp, { recursive: true, force: true }); } };
}

module.exports = { startServer, hashToken };
