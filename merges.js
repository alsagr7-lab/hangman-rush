// One-time merges of a player's extra accounts into their main one, run at start-up before the server takes
// requests. For every game and language, each day keeps the higher-scoring result of the two accounts; streaks, bests,
// wins and played are then counted again from the merged days. The merged-away account is hidden from that game's
// leaderboards (its records stay, so the merge can be undone by hand).
const store = require("./store");
const admin = require("./admin");
const R = require("./site/shared/rules");

const MERGES = [
  // Yousef: #HBG9 and #7EV7 into his Google-linked #FK42 (requested 18 Oct 2026)
  { flag: "merge_yousef_v1", into: "p_f0da60f7ed8864a71c64", from: ["p_45b9a8fbff43fc144081", "p_85f4c4bd14631cd2f540"] },
];

const num = R.num;
const done = e => e && typeof e === "object" && ("ok" in e); // a finished daily (Hangman marks a started one {s:1})
// streak, best, wins, played and last solved day, from the days themselves
function recount(d) {
  let prev = null, streak = 0, best = 0, wins = 0, played = 0, ls = "";
  for (const k of Object.keys(d.h).sort()) {
    const e = d.h[k]; if (!done(e)) continue;
    played++;
    const dn = Math.round(Date.parse(k + "T00:00:00Z") / R.DAY);
    if (e.ok) { wins++; streak = prev === dn - 1 && streak ? streak + 1 : 1; ls = k; best = Math.max(best, streak); } else streak = 0;
    prev = dn;
  }
  Object.assign(d, { streak, best, wins, played, ls });
}
// days of `src` that beat (or are missing from) `dst` move over -> how many days changed
function mergeDays(dst, src) {
  let n = 0;
  dst.h = dst.h || {};
  for (const [k, e] of Object.entries((src && src.h) || {})) {
    if (!done(e)) continue;
    const mine = dst.h[k];
    if (!done(mine) || num(e.pts) > num(mine.pts)) { dst.h[k] = e; n++; }
  }
  if (n) recount(dst);
  return n;
}

async function runMerges() {
  for (const m of MERGES) {
    if (await store.metaGet(m.flag)) continue;
    const log = [];
    for (const from of m.from) {
      // Hangman (English, Arabic), Harf (Arabic, English), Trivia
      for (const sfx of ["", "_ar"]) {
        const [a, b] = await Promise.all([store.get(m.into + sfx), store.get(from + sfx)]);
        if (a && b && mergeDays(a.data, b.data)) { await store.put(m.into + sfx, a.token, a.data); log.push(`hangman${sfx}`); }
      }
      for (const sfx of ["_ar", "_en"]) {
        const [a, b] = await Promise.all([store.hGet(m.into + sfx), store.hGet(from + sfx)]);
        if (!b) continue;
        if (!a) { log.push(`harf${sfx}: no main record, skipped`); continue; }
        if (mergeDays(a.data, b.data)) { await store.hSetData(m.into + sfx, a.data); log.push(`harf${sfx}`); }
      }
      const [ta, tb] = await Promise.all([store.tGet(m.into), store.tGet(from)]);
      if (ta && tb && mergeDays(ta.data, tb.data)) { await store.tPut(m.into, ta.token, ta.data); log.push("trivia"); }
      for (const g of ["hangman", "trivia", "harf"]) await admin.setHidden(g, from, true);
    }
    await store.metaPut(m.flag, { at: Date.now(), changed: log });
    console.log(`Merge ${m.flag}: ${log.length ? log.join(", ") : "nothing to move"}; merged-away accounts hidden`);
  }
}

module.exports = { runMerges, mergeDays };
