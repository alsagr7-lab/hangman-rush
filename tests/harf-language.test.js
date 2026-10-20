// Harf's same-language rule: animals, plants and objects must be words of the game's language ("Fahad" from فهد isn't
// an English animal, جالابينو isn't an Arabic plant); names and places may come from any language. The referee is
// told so, and verdicts saved under the old rule are cleared once so those words are judged again.
const { test, before } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");

process.env.DATABASE_URL = "";
process.env.DATA_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rush-lang-")), "data.json");
const R = require("../site/shared/rules");
const store = require("../store");
const harf = require("../harf");

const K = (lg, cat, w) => `${lg}|${cat}|${R.harfKey(w, lg)}`;
const today = R.todayKey(), yday = R.ydayKey(), se = R.curSeason();
const FAHAD = K("en", "animal", "Fahad");

test("the referee is told to accept only words of the game's language for animal, plant and object", () => {
  const items = [{ cat: "animal", letter: "F", w: "Fahad" }];
  const en = harf.prompt("en", items).system, ar = harf.prompt("ar", [{ cat: "plant", letter: "ج", w: "جالابينو" }]).system;
  assert.match(en, /Same language/); assert.match(en, /Fahad/); assert.match(en, /Names and places may come from any language/);
  assert.match(ar, /Same language/); assert.match(ar, /جالابينو/);
  assert.doesNotMatch(en + ar, /transliterated/, "no prompt invites transliterations any more");
  for (const lg of ["en", "ar"]) assert.ok(harf.LANG_RULE(lg).length > 100);
});

before(async () => {
  await store.init();
  // the earlier one-time repairs have long run on the live server
  for (const f of ["recheck_corrections_v1", "reopen_2026-10-17_v1", "reopen_2026-10-17_v2", "archive_v1"]) await store.metaPut(f, { at: 1 });
  await store.wordsPut([
    [FAHAD, { ok: 1, src: "ai" }],                                   // the old rule let it through: cleared
    [K("ar", "plant", "جالابينو"), { ok: 1, src: "ai2" }],           // cleared
    [K("en", "plant", "Nakhla"), { ok: 1, src: "appeal" }],          // cleared
    [K("en", "name", "Fahad"), { ok: 1, src: "ai" }],                // a name: stays
    [K("en", "place", "Riyadh"), { ok: 1, src: "ai" }],              // a place: stays
    [K("en", "object", "Finjan"), { ok: 0, src: "ai" }],             // already turned down: stays
    [K("en", "animal", "Falcon"), { ok: 1, src: "mod" }],            // the team decided: stays
  ]);
  const entry = (rb, w) => ({ lg: "en", L: "F", a: [{ w: "Fahad", ok: 1 }, { w, ok: 1 }, { w: "", ok: 0 }, { w: "", ok: 0 }, { w: "", ok: 0 }], c: 2, b: 20, sb: 0, rb, pts: 20 + (rb || 0), ok: 0, t: 1, at: 1 });
  await store.hPut("p_langtest01_en", "x", { n: "Lang", se, h: { [yday]: entry(5, "Fahad"), [today]: entry(null, "Fahad") } });
  await harf.ensureMigrated();
});

test("verdicts saved under the old rule are cleared once; names, places, rejections and the team's stay", async () => {
  const left = await store.wordsGet([FAHAD, K("ar", "plant", "جالابينو"), K("en", "plant", "Nakhla"), K("en", "name", "Fahad"), K("en", "place", "Riyadh"), K("en", "object", "Finjan"), K("en", "animal", "Falcon")]);
  assert.deepEqual([...left.keys()].sort(), [K("en", "name", "Fahad"), K("en", "place", "Riyadh"), K("en", "object", "Finjan"), K("en", "animal", "Falcon")].sort());
  const meta = await store.metaGet("recheck_same_language_v1");
  assert.equal(meta.cleared, 3);
});

test("today's answer with a cleared word waits for a new check; finished days and names stay as they were", async () => {
  const h = (await store.hGet("p_langtest01_en")).data.h;
  assert.equal(h[today].a[1].u, 1, "the animal Fahad will be judged again tonight");
  assert.equal(h[today].a[0].u, undefined, "the name Fahad is untouched");
  assert.equal(h[yday].a[1].u, undefined, "a finished day isn't reopened");
  assert.equal(h[yday].pts, 25);
});
