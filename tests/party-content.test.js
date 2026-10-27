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
