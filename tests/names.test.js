// The name filter (rules.js badName / nm16): insults in English and Arabic become "Player"; ordinary names that only
// contain the letters of one (Dickson, Essex, كسرى, السكسكي) are left alone.
const test = require("node:test");
const assert = require("node:assert");
const R = require("../site/shared/rules");

test("insults and slurs are caught, including disguised ones", () => {
  for (const n of ["fuck you", "fuuuuck", "sh!t", "Asshole99", "d i c k", "ass", "Sexy Boy", "nigga", "شرموطة", "قحبة", "كس امك", "يا كلب", "ابن الكلب", "ٱلزب", "حمار", "نيك"])
    assert.ok(R.badName(n), n);
});

test("ordinary names pass", () => {
  for (const n of ["Yousef", "يوسف", "Dickson", "Essex", "Sussex", "Grape", "Nigeria", "Niger", "Cockburn", "Hancock", "Massimo", "Classic", "Assad", "كسرى", "فهد", "عبدالله", "السكسكي", "الكلباني", "نيكول", "حيوانات"])
    assert.ok(!R.badName(n), n);
});

test("a turned-down name shows as Player", () => {
  assert.equal(R.nm16("fuck"), "Player");
  assert.equal(R.nm16("Yousef"), "Yousef");
  assert.equal(R.nm16("admin"), "Player");
});
