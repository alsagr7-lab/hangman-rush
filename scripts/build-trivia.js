// Checks the trivia question files and builds site/trivia/questions.json for rooms and practice.
//   node scripts/build-trivia.js                          check content/trivia/*.json and write the bank
//   node scripts/build-trivia.js --daily trivia-daily.json   also check a daily list (and that it shares nothing with the bank)
//
// Room/practice questions live in content/trivia/<category>.json, one file per category:
//   [id, difficulty 1-3, question en, question ar, [4 answers en], [4 answers ar]]   (the right answer goes first)
// Difficulty decides the pools: Easy rooms use 1-2, Hard rooms use 2-3, Normal uses everything.
const fs = require("fs");
const path = require("path");
const { TRIVIA } = require("../site/shared/rules");

const problems = [];
const norm = s => String(s).toLowerCase().replace(/[^a-z0-9\u0600-\u06ff]+/g, " ").trim(); // for spotting repeated questions
const same = s => String(s).toLowerCase().replace(/\s+/g, " ").trim();                          // for spotting repeated answers
function checkQuestion(where, d, qen, qar, en, ar) {
  if (![1, 2, 3].includes(d)) problems.push(`${where}: difficulty must be 1, 2 or 3`);
  for (const [lang, q, a] of [["en", qen, en], ["ar", qar, ar]]) {
    if (typeof q !== "string" || q.trim().length < 8) problems.push(`${where}: ${lang} question is missing or too short`);
    if (!Array.isArray(a) || a.length !== 4 || a.some(x => typeof x !== "string" || !x.trim())) { problems.push(`${where}: needs 4 ${lang} answers`); continue; }
    if (new Set(a.map(same)).size !== 4) problems.push(`${where}: ${lang} answers repeat`);
    if (a.some(x => x.length > 60)) problems.push(`${where}: a ${lang} answer is longer than 60 characters`);
  }
  if (typeof qar === "string" && !/[؀-ۿ]/.test(qar)) problems.push(`${where}: Arabic question has no Arabic text`);
}

const bank = [], ids = new Set(), texts = new Map();
for (const cat of TRIVIA.CATS) {
  const file = path.join(__dirname, "..", "content", "trivia", cat + ".json");
  let rows;
  try { rows = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { problems.push(`${cat}.json: ${e.message}`); continue; }
  for (const r of rows) {
    const [id, d, qen, qar, en, ar] = r;
    const where = `${cat}.json ${id}`;
    if (!/^[a-z0-9-]{3,24}$/.test(id || "")) problems.push(`${where}: bad id`);
    if (ids.has(id)) problems.push(`${where}: id used twice`);
    ids.add(id);
    checkQuestion(where, d, qen, qar, en, ar);
    const k = norm(qen); if (texts.has(k)) problems.push(`${where}: same question as ${texts.get(k)}`); texts.set(k, id);
    bank.push([id, cat, d, qen, qar, en, ar]);
  }
  const n = rows.length, easy = rows.filter(r => r[1] <= 2).length, hard = rows.filter(r => r[1] >= 2).length;
  console.log(`${cat.padEnd(10)} ${String(n).padStart(3)} questions  (easy pool ${easy}, hard pool ${hard})`);
  if (easy < TRIVIA.QUESTIONS * 2 || hard < TRIVIA.QUESTIONS * 2) problems.push(`${cat}: each difficulty pool needs at least ${TRIVIA.QUESTIONS * 2} questions`);
}

// party picture questions: content/party/pictures.json, shown with a picture on the big screen
//   [id, category, difficulty 1-3, question en, question ar, [4 answers en], [4 answers ar], image]
// image is flag/<code> or emoji/<name> (site/party/img/<image>.svg). Same id space and checks as the room bank.
const pictures = [];
{
  const file = path.join(__dirname, "..", "content", "party", "pictures.json");
  let rows = [];
  try { rows = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { problems.push(`pictures.json: ${e.message}`); }
  for (const r of rows) {
    const [id, cat, d, qen, qar, en, ar, img] = r, where = `pictures.json ${id}`;
    if (!/^[a-z0-9-]{3,24}$/.test(id || "")) problems.push(`${where}: bad id`);
    if (ids.has(id)) problems.push(`${where}: id used twice`);
    ids.add(id);
    if (!TRIVIA.CATS.includes(cat)) problems.push(`${where}: unknown category ${cat}`);
    checkQuestion(where, d, qen, qar, en, ar);
    if (!/^(flag|emoji)\/[a-z0-9-]+$/.test(img || "") || !fs.existsSync(path.join(__dirname, "..", "site", "party", "img", img + ".svg"))) problems.push(`${where}: image ${img} missing`);
    pictures.push([id, cat, d, qen, qar, en, ar, img]);
  }
  console.log(`pictures   ${String(pictures.length).padStart(3)} questions`);
}

// Bluff Rush (party): content/party/bluff.json, strange-but-true facts with a blank (____):
//   [id, topic, question en, question ar, answer en, answer ar, [other ways to write it, en], [same, ar], [2 decoys en], [2 decoys ar]]
// A row with no Arabic question is English-only (collective nouns and other English word facts). The decoys are the
// game's own lies, added when the players' fakes leave fewer than four options; they must not count as the truth.
const RR = require("../site/shared/rules");
const bluff = [];
{
  const file = path.join(__dirname, "..", "content", "party", "bluff.json"), seenQ = new Set();
  let rows = [];
  try { rows = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { problems.push(`bluff.json: ${e.message}`); }
  for (const r of rows) {
    const [id, cat, qen, qar, aen, aar, alen, alar, den, dar] = r, where = `bluff.json ${id}`;
    if (!/^bl-[a-z]{3}-\d{2}$/.test(id || "")) problems.push(`${where}: bad id`);
    if (ids.has(id)) problems.push(`${where}: id used twice`);
    ids.add(id);
    if (!RR.BLUFF.CATS.includes(cat)) problems.push(`${where}: unknown topic ${cat}`);
    const langs = [["en", qen, aen, alen, den]].concat(qar == null ? [] : [["ar", qar, aar, alar, dar]]);
    if (qar == null && (aar != null || (alar || []).length || (dar || []).length)) problems.push(`${where}: English-only rows leave the Arabic empty`);
    for (const [lg, q, a, al, de] of langs) {
      if (typeof q !== "string" || !q.includes("____")) problems.push(`${where}: ${lg} question needs a ____ blank`);
      if (lg === "ar" && !/[؀-ۿ]/.test(q)) problems.push(`${where}: Arabic question has no Arabic text`);
      if (typeof a !== "string" || !a.trim() || a.length > RR.BLUFF.MAXLEN) problems.push(`${where}: ${lg} answer missing or too long`);
      if (!Array.isArray(al) || al.some(x => typeof x !== "string")) problems.push(`${where}: ${lg} other spellings must be a list`);
      if (!Array.isArray(de) || de.length !== 2 || de.some(x => typeof x !== "string" || !x.trim() || x.length > RR.BLUFF.MAXLEN)) { problems.push(`${where}: needs 2 ${lg} decoys`); continue; }
      for (const x of de) if (RR.bluffIsTrue(x, a, al)) problems.push(`${where}: ${lg} decoy "${x}" counts as the true answer`);
      if (RR.bluffSame(de[0], de[1])) problems.push(`${where}: ${lg} decoys are the same`);
      // a question that names its own answer gives the game away
      if (RR.bluffKey(a).length >= 4 && RR.bluffKey(q).includes(RR.bluffKey(a))) problems.push(`${where}: ${lg} question contains its answer`);
    }
    const k = norm(qen); if (seenQ.has(k)) problems.push(`${where}: same question twice`); seenQ.add(k);
    bluff.push(r);
  }
  console.log(`bluff      ${String(bluff.length).padStart(3)} facts (${bluff.filter(r => r[3] != null).length} in Arabic)`);
}

// Imposter Rush (party): content/party/imposter.json, categories of secret words: [{k, en, ar, w: [[word en, word ar], ...]}]
// Every category needs enough words for the imposter's 8-word guess; no word twice in a category.
const imposter = [];
{
  const file = path.join(__dirname, "..", "content", "party", "imposter.json"), ks = new Set();
  let cats = [];
  try { cats = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { problems.push(`imposter.json: ${e.message}`); }
  for (const c of cats) {
    const where = `imposter.json ${c.k}`;
    if (!/^[a-z0-9-]{3,24}$/.test(c.k || "") || ks.has(c.k)) problems.push(`${where}: bad or repeated key`);
    ks.add(c.k);
    if (typeof c.en !== "string" || typeof c.ar !== "string" || !/[؀-ۿ]/.test(c.ar)) problems.push(`${where}: needs English and Arabic names`);
    if (!Array.isArray(c.w) || c.w.length < RR.IMPOSTER.GUESS_OPTS) { problems.push(`${where}: needs at least ${RR.IMPOSTER.GUESS_OPTS} words`); continue; }
    for (const lg of [0, 1]) {
      const seen = [];
      for (const w of c.w) {
        if (!Array.isArray(w) || typeof w[lg] !== "string" || !w[lg].trim() || w[lg].length > 30) { problems.push(`${where}: bad word ${JSON.stringify(w)}`); continue; }
        if (lg === 1 && !/[؀-ۿ]/.test(w[1])) problems.push(`${where}: ${w[0]} has no Arabic`);
        if (seen.some(x => RR.bluffSame(x, w[lg]))) problems.push(`${where}: ${w[lg]} twice`);
        seen.push(w[lg]);
      }
    }
    imposter.push({ k: c.k, en: c.en, ar: c.ar, w: c.w });
  }
  console.log(`imposter   ${String(imposter.length).padStart(3)} categories, ${imposter.reduce((a, c) => a + c.w.length, 0)} words`);
}

const di = process.argv.indexOf("--daily");
if (di > 0) {
  const file = process.argv[di + 1];
  const daily = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(daily.start || "")) problems.push("daily: start must be YYYY-MM-DD");
  const seen = new Map();
  daily.days.forEach((day, i) => {
    if (!Array.isArray(day) || day.length !== TRIVIA.QUESTIONS) problems.push(`daily day ${i + 1}: needs ${TRIVIA.QUESTIONS} questions`);
    (day || []).forEach((q, j) => {
      const [cat, d, qen, qar, en, ar] = q, where = `daily day ${i + 1} q${j + 1}`;
      if (!TRIVIA.CATS.includes(cat)) problems.push(`${where}: unknown category ${cat}`);
      checkQuestion(where, d, qen, qar, en, ar);
      const k = norm(qen);
      if (texts.has(k)) problems.push(`${where}: also in rooms (${texts.get(k)})`);
      if (seen.has(k)) problems.push(`${where}: repeats ${seen.get(k)}`);
      seen.set(k, where);
    });
  });
  const end = new Date(Date.parse(daily.start + "T00:00:00Z") + (daily.days.length - 1) * 864e5).toISOString().slice(0, 10);
  console.log(`daily      ${daily.days.length} days, ${daily.start} to ${end}`);
}

if (problems.length) { console.error("\n" + problems.join("\n")); process.exit(1); }
const out = path.join(__dirname, "..", "site", "trivia", "questions.json");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ v: 1, q: bank }));
console.log(`\nwrote ${path.relative(process.cwd(), out)}: ${bank.length} questions`);
const pout = path.join(__dirname, "..", "site", "party", "pictures.json");
fs.writeFileSync(pout, JSON.stringify({ v: 1, q: pictures }));
console.log(`wrote ${path.relative(process.cwd(), pout)}: ${pictures.length} picture questions`);
const bout = path.join(__dirname, "..", "site", "party", "bluff.json");
fs.writeFileSync(bout, JSON.stringify({ v: 1, q: bluff }));
console.log(`wrote ${path.relative(process.cwd(), bout)}: ${bluff.length} Bluff Rush facts`);
const iout = path.join(__dirname, "..", "site", "party", "imposter.json");
fs.writeFileSync(iout, JSON.stringify({ v: 1, c: imposter }));
console.log(`wrote ${path.relative(process.cwd(), iout)}: ${imposter.length} Imposter Rush categories`);
