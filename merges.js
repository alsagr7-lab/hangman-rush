// Merging one player's records into another's, for every game and language:
//   - mergePlayers(into, from, rule): moves days from `from` into `into` where `rule` says so, then counts streaks,
//     bests, wins and played again from the merged days. Used when a device with guest progress switches to a
//     Google account (auth.js), and for one-time merges below.
//   - runMerges(): one-time merges, run at start-up before the server takes requests.
const store = require("./store");
const admin = require("./admin");
const R = require("./site/shared/rules");

const num = R.num;
const done = e => e && typeof e === "object" && ("ok" in e); // a finished daily (Hangman marks a started one {s:1})

/* rules: (mine, theirs) -> true when their day should replace mine (mine is never missing here) */
// the higher score wins
const BEST = (mine, theirs) => num(theirs.pts) > num(mine.pts);
// the result played first wins, so playing a day on two devices never helps. A day with no play time recorded was
// played before play times existed, so it counts as first; where neither has one, the higher score wins.
const FIRST = (mine, theirs) => {
  if (mine.at && theirs.at) return theirs.at < mine.at;
  if (!mine.at && !theirs.at) return num(theirs.pts) > num(mine.pts);
  return !theirs.at;
};

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
// days of `src` that are missing from `dst`, or that `rule` prefers -> how many days changed (only this season's)
function mergeDays(dst, src, rule) {
  let n = 0;
  dst.h = dst.h || {};
  if (src && R.seasonOfRec(src) !== R.seasonOfRec(dst)) return 0;
  for (const [k, e] of Object.entries((src && src.h) || {})) {
    if (!done(e)) continue;
    const mine = dst.h[k];
    if (!done(mine) || rule(mine, e)) { dst.h[k] = e; n++; }
  }
  if (n) recount(dst);
  return n;
}

// -> {days: how many days moved, where: ["harf_en", ...]}; `from` is then hidden from every leaderboard
async function mergePlayers(into, from, rule) {
  let days = 0;
  const where = [];
  for (const sfx of ["", "_ar"]) { // Hangman: English, Arabic
    const [a, b] = await Promise.all([store.get(into + sfx), store.get(from + sfx)]);
    if (!b) continue;
    if (!a) {
      const tok = await ownerToken(into);
      if (tok) { await store.put(into + sfx, tok, b.data); days += Object.keys(b.data.h || {}).length; where.push("hangman" + sfx); }
      continue;
    }
    const n = mergeDays(a.data, b.data, rule);
    if (n) { await store.put(into + sfx, a.token, a.data); days += n; where.push("hangman" + sfx); }
  }
  for (const sfx of ["_ar", "_en"]) { // Harf
    const [a, b] = await Promise.all([store.hGet(into + sfx), store.hGet(from + sfx)]);
    if (!b) continue;
    if (!a) {
      const tok = await ownerToken(into);
      if (tok) { const d = Object.assign({}, b.data); delete d.run; await store.hPut(into + sfx, tok, d); days += Object.keys(d.h || {}).length; where.push("harf" + sfx); }
      continue;
    }
    const n = mergeDays(a.data, b.data, rule);
    if (n) { await store.hSetData(into + sfx, a.data); days += n; where.push("harf" + sfx); }
  }
  { // Trivia
    const [a, b] = await Promise.all([store.tGet(into), store.tGet(from)]);
    if (b && !a) {
      const tok = await ownerToken(into);
      if (tok) { const d = Object.assign({}, b.data); delete d.run; await store.tPut(into, tok, d); days += Object.keys(d.h || {}).length; where.push("trivia"); }
    } else if (a && b) {
      const n = mergeDays(a.data, b.data, rule);
      if (n) { await store.tPut(into, a.token, a.data); days += n; where.push("trivia"); }
    }
  }
  for (const g of ["hangman", "trivia", "harf"]) await admin.setHidden(g, from, true);
  return { days, where };
}
// the token hash any of this player's records carries (they all share one)
async function ownerToken(uid) {
  const recs = await Promise.all([store.get(uid), store.get(uid + "_ar"), store.tGet(uid), store.hGet(uid + "_ar"), store.hGet(uid + "_en")]);
  const r = recs.find(Boolean);
  return r ? r.token : null;
}

/* ---------- one-time merges ---------- */
const MERGES = [
  // Yousef: #HBG9 and #7EV7 into his Google-linked #FK42 (requested 18 Oct 2026)
  { flag: "merge_yousef_v1", into: "p_f0da60f7ed8864a71c64", from: ["p_45b9a8fbff43fc144081", "p_85f4c4bd14631cd2f540"] },
];
async function runMerges() {
  for (const m of MERGES) {
    if (await store.metaGet(m.flag)) continue;
    const log = [];
    for (const from of m.from) log.push(...(await mergePlayers(m.into, from, BEST)).where);
    await store.metaPut(m.flag, { at: Date.now(), changed: log });
    console.log(`Merge ${m.flag}: ${log.length ? log.join(", ") : "nothing to move"}; merged-away accounts hidden`);
  }
}

module.exports = { runMerges, mergePlayers, mergeDays, BEST, FIRST };
