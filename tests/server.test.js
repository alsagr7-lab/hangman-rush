// Starts the real server on a temporary JSON file and checks the pages, the main APIs and the abuse limits.
// Run: npm test
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const R = require("../site/shared/rules");

const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rush-test-"));
let proc, log = "";

before(async () => {
  proc = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    // an unreachable database: the server should retry, then fall back to the file
    env: { ...process.env, PORT: String(PORT), DATA_FILE: path.join(tmp, "data.json"), ADMIN_KEY: "right-key-123",
      PROXY_SECRET: "s3cret", DATABASE_URL: "postgres://x:y@127.0.0.1:1/none", PG_RETRY_MS: "50,50", ANTHROPIC_API_KEY: "" },
  });
  proc.stdout.on("data", d => (log += d)); proc.stderr.on("data", d => (log += d));
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(BASE + "/healthz")).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error("server didn't start:\n" + log);
});
after(() => { proc.kill(); fs.rmSync(tmp, { recursive: true, force: true }); });

const put = (id, body) => fetch(`${BASE}/api/players/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("retries Postgres before falling back to the file", () => {
  assert.match(log, /trying again in 0.05s/);
  assert.match(log, /using the JSON file instead/);
});

test("pages load", async () => {
  for (const p of ["/", "/hangman/", "/trivia/", "/harf/", "/admin"]) {
    const r = await fetch(BASE + p);
    assert.equal(r.status, 200, p);
    assert.match(await r.text(), /<html/i, p);
  }
});

test("game APIs answer", async () => {
  for (const p of ["/api/players", "/api/trivia/players", "/api/harf/players", "/api/trivia/info", "/api/harf/info"])
    assert.equal((await fetch(BASE + p)).status, 200, p);
  const tok = "t".repeat(20);
  for (const p of ["/api/trivia/daily/state", "/api/harf/daily/state"]) {
    const r = await fetch(BASE + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ uid: "p_testapi01", token: tok, lg: "en" }) });
    assert.equal(r.status, 200, p);
  }
});

test("Hangman saves: normal result kept, points capped, future days dropped, finished days locked", async () => {
  const id = "p_hangman01", token = "k".repeat(20), today = R.todayKey(), future = R.dayKey(R.dayNum() + 2);
  const h = { [today]: { ok: 1, t: 30000, m: 1, pts: 250, hn: 0, at: Date.now() } };
  assert.equal((await put(id, { token, data: { n: "Tester", h } })).status, 200);
  let me = (await (await fetch(BASE + "/api/players")).json()).find(p => p.id === id);
  assert.equal(me.data.h[today].pts, 250);

  // a finished day can't be raised afterwards, and days in the future are dropped
  await put(id, { token, data: { n: "Tester", h: { [today]: { ok: 1, pts: 99999 }, [future]: { ok: 1, pts: 340 } } } });
  me = (await (await fetch(BASE + "/api/players")).json()).find(p => p.id === id);
  assert.equal(me.data.h[today].pts, 250);
  assert.equal(me.data.h[future], undefined);

  // a new player claiming a huge score gets at most 340, and a miss scores 0
  const id2 = "p_hangman02";
  await put(id2, { token: "z".repeat(20), data: { n: "Cheat", h: { [today]: { ok: 1, pts: 99999 }, [R.ydayKey()]: { ok: 0, pts: 300 } } } });
  me = (await (await fetch(BASE + "/api/players")).json()).find(p => p.id === id2);
  assert.equal(me.data.h[today].pts, 340);
  assert.equal(me.data.h[R.ydayKey()].pts, 0);

  // a started (not finished) day is saved as sent
  const id3 = "p_hangman03";
  await put(id3, { token: "y".repeat(20), data: { n: "Starter", h: { [today]: { s: 1 } } } });
  me = (await (await fetch(BASE + "/api/players")).json()).find(p => p.id === id3);
  assert.deepEqual(me.data.h[today], { s: 1 });
});

test("CF-Connecting-IP is only trusted with the proxy secret", async () => {
  const spoof = await (await fetch(BASE + "/api/whoami", { headers: { "cf-connecting-ip": "6.6.6.6" } })).json();
  assert.notEqual(spoof.ip, "6.6.6.6");
  const real = await (await fetch(BASE + "/api/whoami", { headers: { "cf-connecting-ip": "6.6.6.6", "x-proxy-secret": "s3cret" } })).json();
  assert.equal(real.ip, "6.6.6.6");
});

test("admin: right key works, wrong keys from many addresses lock the admin API", async () => {
  const get = (key, ip) => fetch(BASE + "/api/admin/overview", { headers: { "x-admin-key": key, "cf-connecting-ip": ip, "x-proxy-secret": "s3cret" } });
  assert.equal((await get("right-key-123", "1.1.1.1")).status, 200);
  for (let i = 0; i < 10; i++) assert.equal((await get("wrong", "10.0.0." + i)).status, 403);
  assert.equal((await get("wrong", "10.0.1.1")).status, 429);
  assert.equal((await get("right-key-123", "1.1.1.1")).status, 429);
  // the Harf admin API shares the lock
  assert.equal((await fetch(BASE + "/api/harf/admin/verdicts", { headers: { "x-admin-key": "right-key-123" } })).status, 429);
});
