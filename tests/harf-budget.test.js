// The AI budget: party games have their own checking-model allowance an hour (on top of the dailies' and rooms'
// ceiling), and the stronger model has its own smaller ceiling, with rooms and parties held to a small share of it.
// Run: npm test
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

test("party checks, room checks and the stronger model are counted apart", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rush-budget-"));
  process.env.DATA_FILE = path.join(tmp, "d.json"); process.env.DATABASE_URL = "";
  const store = require("../store"); await store.init();
  const harf = require("../harf"); await harf.init();
  const { takeCall, settings } = harf._budget, S = settings();
  Object.assign(S, { perHour: 4, partyPerHour: 10, sonnetPerHour: 3, roomSonnet: 1 });
  const take = async (n, pool, strong) => { let ok = 0; for (let i = 0; i < n; i++) if (await takeCall(pool, strong)) ok++; return ok; };
  assert.equal(await take(5, "room"), 2, "rooms get half of perHour");
  assert.equal(await take(12, "party"), 10, "a party has its own allowance, not limited by the rooms' half");
  assert.equal(await take(5, "daily"), 2, "the dailies still have the rest of perHour");
  assert.equal(await take(3, "party", true), 1, "rooms and parties get only roomSonnet of the stronger model");
  assert.equal(await take(5, "daily", true), 2, "the dailies' second looks get the rest of it");
  await new Promise(r => setTimeout(r, 300)); // let the last hourly-count saves land
  fs.rmSync(tmp, { recursive: true, force: true });
});
