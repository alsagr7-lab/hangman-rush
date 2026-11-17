// Backwards Rush (party): the short voice clips a player's phone records and the big screen plays. A clip is kept in
// memory only, for CLIP_TTL (a turn is over long before that), under an unguessable id, and only a live party may add
// one. Nothing is written to the database or to disk; a restart forgets every clip.
const crypto = require("crypto");

const CLIP_MAX = 400 * 1024;          // a few seconds of compressed sound is 20-80 KB
const CLIP_TTL = 15 * 60 * 1000;
const CLIP_KEEP = 300;                 // the most clips held at once (the oldest go first)
const TYPES = /^audio\/(webm|mp4|ogg|mpeg|wav|x-m4a|aac)$/;
const clips = new Map();               // id -> { buf, type, at }

function prune(now = Date.now()) {
  for (const [id, c] of clips) { if (now - c.at > CLIP_TTL) clips.delete(id); else break; }
  while (clips.size > CLIP_KEEP) clips.delete(clips.keys().next().value);
}

function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    // past the limit the rest is read and dropped, so the answer still reaches the phone
    let size = 0; const chunks = [];
    req.on("data", c => { size += c.length; if (size <= limit) chunks.push(c); });
    req.on("end", () => (size > limit ? reject(new Error("too large")) : resolve(Buffer.concat(chunks))));
    req.on("error", reject);
  });
}

async function handle(req, res, url, ctx, limits) {
  const p = url.pathname;
  if (p === "/api/party/clip" && req.method === "POST") {
    if (!limits.take("clip|" + ctx.ip, 40, 15)) return ctx.send(res, 429, { error: "Too many clips. Slow down a little." }), true;
    const code = String(url.searchParams.get("c") || "");
    if (!/^[A-Za-z]{4}$/.test(code) || !ctx.partyLive(code)) return ctx.send(res, 404, { error: "No party with that code." }), true;
    const type = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    if (!TYPES.test(type)) return ctx.send(res, 415, { error: "Not a sound clip." }), true;
    if (Number(req.headers["content-length"]) > CLIP_MAX) return ctx.send(res, 413, { error: "That clip is too long." }), true;
    let buf;
    try { buf = await readRaw(req, CLIP_MAX); } catch { return ctx.send(res, 413, { error: "That clip is too long." }), true; }
    if (buf.length < 100) return ctx.send(res, 400, { error: "That clip is empty." }), true;
    prune();
    const id = crypto.randomBytes(16).toString("hex");
    clips.set(id, { buf, type, at: Date.now() });
    return ctx.send(res, 200, { id }), true;
  }
  const m = p.match(/^\/api\/party\/clip\/([0-9a-f]{32})$/);
  if (m && req.method === "GET") {
    prune();
    const c = clips.get(m[1]);
    if (!c) return ctx.send(res, 404, { error: "That clip is gone." }), true;
    res.writeHead(200, { "Content-Type": c.type, "Content-Length": c.buf.length, "Cache-Control": "private, max-age=900", ...ctx.headers });
    res.end(c.buf);
    return true;
  }
  return false;
}

module.exports = { handle, CLIP_MAX, _clips: clips };
