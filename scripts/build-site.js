// Builds the pages as single files: each page gets the shared stylesheet and scripts written into it, so a page that
// loads at all loads complete (some phones and networks were dropping the separate /shared/ files).
//
//   API_URL=https://api.rushgames.cc node scripts/build-site.js   -> writes dist/ (used by the Render static site)
//
// The game server uses build() directly at start-up and serves the result from memory.
const fs = require("fs");
const path = require("path");

const SITE = path.join(__dirname, "..", "site");
const PAGES = ["index.html", "hangman/index.html", "trivia/index.html", "harf/index.html"];

// text that is safe inside an inline <script> or <style> element
const safe = s => s.replace(/<\/(script|style)/gi, "<\\/$1");

// the public address used in shared links and for moving players off old addresses
const HOME = (process.env.PUBLIC_URL || "https://rushgames.cc").replace(/\/+$/, "");

// Rush+ subscriptions: the entry points are built into every page but stay hidden until SUBSCRIPTIONS=on
const SUBSCRIPTIONS = process.env.SUBSCRIPTIONS === "on";

// the logo files, written into the inlined stylesheet so the logo never depends on a second download
const svgUri = svg => "data:image/svg+xml," + svg.replace(/"/g, "'").replace(/[\r\n]+/g, " ").replace(/[%#<>]/g, c => encodeURIComponent(c));

function build({ api = "", site = "", home = HOME, subscriptions = SUBSCRIPTIONS } = {}) {
  const read = p => fs.readFileSync(path.join(SITE, p), "utf8");
  const config = `window.RUSH_CONFIG=${JSON.stringify({ api, site, home, subscriptions })};`;
  const out = new Map();
  for (const page of PAGES) {
    let html = read(page);
    html = html.replace(/<script src="\/shared\/config\.js"><\/script>/, () => `<script>${config}</script>`);
    html = html.replace(/<script src="\/shared\/([\w-]+\.js)"><\/script>/g, (_, f) => `<script>/* shared/${f} */\n${safe(read("shared/" + f))}</script>`);
    html = html.replace(/<link rel="stylesheet" href="\/shared\/([\w-]+\.css)">/g, (_, f) => `<style>/* shared/${f} */\n${safe(read("shared/" + f))}</style>`);
    html = html.replace(/url\("\/shared\/(logo-[\w-]+\.svg)"\)/g, (_, f) => `url("${svgUri(read("shared/" + f))}")`);
    if (/(src|href)="\/shared\//.test(html)) throw new Error(page + " still links a /shared/ file");
    out.set(page, html);
  }
  return out;
}

module.exports = { build, PAGES, HOME };

if (require.main === module) {
  const dist = path.join(__dirname, "..", "dist");
  fs.rmSync(dist, { recursive: true, force: true });
  fs.cpSync(SITE, dist, { recursive: true }); // questions.json, the shared files (kept for old cached pages), etc.
  const pages = build({ api: (process.env.API_URL || "").replace(/\/+$/, ""), site: "" });
  for (const [p, html] of pages) fs.writeFileSync(path.join(dist, p), html);
  fs.writeFileSync(path.join(dist, "shared", "config.js"), `window.RUSH_CONFIG=${JSON.stringify({ api: (process.env.API_URL || "").replace(/\/+$/, ""), site: "", home: HOME, subscriptions: SUBSCRIPTIONS })};\n`);
  console.log(`built ${pages.size} pages into dist/ (api: ${process.env.API_URL || "same origin"})`);
}
