// Party content: every trivia topic has questions in the room bank, every party picture question has its image, and
// the built party page carries the Hangman room words (party Hangman and the trivia letter scrambles use them).
// Run: npm test
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const R = require("../site/shared/rules");

const ROOT = path.join(__dirname, "..");

test("the trivia bank builds and covers every topic", () => {
  execFileSync(process.execPath, [path.join(ROOT, "scripts", "build-trivia.js")], { stdio: "pipe" });
  const bank = JSON.parse(fs.readFileSync(path.join(ROOT, "site", "trivia", "questions.json"), "utf8")).q;
  for (const cat of R.TRIVIA.CATS) {
    const n = bank.filter(q => q[1] === cat).length;
    assert.ok(n >= 20, `${cat} has ${n} questions`);
  }
});

test("every party picture question has an image and a known topic", () => {
  const pics = JSON.parse(fs.readFileSync(path.join(ROOT, "site", "party", "pictures.json"), "utf8")).q;
  assert.ok(pics.length >= 100, "picture questions: " + pics.length);
  for (const p of pics) {
    assert.ok(R.TRIVIA.CATS.includes(p[1]), p[0] + " topic " + p[1]);
    assert.ok(fs.existsSync(path.join(ROOT, "site", "party", "img", p[7] + ".svg")), p[0] + " image " + p[7]);
    assert.equal(p[5].length, 4); assert.equal(p[6].length, 4);
  }
  for (const d of ["flag", "emoji"]) assert.ok(fs.existsSync(path.join(ROOT, "site", "party", "img", d, "LICENSE.txt")), d + " licence kept");
});

test("the built party page has the Hangman room words", () => {
  const { build } = require("../scripts/build-site");
  const pages = build({});
  const html = pages.get("party/index.html");
  assert.ok(!/data-hm-words/.test(html), "placeholder replaced");
  const m = html.match(/window\.HM_WORDS=(\{[\s\S]*?\});<\/script>/) || html.match(/window\.HM_WORDS=([\s\S]*?);\n?<\/script>/);
  assert.ok(m, "HM_WORDS written");
  const W = new Function("return " + m[1])();
  for (const lg of ["en", "ar"]) {
    const cats = Object.keys(W[lg]);
    assert.ok(cats.length >= 8, lg + " categories: " + cats.length);
    assert.ok(cats.every(c => W[lg][c].length >= 4), lg + " every category has words");
  }
});

test("Bluff Rush: the facts build, and the decoys never count as the truth", () => {
  execFileSync(process.execPath, [path.join(ROOT, "scripts", "build-trivia.js")], { stdio: "pipe" });
  const facts = JSON.parse(fs.readFileSync(path.join(ROOT, "site", "party", "bluff.json"), "utf8")).q;
  assert.ok(facts.length >= 120, "facts: " + facts.length);
  assert.ok(facts.filter(f => f[3]).length >= 120, "Arabic facts: " + facts.filter(f => f[3]).length);
  for (const [id, cat, qen, qar, aen, aar, alen, alar, den, dar] of facts) {
    assert.ok(R.BLUFF.CATS.includes(cat), id + " topic");
    assert.ok(qen.includes("____"), id + " blank");
    for (const d of den) assert.ok(!R.bluffIsTrue(d, aen, alen), id + " decoy " + d);
    if (qar) for (const d of dar) assert.ok(!R.bluffIsTrue(d, aar, alar), id + " decoy " + d);
  }
});

test("Bluff Rush: a fake that is the truth is caught, other fakes are not", () => {
  const yes = [["Cubes", "cubes", []], ["the cube", "cubes", ["cube"]], ["المكعبات", "مكعبات", []], ["١٠٠٠٠٠", "100,000", ["100000"]],
    ["flamboyence", "flamboyance", []], ["مرتان", "مرتين", []], ["Lamborghini", "supercars", ["lamborghini"]], ["silk", "silk", []], ["safar", "safar (travel)", []]];
  for (const [f, a, al] of yes) assert.ok(R.bluffIsTrue(f, a, al), f + " should match " + a);
  const no = [["ten years", "two years", []], ["hats", "cats", []], ["98%", "99.8%", []], ["peacock", "peach", []], ["", "x", []]];
  for (const [f, a, al] of no) assert.ok(!R.bluffIsTrue(f, a, al), f + " should not match " + a);
});

test("Imposter Rush: every category has enough words in both languages, and clues are one or two clean words", () => {
  execFileSync(process.execPath, [path.join(ROOT, "scripts", "build-trivia.js")], { stdio: "pipe" });
  const cats = JSON.parse(fs.readFileSync(path.join(ROOT, "site", "party", "imposter.json"), "utf8")).c;
  assert.ok(cats.length >= 15, "categories: " + cats.length);
  for (const c of cats) { assert.ok(c.w.length >= R.IMPOSTER.GUESS_OPTS, c.k); for (const w of c.w) assert.ok(w[0] && /[؀-ۿ]/.test(w[1]), c.k + " " + w[0]); }
  assert.strictEqual(R.imposterClue("round"), "round");
  assert.strictEqual(R.imposterClue("  ice cream "), "ice cream");
  assert.strictEqual(R.imposterClue("a very long clue"), "");
  assert.strictEqual(R.imposterClue("idiot"), "");
});
