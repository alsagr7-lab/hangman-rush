// Who owns a player id, and the small helpers every game shares. A player has one id and one token across every
// game; the records they may have are
//   players/<uid>, players/<uid>_ar   (Hangman, English and Arabic)
//   trivia_players/<uid>              (Trivia)
//   harf_players/<uid>_ar, <uid>_en   (Harf)
// The device whose token matches all of the existing ones owns the id everywhere. Checking every record (not just
// the game being played) stops anyone from claiming a game slot a player hasn't used yet and locking them out.
const crypto = require("crypto");
const store = require("./store");

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const hashToken = t => crypto.createHash("sha256").update(String(t)).digest("hex");
const baseId = id => String(id || "").replace(/_(ar|en)$/, "");
// a player id as pages send it: no language ending
const isUid = uid => ID_RE.test(String(uid || "")) && !/_(ar|en)$/.test(uid);

// -> {hm, hmAr, tri, hfAr, hfEn}: the player's record in every game and language (null where there is none)
async function records(uid) {
  const b = baseId(uid);
  const [hm, hmAr, tri, hfAr, hfEn] = await Promise.all([store.get(b), store.get(b + "_ar"), store.tGet(b), store.hGet(b + "_ar"), store.hGet(b + "_en")]);
  return { hm, hmAr, tri, hfAr, hfEn };
}

// -> { ok, isNew, recs }; ok is false when any record has another token
async function owner(uid, th) {
  const recs = await records(uid), all = Object.values(recs).filter(Boolean);
  return { ok: all.every(r => r.token === th), isNew: all.length === 0, recs };
}

// One job at a time per key, in order: withLock(key, fn) runs fn after the jobs already queued for that key. Each game
// makes its own (locker()), so a game's reads and writes of a record never interleave.
function locker() {
  const locks = new Map();
  return function withLock(key, fn) {
    const prev = locks.get(key) || Promise.resolve();
    const next = prev.then(fn, fn);
    locks.set(key, next.catch(() => {}));
    next.finally(() => { if (locks.get(key) === next) locks.delete(key); }).catch(() => {});
    return next;
  };
}

module.exports = { owner, records, hashToken, baseId, isUid, locker, ID_RE };
