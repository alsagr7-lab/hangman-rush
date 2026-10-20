// A merge into an account (a device switching to its Google account) and a daily answer on that account at the same
// moment: the merge waits for the game's lock, so neither change is lost.
const { test, before } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");

process.env.DATABASE_URL = "";
process.env.DATA_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rush-merge-")), "data.json");
const R = require("../site/shared/rules");
const store = require("../store");
const harf = require("../harf");
const { mergePlayers, FIRST } = require("../merges");

const se = R.curSeason(), today = R.todayKey(), yday = R.ydayKey();
before(async () => {
  await store.init();
  await store.hPut("p_account01_en", "acct", { n: "Acct", se, h: {} });
  await store.hPut("p_device001_en", "dev", { n: "Dev", se, h: { [yday]: { lg: "en", ok: 1, pts: 70, at: 1000, a: [] } } });
});

test("a merge doesn't overwrite a daily answer written under the game's lock at the same moment", async () => {
  // the daily: reads the record, takes a while (the referee), then writes today's result
  const daily = harf.withLock("p_account01_en", async () => {
    const r = await store.hGet("p_account01_en");
    await new Promise(res => setTimeout(res, 100));
    r.data.h[today] = { lg: "en", ok: 1, pts: 55, at: Date.now(), a: [] };
    await store.hSetData("p_account01_en", r.data);
  });
  const merge = mergePlayers("p_account01", "p_device001", FIRST);
  await Promise.all([daily, merge]);
  const h = (await store.hGet("p_account01_en")).data.h;
  assert.equal(h[today] && h[today].pts, 55, "today's answer survived the merge");
  assert.equal(h[yday] && h[yday].pts, 70, "the device's day was merged in");
});
