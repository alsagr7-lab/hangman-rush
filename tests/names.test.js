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

test("more insults: pronoun endings, Arabizi, look-alike letters and hidden characters", () => {
  for (const n of ["كسك", "زبه", "طيزها", "کلب", "ك​س امك", "kosomak", "sharmoota", "ya kalb", "f4ck", "idiot", "انقلع", "يا خنزير", "ابن الحرام"])
    assert.ok(R.badName(n), n);
  for (const n of ["زبده", "كسره", "Kosta", "Zebra", "Fakhri", "Ata", "Hoeness"]) assert.ok(!R.badName(n), n);
});

test("party chat: spam never shows, ordinary lines and the quick phrases do", () => {
  for (const m of ["asdfghjk", "qwrtzxcvbn", "سشيبلاتنمكطظزرؤ", "visit www.x.com", "0551234567", "heyمرحبا", "!!!!", "يا كلب"]) assert.equal(R.cleanChat(m), "", m);
  for (const m of ["هلا!", "جاهز", "يلا!", "كفو", "Hi!", "Ready", "Let's go!", "GG", "حلوة الجولة", "2 more rounds", "😂😂"]) assert.equal(R.cleanChat(m), m, m);
  assert.equal(R.cleanChat("ههههههههه"), "ههه");
  assert.ok(R.junkText("asdfghjkl")); assert.ok(!R.junkText("Sara"));
});
