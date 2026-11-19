// Room updates: a page that joins with d: 1 gets just the peer that changed; an older page (no d) still gets the
// whole list every time; joins and leaves always send the whole list.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const WebSocket = require("ws");
const { startServer } = require("./helper");

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv.stop(); });

function client() {
  const ws = new WebSocket(srv.base.replace(/^http/, "ws") + "/ws"), got = [];
  ws.on("message", d => { try { const m = JSON.parse(d); if (m.t === "peer" || m.t === "peers") got.push(m); } catch {} });
  return new Promise(r => ws.once("open", () => r({ ws, got, send: o => ws.send(JSON.stringify(o)) })));
}
const settle = () => new Promise(r => setTimeout(r, 150));

test("one changed peer goes alone to new pages and as the whole list to old ones", async () => {
  const a = await client(), b = await client(), old = await client();
  a.send({ t: "join", room: "pt-delt", presence: { n: "A" }, d: 1 }); await settle();
  b.send({ t: "join", room: "pt-delt", presence: { n: "B" }, d: 1 }); await settle();
  old.send({ t: "join", room: "pt-delt", presence: { n: "Old" } }); await settle();
  for (const c of [a, b, old]) assert.strictEqual(c.got.at(-1).t, "peers"); // joins: the whole list
  assert.strictEqual(a.got.at(-1).peers.length, 3);
  a.got.length = b.got.length = old.got.length = 0;

  b.send({ t: "presence", room: "pt-delt", patch: { x: 0.5 } }); await settle();
  assert.deepStrictEqual(a.got.map(m => m.t), ["peer"]);
  assert.deepStrictEqual(a.got[0].presence, { n: "B", x: 0.5 });
  assert.strictEqual(typeof a.got[0].peer, "string");
  assert.deepStrictEqual(b.got.map(m => m.t), ["peer"]);
  assert.deepStrictEqual(old.got.map(m => m.t), ["peers"]);
  assert.strictEqual(old.got[0].peers.find(p => p.presence.n === "B").presence.x, 0.5);

  a.got.length = 0;
  old.ws.close(); await settle();
  assert.deepStrictEqual(a.got.map(m => m.t), ["peers"]); // a leave: the whole list
  assert.strictEqual(a.got[0].peers.length, 2);
  a.ws.close(); b.ws.close();
});
