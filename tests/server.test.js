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

const put = (id, body) => fetch(`${BASE}/api/players/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

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
  for (const p of ["/api/players", "/api/trivia/players", "/api/harf/players", "/api/trivia/info", "/api/harf/info"])
    assert.equal((await fetch(BASE + p)).status, 200, p);
  const tok = "t".repeat(20);
  for (const p of ["/api/trivia/daily/state", "/api/harf/daily/state"]) {
    const r = await fetch(BASE + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ uid: "p_testapi01", token: tok, lg: "en" }) });
    assert.equal(r.status, 200, p);
  }
});

test("Hangman saves from the page change only the name and colour, never results or counts", async () => {
  const id = "p_hangman01", token = "k".repeat(20), today = R.todayKey(), yday = R.ydayKey();
  const forged = { n: "Tester", c: "#d93c30", played: 9, wins: 9, streak: 9, best: 9, ls: today, sk: 5,
    h: { [today]: { ok: 1, t: 1000, m: 0, pts: 340 }, [yday]: { ok: 1, pts: 340 } } };
  assert.equal((await put(id, { token, data: forged })).status, 200);
  let me = (await (await fetch(BASE + "/api/players")).json()).find(p => p.id === id);
  assert.equal(me.data.n, "Tester"); assert.equal(me.data.c, "#d93c30");
  assert.deepEqual(me.data.h, {});
  for (const f of ["played", "wins", "streak", "best", "sk"]) assert.equal(me.data[f], 0, f);

  // renaming keeps working, and a second forged save changes nothing else
  await put(id, { token, data: { ...forged, n: "Renamed" } });
  me = (await (await fetch(BASE + "/api/players")).json()).find(p => p.id === id);
  assert.equal(me.data.n, "Renamed"); assert.deepEqual(me.data.h, {}); assert.equal(me.data.played, 0);
});

test("unnamed \"Player\" entries are left off every board", async () => {
  await put("p_noname001", { token: "n".repeat(20), data: { n: "Player" } });
  await put("p_named0001", { token: "m".repeat(20), data: { n: "Sara" } });
  const ids = (await (await fetch(BASE + "/api/players")).json()).map(p => p.id);
  assert.ok(!ids.includes("p_noname001")); assert.ok(ids.includes("p_named0001"));
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
