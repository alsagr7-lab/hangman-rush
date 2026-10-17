// Checks the Harf Rush word lists (content/harf/ar.json and en.json): every word must be usable (at least two
// letters once "ال"/"the" is set aside), and repeats within a category are reported. Then it shows how many words
// each daily letter has per category, so thin spots are easy to find.
//
//   node scripts/check-harf.js
const fs = require("fs");
const path = require("path");
const R = require("../site/shared/rules");
const H = R.HARF;
let problems = 0;
for (const lg of ["ar", "en"]) {
  const list = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "content", "harf", lg + ".json"), "utf8"));
  console.log(`\n== ${lg} ==`);
  const table = {};
  for (const cat of H.CATS) {
    const seen = new Map();
    for (const w of list[cat] || []) {
      const k = R.harfKey(w, lg);
      if (k.length < 2) { console.log(`  unusable (${cat}): ${w}`); problems++; continue; }
      if (seen.has(k)) console.log(`  repeat (${cat}): ${w} = ${seen.get(k)}`);
      seen.set(k, w);
      table[k[0]] = table[k[0]] || {};
      table[k[0]][cat] = (table[k[0]][cat] || 0) + 1;
    }
    console.log(`  ${cat}: ${seen.size} words`);
  }
  for (const L of H.LETTERS[lg]) {
    const k = R.harfNorm(L, lg)[0], row = H.CATS.map(c => (table[k] && table[k][c]) || 0);
    const thin = row.some(n => n < 2);
    console.log(`  ${L}  ${row.map(n => String(n).padStart(3)).join(" ")}${thin ? "   <- thin" : ""}`);
  }
}
if (problems) { console.log(`\n${problems} problem(s)`); process.exit(1); }
