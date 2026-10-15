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
