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

// Arabic copies of the pages under /ar/. Link previews (WhatsApp, X) read a page's tags without running it, so an
// Arabic link needs its own page to show the Arabic name, description and preview image. The page itself is the
// same; it just opens in Arabic.
const AR = {
  "index.html": { title: "ألعاب رش", desc: "ثلاث ألعاب يومية مجانية: المشنقة والمعلومات وحيوان جماد إنسان، بالعربي والإنجليزي. العب تحديات اليوم وسابق أصحابك." },
  "hangman/index.html": { title: "سباق المشنقة", desc: "نفس الكلمة في نفس اللحظة. خمّن كلمة اليوم بأسرع وقت وبأقل أخطاء، بالعربي أو الإنجليزي." },
  "trivia/index.html": { title: "سباق المعلومات", desc: "خمسة أسئلة، خمس عشرة ثانية لكل سؤال، بالعربي أو الإنجليزي. جاوب بسرعة وصح لتتصدر لوحة اليوم." },
  "harf/index.html": { title: "سباق الحروف", desc: "حيوان جماد إنسان: حرف واحد وخمس خانات قبل ما ينتهي الوقت. لعبة كلمات يومية بالعربي والإنجليزي." },
};
const attr = s => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
const pagePath = page => "/" + page.replace(/index\.html$/, "");

// links each language's page to the other, so search engines and previews know they're the same page
function alternates(html, page, home) {
  const p = pagePath(page);
  const links = `<link rel="alternate" hreflang="en" href="${home}${p}">\n<link rel="alternate" hreflang="ar" href="${home}/ar${p}">\n<link rel="alternate" hreflang="x-default" href="${home}${p}">`;
  return html.replace(/(<meta property="og:url"[^>]*>)/, (m) => m + "\n" + links);
}

function arabic(html, page, home) {
  const { title, desc } = AR[page], p = pagePath(page);
  const meta = (re, v) => { if (!re.test(html)) throw new Error(page + " has no " + re); html = html.replace(re, (m, a) => a + attr(v) + '"'); };
  html = html.replace(/<html lang="en">/, '<html lang="ar" dir="rtl">');
  // opens in Arabic: set before any script reads the saved language
  html = html.replace(/(<meta charset="utf-8">)/, '$1\n<script>try{localStorage.setItem("hr-lang","ar")}catch(e){}</script>');
  html = html.replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`);
  meta(/(<meta name="description" content=")[^"]*"/, desc);
  meta(/(<meta property="og:site_name" content=")[^"]*"/, "ألعاب رش");
  meta(/(<meta property="og:title" content=")[^"]*"/, title);
  meta(/(<meta property="og:description" content=")[^"]*"/, desc);
  meta(/(<meta property="og:url" content=")[^"]*"/, `${home}/ar${p}`);
  meta(/(<meta property="og:image" content=")[^"]*"/, `${home}/og-ar.png`);
  html = html.replace(/(<meta property="og:type"[^>]*>)/, m => m + '\n<meta property="og:locale" content="ar_SA">');
  // installed from an Arabic page, the app is named in Arabic and opens in Arabic
  html = html.replace('<link rel="manifest" href="/manifest.webmanifest">', '<link rel="manifest" href="/manifest-ar.webmanifest">');
  html = html.replace('<meta name="apple-mobile-web-app-title" content="Rush Games">', '<meta name="apple-mobile-web-app-title" content="ألعاب رش">');
  // links between the pages stay on the Arabic side
  html = html.replace(/href="\/((?:hangman|trivia|harf)\/)?"/g, (_, g) => `href="/ar/${g || ""}"`);
  return html;
}

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
    out.set(page, alternates(html, page, home));
    out.set("ar/" + page, arabic(alternates(html, page, home), page, home));
  }
  return out;
}

module.exports = { build, PAGES, HOME };

if (require.main === module) {
  const dist = path.join(__dirname, "..", "dist");
  fs.rmSync(dist, { recursive: true, force: true });
  fs.cpSync(SITE, dist, { recursive: true }); // questions.json, the shared files (kept for old cached pages), etc.
  const pages = build({ api: (process.env.API_URL || "").replace(/\/+$/, ""), site: "" });
  for (const [p, html] of pages) { fs.mkdirSync(path.dirname(path.join(dist, p)), { recursive: true }); fs.writeFileSync(path.join(dist, p), html); }
  fs.writeFileSync(path.join(dist, "shared", "config.js"), `window.RUSH_CONFIG=${JSON.stringify({ api: (process.env.API_URL || "").replace(/\/+$/, ""), site: "", home: HOME, subscriptions: SUBSCRIPTIONS })};\n`);
  console.log(`built ${pages.size} pages into dist/ (api: ${process.env.API_URL || "same origin"})`);
}
