// Rush Games server: the site's pages, live rooms over WebSocket for every game, the Hangman Rush daily word and
// leaderboard, the Trivia Rush API (trivia.js) and the Harf Rush API (harf.js). The same pages can also be served by a free Render static site,
// which never sleeps; they then talk to this server across origins (see SITE_URL and site/shared/config.js).
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, "site");
const SITE_URL = (process.env.SITE_URL || "").replace(/\/+$/, "");
const store = require("./store");
const trivia = require("./trivia");
const hangman = require("./hangman");
const harf = require("./harf");
const admin = require("./admin");
const mod = require("./mod");
const auth = require("./auth");
const limits = require("./limits");
const boards = require("./boards");
const move = require("./move");
const reports = require("./reports");
const discord = require("./discord");
// while moving servers (MOVE_MODE=readonly) every database write does nothing; see move.js
move.guard(store, ["put", "tPut", "hPut", "hSetData", "hDel", "seenMark", "seenPrune", "wordsPut", "wordsDel", "wordsPurge", "wordsPurgeValid", "archivePut", "ipAdd", "metaPut", "metaPruneBefore", "acctPut"]);
// pages are served as single files with the shared styles and scripts written in (see scripts/build-site.js)
const PAGES = require("./scripts/build-site").build({ api: "", site: SITE_URL });
const NOT_FOUND = (() => { try { return fs.readFileSync(path.join(__dirname, "site", "404.html")); } catch { return null; } })();

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json; charset=utf-8", ".webmanifest": "application/manifest+json", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8" };

// The API is called from the static site's origin too. Players are identified by a token in the request body,
// never by cookies, so allowing any origin is safe.
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "86400" };
// sent with everything: no MIME guessing, no framing by other sites, no full addresses leaked in Referer
const SECURE = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "strict-origin-when-cross-origin", "Content-Security-Policy": "frame-ancestors 'none'", "X-Frame-Options": "DENY" };

function send(res, code, body, type = "application/json") {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store", ...CORS, ...SECURE });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

function readBody(req, limit = 32 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0, chunks = [];
    req.on("data", c => { size += c.length; if (size > limit) { reject(new Error("too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function readJson(req) {
  try { const v = JSON.parse(await readBody(req)); return v && typeof v === "object" && !Array.isArray(v) ? v : null; } catch { return null; }
}

// Every daily is played and scored on the server (hangman.js, trivia.js, harf.js); pages only send moves and names.
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    if (req.method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }
    // moving servers: read-only refuses writes, redirect-only forwards the API to the new server (move.js)
    if (await move.handle(req, res, url, { send, readJson }, mod.auth)) return;
    // Render restarts the server when this fails: it checks the database answers, not just that the process is up
    if (url.pathname === "/healthz") {
      try { await store.ping(); return send(res, 200, "ok", "text/plain"); }
      catch (e) { return send(res, 503, "database not answering", "text/plain"); }
    }
    const ip = limits.clientIp(req);
    // the address the server sees for this visitor, so the limits below can be checked against the real one
    if (url.pathname === "/api/whoami" && req.method === "GET") {
      const h = req.headers;
      return send(res, 200, { ip, cf: h["cf-connecting-ip"] ? 1 : 0, tci: h["true-client-ip"] ? 1 : 0, xff: String(h["x-forwarded-for"] || "").split(",").map(s => s.trim()).filter(Boolean).length });
    }
    // every write: a generous limit per address, so a script can't hammer the server or fill the database
    if ((req.method === "POST" || req.method === "PUT") && url.pathname.startsWith("/api/") && url.pathname !== "/api/hit" && !/^\/api\/discord\/(interactions|activity|me|claim|played|home)$/.test(url.pathname)) {
      // (players inside Discord share its proxy's addresses, so they share one larger allowance)
      const dc = viaDiscord(req);
      if (!limits.take(dc ? "w|discord" : "w|" + ip, dc ? 3000 : 120, dc ? 1500 : 60)) return send(res, 429, { error: "Too many requests. Slow down a little." });
    }
    // the Harf admin page (needs ADMIN_KEY; only on this server, never on the static site)
    if (url.pathname === "/admin" || url.pathname === "/admin/" || url.pathname === "/admin/harf") {
      if (!process.env.ADMIN_KEY) return send(res, 404, "Not found", "text/plain");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex", ...SECURE });
      return res.end(fs.readFileSync(path.join(__dirname, "admin", "index.html")));
    }
    // pages served from here talk to this same server; SITE_URL points players at the static copy
    if (url.pathname === "/shared/config.js")
      return send(res, 200, `window.RUSH_CONFIG={api:"",site:${JSON.stringify(SITE_URL)},home:${JSON.stringify(require("./scripts/build-site").HOME)}};`, "text/javascript; charset=utf-8");
    // a party is live while its big screen is in the party's lobby room (Harf gives party games their own AI allowance)
    const partyLive = code => { const r = rooms.get("pt-" + String(code).toLowerCase()); return !!r && [...r.values()].some(v => v.presence && v.presence.tv === 1); };
    const ctx = { send, readJson, readBody, ip, partyLive };
    if (await discord.handle(req, res, url, ctx, limits)) return;
    if (await boards.handle(req, res, url, ctx, limits)) return;
    if (await trivia.handle(req, res, url, ctx)) return;
    if (await hangman.handle(req, res, url, ctx)) return;
    if (await harf.handle(req, res, url, ctx)) return;
    if (await reports.handle(req, res, url, ctx)) return;
    if (await admin.handle(req, res, url, ctx)) return;
    // the moderation API (team, audit log, changes, agents): a limited number a minute per address, like the admin API
    if (url.pathname.startsWith("/api/mod/")) {
      if (!limits.take("adm|" + ip, 120, 60)) return send(res, 429, { error: "Too many tries. Wait a minute." });
      if (await mod.handle(req, res, url, ctx)) return;
    }
    if (await auth.handle(req, res, url, ctx)) return;

    // static
    let p = url.pathname.endsWith("/") ? url.pathname + "index.html" : url.pathname;
    const page = PAGES.get(p.replace(/^\/+/, ""));
    if (page) {
      res.writeHead(200, { "Content-Type": TYPES[".html"], "Cache-Control": "no-cache", ...SECURE });
      return res.end(page);
    }
    // /ar -> /ar/ (the Arabic pages are built in memory, so there's no folder on disk to find)
    if (PAGES.has(p.replace(/^\/+/, "") + "/index.html")) {
      res.writeHead(301, { Location: url.pathname + "/" + url.search });
      return res.end();
    }
    let decoded;
    try { decoded = decodeURIComponent(p); } catch { return send(res, 400, "Bad address", "text/plain"); }
    const file = path.normalize(path.join(PUBLIC, decoded));
    if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, "Forbidden", "text/plain");
    // /trivia -> /trivia/ so the page's relative links work
    if (!path.extname(file) && fs.existsSync(path.join(file, "index.html"))) {
      res.writeHead(301, { Location: url.pathname + "/" + url.search });
      return res.end();
    }
    fs.readFile(file, (err, buf) => {
      if (err) {
        // a page address that doesn't exist gets the friendly page; anything else (a missing file) a plain answer
        const ext = path.extname(url.pathname), nf = !ext || ext === ".html" ? NOT_FOUND : null;
        if (!nf) return send(res, 404, "Not found", "text/plain");
        res.writeHead(404, { "Content-Type": TYPES[".html"], "Cache-Control": "no-cache", ...SECURE });
        return res.end(nf);
      }
      // the font files never change (a new version gets a new name), so browsers keep them for a year
      const cache = decoded.startsWith("/fonts/") ? "public, max-age=31536000, immutable" : "no-cache";
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": cache, ...SECURE });
      res.end(buf);
    });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: "Server error" });
  }
});

// ---------- live rooms ----------
// rooms: name -> Map(peerId -> { ws, presence })
const rooms = new Map();
const ROOM_RE = /^[a-z0-9][a-z0-9_.-]{0,47}$/;
const MAX_PRESENCE = 4096;

function broadcast(name) {
  const room = rooms.get(name);
  if (!room) return;
  const peers = [...room.entries()].map(([peer, v]) => ({ peer, presence: v.presence }));
  for (const [peer, v] of room) {
    if (v.ws.readyState === 1) v.ws.send(JSON.stringify({ t: "peers", room: name, me: peer, peers }));
  }
}

// one place per player in a room: a player who joins again (another tab, or a phone that rescanned the party's QR
// code) replaces their older place, which is told so and doesn't come back by itself
function dropOlder(name, ws) {
  const room = rooms.get(name), me = room && room.get(ws.peerId), u = me && me.presence.u;
  if (typeof u !== "string" || !u) return;
  for (const [peer, v] of room) {
    if (peer === ws.peerId || v.presence.u !== u) continue;
    room.delete(peer); v.ws.rooms.delete(name);
    if (v.ws.readyState === 1) v.ws.send(JSON.stringify({ t: "error", room: name, code: "replaced" }));
  }
}

function leave(ws, name) {
  const room = rooms.get(name);
  if (!room) return;
  room.delete(ws.peerId);
  ws.rooms.delete(name);
  if (room.size === 0) rooms.delete(name); else broadcast(name);
}

// limits that keep one visitor from overloading the rooms: connections per address, rooms per connection,
// players per room, and messages per second (each message is re-sent to everyone in the room)
// party rooms ("pt-<code>", rushgames.cc/party): PARTY_MAX players plus the TV that hosts them; a party that's full
// answers "party_full". (Raise PARTY_MAX for supporters later.) A party's game room holds them all too, and a whole
// family on one home connection shares one address, so that limit leaves room for a full party.
const PARTY_MAX = Math.max(2, Number(process.env.PARTY_MAX) || 15);
const WS_PER_IP = Math.max(12, 2 * (PARTY_MAX + 1) + 8), ROOMS_PER_WS = 4, ROOM_MAX = Math.max(20, PARTY_MAX + 1), MSG_PER_SEC = 10, MSG_BURST = 20;
const roomCap = name => (name.startsWith("pt-") ? PARTY_MAX + 1 : name.startsWith("pw-") ? PARTY_MAX + 2 : ROOM_MAX);
// A party in a Discord call has no TV: every player's window shows the big screen too. Those screens sit in the party's
// room as watchers (they join with w: 1, only read, and aren't counted as players), and one of them runs the game and
// shares its state with the rest as its presence in the party's "pw-<code>" room, which may be larger than a player's.
const isWatcher = v => !!v.presence && v.presence.w === 1;
const maxPresence = name => (name.startsWith("pw-") ? PW_PRESENCE : MAX_PRESENCE);
const PW_PRESENCE = 12000;
// Everyone playing inside Discord reaches us through Discord's proxy, so they share a few addresses: those connections
// get one large shared allowance instead of the per-address one.
const DISCORD_ORIGIN = process.env.DISCORD_APP_ID ? `https://${process.env.DISCORD_APP_ID}.discordsays.com` : "";
const DISCORD_WS_MAX = Math.max(WS_PER_IP, Number(process.env.DISCORD_WS_MAX) || 1500);
const viaDiscord = req => !!DISCORD_ORIGIN && (req.headers.origin === DISCORD_ORIGIN || /(^|\.)discordsays\.com$/.test(String(req.headers["cf-worker"] || "")));
const wsByIp = new Map(); // ip -> open connections
const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 32 * 1024 });
wss.on("connection", (ws, req) => {
  const dc = viaDiscord(req), ip = dc ? "discord" : limits.clientIp(req);
  const n = (wsByIp.get(ip) || 0) + 1;
  if (n > (dc ? DISCORD_WS_MAX : WS_PER_IP)) { ws.close(1008, "Too many connections"); return; }
  wsByIp.set(ip, n);
  ws.on("close", () => { const m = (wsByIp.get(ip) || 1) - 1; if (m <= 0) wsByIp.delete(ip); else wsByIp.set(ip, m); });
  ws.peerId = crypto.randomBytes(8).toString("hex");
  ws.rooms = new Set();
  ws.alive = true;
  ws.tokens = MSG_BURST; ws.tokAt = Date.now(); ws.dropped = 0;
  ws.on("pong", () => (ws.alive = true));

  ws.on("message", raw => {
    const now = Date.now();
    ws.tokens = Math.min(MSG_BURST, ws.tokens + ((now - ws.tokAt) / 1000) * MSG_PER_SEC); ws.tokAt = now;
    if (ws.tokens < 1) { if (++ws.dropped > 200) ws.terminate(); return; } // far over the limit: a script, not a player
    ws.tokens -= 1;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    // the shared clock: a page sends its own time and gets the server's back, to work out how far apart they are
    // (round schedules use the server's clock, so a phone and the big screen agree whatever their clocks say)
    if (msg && msg.t === "time") { ws.send(JSON.stringify({ t: "time", c: Number(msg.c) || 0, s: Date.now() })); return; }
    if (!msg || typeof msg.room !== "string" || !ROOM_RE.test(msg.room)) return;
    const name = msg.room;

    if (msg.t === "join") {
      if (!ws.rooms.has(name)) {
        if (ws.rooms.size >= ROOMS_PER_WS) return ws.send(JSON.stringify({ t: "error", room: name, code: "limit_reached" }));
        const room = rooms.get(name) || new Map();
        // a party's watchers (the screens of a party in a Discord call) have their own places, apart from the players'
        const watch = name.startsWith("pt-") && !!msg.presence && msg.presence.w === 1;
        const taken = name.startsWith("pt-") ? [...room.values()].filter(v => isWatcher(v) === watch).length : room.size;
        if (taken >= roomCap(name)) return ws.send(JSON.stringify({ t: "error", room: name, code: name.startsWith("pt-") ? "party_full" : "limit_reached" }));
        rooms.set(name, room);
        room.set(ws.peerId, { ws, presence: {} });
        ws.rooms.add(name);
      }
      const p = msg.presence;
      if (p && typeof p === "object" && !Array.isArray(p) && JSON.stringify(p).length <= maxPresence(name)) rooms.get(name).get(ws.peerId).presence = p;
      dropOlder(name, ws);
      broadcast(name);
    } else if (msg.t === "presence") {
      const entry = rooms.get(name) && rooms.get(name).get(ws.peerId);
      if (!entry || !msg.patch || typeof msg.patch !== "object" || Array.isArray(msg.patch)) return;
      const next = Object.assign({}, entry.presence);
      for (const [k, v] of Object.entries(msg.patch)) { if (v === null) delete next[k]; else next[k] = v; }
      if (JSON.stringify(next).length > maxPresence(name)) return;
      entry.presence = next;
      if ("u" in msg.patch) dropOlder(name, ws);
      broadcast(name);
    } else if (msg.t === "to") {
      // a private message to one peer in the same room (the party TV telling each phone its secret role); the
      // server stamps who sent it, so it can't be faked, and nobody else in the room sees it
      const room = rooms.get(name), target = room && typeof msg.to === "string" && room.get(msg.to);
      if (!room || !room.has(ws.peerId) || !target || !msg.data || typeof msg.data !== "object" || JSON.stringify(msg.data).length > 2048) return;
      if (target.ws.readyState === 1) target.ws.send(JSON.stringify({ t: "msg", room: name, from: ws.peerId, data: msg.data }));
    } else if (msg.t === "leave") {
      leave(ws, name);
    }
  });

  ws.on("close", () => { for (const name of [...ws.rooms]) leave(ws, name); });
});

// drop dead connections
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false;
    try { ws.ping(); } catch {}
  }
}, 30000);

// redirect-only: the old database may be gone, so start with none; every API call is forwarded (move.js)
if (move.redirecting()) server.listen(PORT, () => console.log(`Rush Games listening on ${PORT} (redirect-only to the new server)`));
else store.init().then(() => admin.loadHidden()).then(() => mod.load()).then(() => harf.init()).then(() => require("./merges").runMerges().catch(e => console.error("Merge failed", e))).then(() => {
  server.listen(PORT, () => { console.log(`Rush Games listening on ${PORT} (storage: ${store.kind})`); discord.register(); discord.start(); });
}).catch(e => { console.error("Storage failed to start", e); process.exit(1); });
