// Trivia topic picks: party rounds (/api/trivia/topic) are counted, and /api/trivia/topics lists the most picked
// (at least 2 picks), most first. Run: npm test
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { startServer } = require("./helper");

let srv, BASE;
before(async () => { srv = await startServer({}); BASE = srv.base; });
after(() => srv.stop());

const pickTopic = k => fetch(BASE + "/api/trivia/topic", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ k }) }).then(r => r.status);

test("party topic picks are counted and the most picked come first", async () => {
  assert.equal(await pickTopic("nope"), 400, "unknown topic refused");
  for (const k of ["mix", "mix", "mix", "flags", "flags", "riddles"]) assert.equal(await pickTopic(k), 200);
  const r = await fetch(BASE + "/api/trivia/topics").then(x => x.json());
  assert.deepEqual(r.top.map(x => x.k), ["mix", "flags"], "riddles has only one pick: " + JSON.stringify(r.top));
  assert.equal(r.top[0].n, 3);
});

test("party topic picks are rate limited per address", async () => {
  let limited = false;
  for (let i = 0; i < 12; i++) if (await pickTopic("brands") === 429) limited = true;
  assert.ok(limited);
});
