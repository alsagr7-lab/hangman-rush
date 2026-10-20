// Starts the real server on a temporary JSON file and checks the pages, the main APIs and the abuse limits.
// Run: npm test
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const R = require("../site/shared/rules");
const { startServer } = require("./helper");

let srv, BASE;
const log = () => srv.log();
before(async () => {
  // an unreachable database: the server should retry, then fall back to the file
  srv = await startServer({ env: { ADMIN_KEY: "right-key-123", PROXY_SECRET: "s3cret", DATABASE_URL: "postgres://x:y@127.0.0.1:1/none", PG_RETRY_MS: "50,50" } });
  BASE = srv.base;
});
after(() => srv.stop());

test("on Render, a database that stays down stops the server instead of falling back to the file", async () => {
  const { spawn } = require("node:child_process"), path = require("node:path");
  const proc = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, PORT: "0", RENDER: "true", DATABASE_URL: "postgres://x:y@127.0.0.1:1/none", PG_RETRY_MS: "20" } });
  let out = ""; proc.stdout.on("data", d => (out += d)); proc.stderr.on("data", d => (out += d));
  const code = await new Promise(r => { const t = setTimeout(() => { proc.kill(); r("still running"); }, 15000); proc.once("exit", c => { clearTimeout(t); r(c); }); });
  assert.notEqual(code, 0); assert.notEqual(code, "still running");
  assert.match(out, /fallback is off in production/);
});

test("retries Postgres before falling back to the file", () => {
  assert.match(log(), /trying again in 0.05s/);
  assert.match(log(), /using the JSON file instead/);
});

test("pages load", async () => {
  for (const p of ["/", "/hangman/", "/trivia/", "/harf/", "/admin"]) {
    const r = await fetch(BASE + p);
    assert.equal(r.status, 200, p);
    assert.match(await r.text(), /<html/i, p);
  }
});

test("game APIs answer", async () => {
  for (const p of ["/api/board?game=hangman", "/api/board?game=trivia", "/api/board?game=harf", "/api/board/hub", "/api/trivia/info", "/api/harf/info"])
    assert.equal((await fetch(BASE + p)).status, 200, p);
  // the old download-everyone lists are gone (the boards come from /api/board)
  for (const p of ["/api/players", "/api/trivia/players", "/api/harf/players"])
    assert.equal((await fetch(BASE + p)).status, 404, p);
  const tok = "t".repeat(20);
  for (const p of ["/api/trivia/daily/state", "/api/harf/daily/state"]) {
    const r = await fetch(BASE + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ uid: "p_testapi01", token: tok, lg: "en" }) });
    assert.equal(r.status, 200, p);
  }
});

test("the old Hangman page save is gone, so a page can't write results or counts", async () => {
  const id = "p_hangman01", today = R.todayKey();
  const forged = { n: "Tester", played: 9, wins: 9, streak: 9, ls: today, h: { [today]: { ok: 1, t: 1000, m: 0, pts: 340 } } };
  const r = await fetch(`${BASE}/api/players/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: "k".repeat(20), data: forged }) });
  assert.equal(r.status, 404);
  assert.equal((await (await fetch(BASE + "/api/me?uid=" + id)).json()).hm, null);
});

test("unnamed \"Player\" entries are left off every board", () => {
  assert.ok(R.namedRec({ n: "Sara" })); assert.ok(!R.namedRec({ n: " player " })); assert.ok(!R.namedRec({}));
});

test("a missing page gets the 404 page; a missing file a plain 404", async () => {
  let r = await fetch(BASE + "/no-such-game/");
  assert.equal(r.status, 404); assert.match(await r.text(), /This page doesn't exist/);
  r = await fetch(BASE + "/nothing.png");
  assert.equal(r.status, 404); assert.doesNotMatch(await r.text(), /<html/i);
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
