// Backwards Rush (party): voice clips are only taken for a live party, come back under their id, and the word list,
// clips, matching and points hold together.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const WebSocket = require("ws");
const R = require("../site/shared/rules");
const { startServer } = require("./helper");

const ROOT = path.join(__dirname, "..");
let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv.stop(); });

const post = (code, body, type = "audio/webm") => fetch(`${srv.base}/api/party/clip?c=${code}`, { method: "POST", headers: { "Content-Type": type }, body });

test("a clip is refused without a live party, kept for one, and served back", async () => {
  const sound = Buffer.alloc(2000, 7);
  assert.strictEqual((await post("WXYZ", sound)).status, 404);
  // a big screen hosts party WXYZ
  const tv = new WebSocket(srv.base.replace(/^http/, "ws") + "/ws");
  await new Promise(r => tv.once("open", r));
  tv.send(JSON.stringify({ t: "join", room: "pt-wxyz", presence: { tv: 1 } }));
  await new Promise(r => setTimeout(r, 150));
  assert.strictEqual((await post("WXYZ", sound, "text/html")).status, 415);
  assert.strictEqual((await post("WXYZ", Buffer.alloc(10))).status, 400);
  assert.strictEqual((await post("WXYZ", Buffer.alloc(500 * 1024, 1))).status, 413);
  const r = await post("WXYZ", sound, "audio/mp4");
  assert.strictEqual(r.status, 200);
  const { id } = await r.json();
  assert.match(id, /^[0-9a-f]{32}$/);
  const g = await fetch(`${srv.base}/api/party/clip/${id}`);
  assert.strictEqual(g.status, 200);
  assert.strictEqual(g.headers.get("content-type"), "audio/mp4");
  assert.deepStrictEqual(Buffer.from(await g.arrayBuffer()), sound);
  assert.strictEqual((await fetch(`${srv.base}/api/party/clip/${"0".repeat(32)}`)).status, 404);
  tv.close();
});

test("every word is in a topic, and a guess counts give or take a letter", () => {
  const bank = JSON.parse(fs.readFileSync(path.join(ROOT, "site", "party", "backwards.json"), "utf8"));
  assert.ok(bank.en.length >= 60 && bank.ar.length >= 60);
  for (const [id, c, w] of bank.en.concat(bank.ar)) {
    assert.ok(R.BACKWARDS.CATS.includes(c), id);
    assert.ok(R.backwardsMatch(w, w, []), w);
  }
  assert.ok(R.backwardsMatch("selena gomes", "Selena Gomez", ["Selena"]));
  assert.ok(R.backwardsMatch("Selena", "Selena Gomez", ["Selena"]));
  assert.ok(!R.backwardsMatch("Gomez", "Selena Gomez", ["Selena"]));
  assert.ok(R.backwardsMatch("رونالدو", "كريستيانو رونالدو", ["رونالدو"]));
  assert.ok(!R.backwardsMatch("", "Pizza", []));
  assert.strictEqual(R.backwardsPoints(0), 200);
  assert.strictEqual(R.backwardsPoints(R.BACKWARDS.LISTEN_MS / 2), 150);
  assert.strictEqual(R.backwardsPoints(R.BACKWARDS.LISTEN_MS * 2), 100);
  assert.strictEqual(R.backwardsPoints(15000, 30000), 150); // out of the turn's own guessing time
  assert.ok(R.BACKWARDS.LISTEN_OPTS.includes(R.BACKWARDS.LISTEN_MS) && R.BACKWARDS.PREP_OPTS.includes(R.BACKWARDS.PREP_MS));
});
