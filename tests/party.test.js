// Party rooms: PARTY_MAX players plus the TV; the next one is told the party is full. Other rooms keep their own limit.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const WebSocket = require("ws");
const { startServer } = require("./helper");

let srv;
before(async () => { srv = await startServer({ env: { PARTY_MAX: "3" } }); });
after(async () => { await srv.stop(); });

function open() {
  const ws = new WebSocket(srv.base.replace(/^http/, "ws") + "/ws"), msgs = [];
  ws.on("message", d => msgs.push(JSON.parse(d)));
  return new Promise((res, rej) => { ws.once("open", () => res({ ws, msgs })); ws.once("error", rej); });
}
const wait = ms => new Promise(r => setTimeout(r, ms));

test("a party holds PARTY_MAX players and its TV, then says it's full", async () => {
  const socks = [];
  for (let i = 0; i < 5; i++) socks.push(await open());
  for (const s of socks) { s.ws.send(JSON.stringify({ t: "join", room: "pt-abcd" })); await wait(40); }
  await wait(150);
  const full = socks.map(s => s.msgs.some(m => m.t === "error" && m.code === "party_full"));
  assert.deepStrictEqual(full, [false, false, false, false, true]);
  // a game room is not a party: the fifth one gets in there
  for (const s of socks) s.ws.send(JSON.stringify({ t: "join", room: "hf-abcd" }));
  await wait(200);
  assert.ok(!socks.some(s => s.msgs.some(m => m.t === "error" && m.room === "hf-abcd")));
  socks.forEach(s => s.ws.close());
});

test("a whole party fits on one home connection", async () => {
  const socks = [];
  for (let i = 0; i < 16; i++) socks.push(await open());
  await wait(150);
  assert.ok(socks.every(s => s.ws.readyState === WebSocket.OPEN));
  socks.forEach(s => s.ws.close());
});
