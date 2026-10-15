// Builds the pages as single files: each page gets the shared stylesheet and scripts written into it, so a page that
// loads at all loads complete (some phones and networks were dropping the separate /shared/ files).
//
//   API_URL=https://hangman-rush.onrender.com node scripts/build-site.js   -> writes dist/ (used by the Render static site)
//
// The game server uses build() directly at start-up and serves the result from memory.
const fs = require("fs");
const path = require("path");

const SITE = path.join(__dirname, "..", "site");
const PAGES = ["index.html", "hangman/index.html", "trivia/index.html"];

// text that is safe inside an inline <script> or <style> element
const safe = s => s.replace(/<\/(script|style)/gi, "<\\/$1");

function build({ api = "", site = "" } = {}) {
  const read = p => fs.readFileSync(path.join(SITE, p), "utf8");
  const config = `window.RUSH_CONFIG=${JSON.stringify({ api, site })};`;
  const out = new Map();
  for (const page of PAGES) {
    let html = read(page);
    html = html.replace(/<script src="\/shared\/config\.js"><\/script>/, () => `<script>${config}</script>`);
    html = html.replace(/<script src="\/shared\/([\w-]+\.js)"><\/script>/g, (_, f) => `<script>/* shared/${f} */\n${safe(read("shared/" + f))}</script>`);
    html = html.replace(/<link rel="stylesheet" href="\/shared\/([\w-]+\.css)">/g, (_, f) => `<style>/* shared/${f} */\n${safe(read("shared/" + f))}</style>`);
    if (/(src|href)="\/shared\//.test(html)) throw new Error(page + " still links a /shared/ file");
    out.set(page, html);
  }
  return out;
}

module.exports = { build, PAGES };

if (require.main === module) {
  const dist = path.join(__dirname, "..", "dist");
  fs.rmSync(dist, { recursive: true, force: true });
  fs.cpSync(SITE, dist, { recursive: true }); // questions.json, the shared files (kept for old cached pages), etc.
  const pages = build({ api: (process.env.API_URL || "").replace(/\/+$/, ""), site: "" });
  for (const [p, html] of pages) fs.writeFileSync(path.join(dist, p), html);
  fs.writeFileSync(path.join(dist, "shared", "config.js"), `window.RUSH_CONFIG=${JSON.stringify({ api: (process.env.API_URL || "").replace(/\/+$/, ""), site: "" })};\n`);
  console.log(`built ${pages.size} pages into dist/ (api: ${process.env.API_URL || "same origin"})`);
}
