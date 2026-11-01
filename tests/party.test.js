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

test("a player who joins a room again replaces their older place", async () => {
  await wait(400); // the last test's connections finish closing (one address has a connection limit)
  const a = await open(), b = await open(), c = await open();
  a.ws.send(JSON.stringify({ t: "join", room: "hf-wxyz", presence: { n: "Yousef", u: "p_same" } })); await wait(60);
  c.ws.send(JSON.stringify({ t: "join", room: "hf-wxyz", presence: { n: "Mona", u: "p_other" } })); await wait(60);
  b.ws.send(JSON.stringify({ t: "join", room: "hf-wxyz", presence: { n: "Yousef", u: "p_same" } })); await wait(150);
  assert.ok(a.msgs.some(m => m.t === "error" && m.code === "replaced"));
  const last = c.msgs.filter(m => m.t === "peers").pop();
  assert.deepStrictEqual(last.peers.map(p => p.presence.n).sort(), ["Mona", "Yousef"]);
  assert.ok(!b.msgs.some(m => m.code === "replaced") && !c.msgs.some(m => m.code === "replaced"));
  [a, b, c].forEach(s => s.ws.close());
});

test("a private message reaches only the peer it's for, stamped with who sent it", async () => {
  const [tv, a, b] = [await open(), await open(), await open()];
  for (const s of [tv, a, b]) { s.ws.send(JSON.stringify({ t: "join", room: "pt-priv" })); await wait(40); }
  await wait(150);
  const peers = tv.msgs.filter(m => m.t === "peers").pop();
  const aPeer = a.msgs.filter(m => m.t === "peers").pop().me, tvPeer = peers.me;
  tv.ws.send(JSON.stringify({ t: "to", room: "pt-priv", to: aPeer, data: { k: "im", r: 1, w: ["Messi", "ميسي"] } }));
  // someone outside the room can't send into it
  const out = await open(); out.ws.send(JSON.stringify({ t: "to", room: "pt-priv", to: aPeer, data: { k: "im", r: 9 } }));
  await wait(200);
  const got = a.msgs.filter(m => m.t === "msg");
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].from, tvPeer);
  assert.deepStrictEqual(got[0].data.w, ["Messi", "ميسي"]);
  assert.ok(!b.msgs.some(m => m.t === "msg") && !JSON.stringify(b.msgs).includes("Messi"));
  [tv, a, b, out].forEach(s => s.ws.close());
});
