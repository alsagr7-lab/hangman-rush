// scripts/swap-daily-words.js: future Arabic dailies that are room words get fresh words; past days, today and
// tomorrow never change; nothing is written if a check fails.
const { test } = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const R = require("../site/shared/rules");
const { swap } = require("../scripts/swap-daily-words");
const { roomWords } = require("../scripts/check-room-words");

const rooms = roomWords().ar, roomList = [...rooms];
const e = (w, c = "animals") => [c, w, "clue", "وصف", "meaning"];
const fresh = ["ثور", "فأر", "سنجاب", "قنفذ", "خفاش", "غراب", "نورس", "بجعة"].map(w => e(w));

test("swap: only later days that are room words change, each to an unused fresh word", () => {
  const list = [e(roomList[0]), e("ثور"), e(roomList[1]), e("نحلةكبيرة"), e(roomList[2]), e(roomList[3])];
  const r = swap(list, fresh, rooms, 2);
  assert.deepEqual(r.list.slice(0, 2), list.slice(0, 2)); // kept, even the room word on day 1
  assert.equal(r.replaced, 3);
  assert.deepEqual(r.list.slice(2).map(x => x[1]), ["فأر", "نحلةكبيرة", "سنجاب", "قنفذ"]); // ثور skipped: already a daily
  assert.ok(r.list.slice(2).every(x => !rooms.has(x[1])));
});

test("swap: bad entries in the pool are skipped, and running out is an error", () => {
  const pool = [["animals", "الفهد", "a", "b", "c"], ["nope", "ثور", "a", "b", "c"], ["animals", "ثور", "a", "ثور هنا", "c"], e("ثور")];
  assert.equal(swap([e(roomList[0])], pool, rooms, 0).list[0][1], "ثور");
  assert.throws(() => swap([e(roomList[0]), e(roomList[1])], [e("ثور")], rooms, 0), /not enough/);
});

test("the command: rewrites the encrypted list, keeps today and tomorrow, prints no words", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "swap-")), key = crypto.randomBytes(32).toString("hex"), file = path.join(tmp, "ar.enc");
  const n = R.dailyNo() + 6, list = Array.from({ length: n }, (_, i) => e(roomList[i]));
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", Buffer.from(key, "hex"), iv);
  const data = Buffer.concat([c.update(JSON.stringify(list), "utf8"), c.final()]);
  fs.writeFileSync(file, JSON.stringify({ v: 1, iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: data.toString("base64") }));
  fs.writeFileSync(path.join(tmp, "key.txt"), key + "\n");
  fs.writeFileSync(path.join(tmp, "pool.json"), JSON.stringify(fresh));
  const run = spawnSync(process.execPath, [path.join(__dirname, "..", "scripts", "swap-daily-words.js"), path.join(tmp, "pool.json")],
    { env: { ...process.env, DAILY_AR_KEY: "", DAILY_AR_KEY_FILE: path.join(tmp, "key.txt"), DAILY_WORDS_AR_FILE: file }, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const keep = R.dailyNo() + 1;
  assert.match(run.stdout, new RegExp(`#1-#${keep} unchanged; 5 later days replaced`));
  for (const w of [...fresh.map(x => x[1]), ...roomList.slice(0, n)]) assert.ok(!run.stdout.includes(w), "printed a word");
  process.env.DAILY_AR_KEY = key;
  const out = require("../scripts/daily-words").decrypt(fs.readFileSync(file, "utf8"), "DAILY_AR_KEY");
  delete process.env.DAILY_AR_KEY;
  assert.deepEqual(out.slice(0, keep), list.slice(0, keep));
  assert.ok(out.slice(keep).every(x => !rooms.has(x[1])));
  fs.rmSync(tmp, { recursive: true, force: true });
});
