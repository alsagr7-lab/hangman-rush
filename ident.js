// Who owns a player id. A player has one id and one token across every game; the records they may have are
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

// -> { ok, isNew, recs: {hm, hmAr, tri, hfAr, hfEn} }; ok is false when any record has another token
async function owner(uid, th) {
  const b = baseId(uid);
  const [hm, hmAr, tri, hfAr, hfEn] = await Promise.all([store.get(b), store.get(b + "_ar"), store.tGet(b), store.hGet(b + "_ar"), store.hGet(b + "_en")]);
  const recs = { hm, hmAr, tri, hfAr, hfEn }, all = Object.values(recs).filter(Boolean);
  return { ok: all.every(r => r.token === th), isNew: all.length === 0, recs };
}

module.exports = { owner, hashToken, baseId, ID_RE };
