// Hangman Rush server: static files, live rooms over WebSocket, and the daily leaderboard API.
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, "public");
const store = require("./store");

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

function send(res, code, body, type = "application/json") {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
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

const hashToken = t => crypto.createHash("sha256").update(String(t)).digest("hex");

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname === "/healthz") return send(res, 200, "ok", "text/plain");

    if (url.pathname === "/api/players" && req.method === "GET") {
      const rows = await store.all();
      return send(res, 200, rows.map(r => ({ id: r.id, data: r.data })));
    }

    const m = url.pathname.match(/^\/api\/players\/([^/]+)$/);
    if (m && req.method === "PUT") {
      const id = m[1];
      if (!ID_RE.test(id)) return send(res, 400, { error: "Bad player id" });
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: "Body must be JSON under 32 KB" }); }
      if (!body || typeof body.token !== "string" || body.token.length < 16 || typeof body.data !== "object" || Array.isArray(body.data))
        return send(res, 400, { error: "Expected {token, data}" });
      const existing = await store.get(id);
      const th = hashToken(body.token);
      if (existing && existing.token !== th) return send(res, 403, { error: "This player belongs to another device" });
      await store.put(id, th, body.data);
      return send(res, 200, { ok: true });
    }

    // static
    let p = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = path.normalize(path.join(PUBLIC, p));
    if (!file.startsWith(PUBLIC)) return send(res, 403, "Forbidden", "text/plain");
    fs.readFile(file, (err, buf) => {
      if (err) return send(res, 404, "Not found", "text/plain");
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
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

function leave(ws, name) {
  const room = rooms.get(name);
  if (!room) return;
  room.delete(ws.peerId);
  ws.rooms.delete(name);
  if (room.size === 0) rooms.delete(name); else broadcast(name);
}

const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 16 * 1024 });
wss.on("connection", ws => {
  ws.peerId = crypto.randomBytes(8).toString("hex");
  ws.rooms = new Set();
  ws.alive = true;
  ws.on("pong", () => (ws.alive = true));

  ws.on("message", raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.room !== "string" || !ROOM_RE.test(msg.room)) return;
    const name = msg.room;

    if (msg.t === "join") {
      if (!ws.rooms.has(name)) {
        if (ws.rooms.size >= 16) return ws.send(JSON.stringify({ t: "error", room: name, code: "limit_reached" }));
        if (!rooms.has(name)) rooms.set(name, new Map());
        const room = rooms.get(name);
        if (room.size >= 64) return ws.send(JSON.stringify({ t: "error", room: name, code: "limit_reached" }));
        room.set(ws.peerId, { ws, presence: {} });
        ws.rooms.add(name);
      }
      const p = msg.presence;
      if (p && typeof p === "object" && !Array.isArray(p) && JSON.stringify(p).length <= MAX_PRESENCE) rooms.get(name).get(ws.peerId).presence = p;
      broadcast(name);
    } else if (msg.t === "presence") {
      const entry = rooms.get(name) && rooms.get(name).get(ws.peerId);
      if (!entry || !msg.patch || typeof msg.patch !== "object" || Array.isArray(msg.patch)) return;
      const next = Object.assign({}, entry.presence);
      for (const [k, v] of Object.entries(msg.patch)) { if (v === null) delete next[k]; else next[k] = v; }
      if (JSON.stringify(next).length > MAX_PRESENCE) return;
      entry.presence = next;
      broadcast(name);
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

store.init().then(() => {
  server.listen(PORT, () => console.log(`Hangman Rush listening on ${PORT} (storage: ${store.kind})`));
}).catch(e => { console.error("Storage failed to start", e); process.exit(1); });
