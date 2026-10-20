// Moving servers (move.js): read-only refuses writes but keeps reads, the owner can switch it without a restart, and
// redirect-only starts with no database, keeps serving pages and forwards the API to the new server.
const { test } = require("node:test");
const assert = require("node:assert");
const { startServer } = require("./helper");

const post = (base, p, body, h = {}) => fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json", ...h }, body: JSON.stringify(body) });

test("read-only: writes get the moving message, reads and pages still work", async () => {
  const srv = await startServer({ env: { MOVE_MODE: "readonly" } });
  try {
    const w = await post(srv.base, "/api/profile", { uid: "p_test12345", token: "a".repeat(48), nick: "Tester" });
    assert.equal(w.status, 503);
    const j = await w.json();
    assert.equal(j.moving, true);
    assert.match(j.error, /moving/i);
    assert.equal((await fetch(srv.base + "/api/board?game=trivia&lg=&tab=today")).status, 200);
    assert.equal((await fetch(srv.base + "/")).status, 200);
    assert.equal((await fetch(srv.base + "/healthz")).status, 200);
    assert.deepEqual(await (await fetch(srv.base + "/api/move")).json(), { mode: "readonly" });
  } finally { await srv.stop(); }
});

test("the owner switches read-only on and off without a restart; nobody else can", async () => {
  const srv = await startServer({ env: { ADMIN_KEY: "owner-key-123" } });
  try {
    assert.equal((await post(srv.base, "/api/move", { mode: "readonly" })).status, 403);
    assert.equal((await post(srv.base, "/api/move", { mode: "readonly" }, { "x-admin-key": "wrong" })).status, 403);
    const on = await post(srv.base, "/api/move", { mode: "readonly" }, { "x-admin-key": "owner-key-123" });
    assert.deepEqual(await on.json(), { mode: "readonly" });
    assert.equal((await post(srv.base, "/api/hangman/daily/start", { uid: "p_test12345", token: "a".repeat(48), lg: "en" })).status, 503);
    const redirect = await post(srv.base, "/api/move", { mode: "redirect" }, { "x-admin-key": "owner-key-123" });
    assert.equal(redirect.status, 400);
    const off = await post(srv.base, "/api/move", { mode: "" }, { "x-admin-key": "owner-key-123" });
    assert.deepEqual(await off.json(), { mode: "normal" });
    assert.notEqual((await post(srv.base, "/api/hangman/daily/start", { uid: "p_test12345", token: "a".repeat(48), lg: "en" })).status, 503);
  } finally { await srv.stop(); }
});

test("redirect-only: no database needed, pages served, API forwarded with a 308", async () => {
  // a database that doesn't exist: redirect-only must not even try it
  const srv = await startServer({ env: { MOVE_MODE: "redirect", MOVE_TO: "https://new.example.com/", DATABASE_URL: "postgres://x:y@127.0.0.1:1/none", RENDER: "true" } });
  try {
    assert.equal((await fetch(srv.base + "/healthz")).status, 200);
    assert.equal((await fetch(srv.base + "/hangman/")).status, 200);
    const r = await fetch(srv.base + "/api/board?game=harf&tab=today", { redirect: "manual" });
    assert.equal(r.status, 308);
    assert.equal(r.headers.get("location"), "https://new.example.com/api/board?game=harf&tab=today");
    const w = await fetch(srv.base + "/api/profile", { method: "POST", body: "{}", redirect: "manual" });
    assert.equal(w.status, 308);
    assert.equal((await fetch(srv.base + "/admin", { redirect: "manual" })).status, 308);
  } finally { await srv.stop(); }
});

test("redirect-only never forwards to itself", async () => {
  const http = require("node:http");
  const srv = await startServer({ env: { MOVE_MODE: "redirect", MOVE_TO: "https://api.rushgames.cc" } });
  try {
    // a request that arrives under the very address it would be sent to would loop
    const port = new URL(srv.base).port;
    const status = await new Promise((ok, no) => http.get({ host: "127.0.0.1", port, path: "/api/board", headers: { Host: "api.rushgames.cc" } }, r => { r.resume(); ok(r.statusCode); }).on("error", no));
    assert.equal(status, 503);
  } finally { await srv.stop(); }
});
