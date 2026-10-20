// Sign in with Google, to keep a player's progress across devices.
//
// A player is still an id and a token kept in the browser. Signing in links that id to a Google account; signing in
// on another device hands that device the same id and token, so streaks and leaderboard entries follow the player.
// The token is stored encrypted (AES-256-GCM, key from ACCOUNT_KEY or DAILY_KEY), because a new device needs the
// token itself, not only its hash. Only Google's account number ("sub") is kept: no email address, no name.
//
//   GET  /api/auth/config  -> {google: client id or null}
//   POST /api/auth/google  {credential, uid, token, confirm?}
//        -> {uid, token, email, switched}   (email is only echoed back for this device to show; never stored)
//        -> 409 {need: "switch"}            when the Google account already has progress on another id and this
//                                           device's id has progress of its own; resend with confirm: true to switch.
//                                           Switching merges this device's results into the account (merges.js,
//                                           first result of each day wins), once per account per season.
//
// Signed-in players get their own daily AI allowance in Harf rooms instead of sharing their network's (harf.js).
const crypto = require("crypto");
const store = require("./store");
const ident = require("./ident");
const limits = require("./limits");
const R = require("./site/shared/rules");

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const CERTS_URL = process.env.GOOGLE_CERTS_URL || "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = ["accounts.google.com", "https://accounts.google.com"];
const KEY_SRC = process.env.ACCOUNT_KEY || process.env.DAILY_KEY || "";
const KEY = KEY_SRC ? crypto.createHash("sha256").update("account|" + KEY_SRC).digest() : null;

/* ---------- the stored token ---------- */
function seal(token) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const data = Buffer.concat([c.update(token, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), data].map(b => b.toString("base64")).join(".");
}
function open(s) {
  const [iv, tag, data] = String(s).split(".").map(x => Buffer.from(x, "base64"));
  const d = crypto.createDecipheriv("aes-256-gcm", KEY, iv); d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString("utf8");
}

/* ---------- checking Google's sign-in token ----------
   A signed JWT: the signature must match one of Google's published keys, and it must be for our client id,
   from Google, and not expired. Google's keys are cached for as long as Google says. */
let certs = { at: 0, ttl: 0, keys: [] };
async function googleKeys(force) {
  if (!force && certs.keys.length && Date.now() - certs.at < certs.ttl) return certs.keys;
  const r = await fetch(CERTS_URL, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error("Google keys " + r.status);
  const j = await r.json();
  const m = /max-age=(\d+)/.exec(r.headers.get("cache-control") || "");
  certs = { at: Date.now(), ttl: Math.min(24 * 3600e3, (m ? Number(m[1]) : 3600) * 1000), keys: j.keys || [] };
  return certs.keys;
}
const b64json = s => JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
async function verifyGoogle(jwt) {
  const parts = String(jwt || "").split(".");
  if (parts.length !== 3) throw new Error("not a token");
  const head = b64json(parts[0]), body = b64json(parts[1]);
  if (head.alg !== "RS256") throw new Error("unexpected algorithm");
  let jwk = (await googleKeys()).find(k => k.kid === head.kid);
  if (!jwk) jwk = (await googleKeys(true)).find(k => k.kid === head.kid); // Google rotated its keys
  if (!jwk) throw new Error("unknown key");
  const ok = crypto.verify("RSA-SHA256", Buffer.from(parts[0] + "." + parts[1]), crypto.createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(parts[2], "base64url"));
  if (!ok) throw new Error("bad signature");
  const now = Date.now() / 1000;
  if (!ISSUERS.includes(body.iss)) throw new Error("wrong issuer");
  if (body.aud !== CLIENT_ID) throw new Error("wrong audience");
  if (!(body.exp > now - 60) || (body.iat && body.iat > now + 300)) throw new Error("expired");
  if (!body.sub) throw new Error("no account");
  return body;
}

/* ---------- who's signed in ---------- */
const signedIn = new Map(); // uid -> true/false, so rooms don't look it up on every check
async function isSignedIn(uid) {
  if (!CLIENT_ID || !uid) return false;
  if (signedIn.has(uid)) return signedIn.get(uid);
  const v = !!(await store.acctByUid(uid).catch(() => null));
  if (signedIn.size > 20000) signedIn.clear();
  signedIn.set(uid, v);
  return v;
}

async function handle(req, res, url, { send, readJson, ip }) {
  const p = url.pathname;
  if (!p.startsWith("/api/auth/")) return false;
  if (p === "/api/auth/config" && req.method === "GET") { send(res, 200, { google: CLIENT_ID && KEY ? CLIENT_ID : null }); return true; }
  if (p !== "/api/auth/google" || req.method !== "POST") return false;
  if (!CLIENT_ID || !KEY) { send(res, 404, { error: "Sign-in isn't set up on this server" }); return true; }
  if (!limits.take("auth|" + ip, 10, 10)) { send(res, 429, { error: "Too many tries. Wait a minute." }); return true; }
  const body = await readJson(req);
  if (!body) { send(res, 400, { error: "Body must be JSON" }); return true; }

  let g;
  try { g = await verifyGoogle(body.credential); }
  catch (e) { console.warn("Auth: Google token refused:", e.message); send(res, 401, { error: "Google sign-in couldn't be checked. Try again." }); return true; }

  const uid = String(body.uid || ""), token = String(body.token || "");
  if (!ident.isUid(uid) || token.length < 16) { send(res, 400, { error: "Expected {credential, uid, token}" }); return true; }
  const k = "g:" + g.sub, linked = await store.acctGet(k);
  const here = await ident.owner(uid, ident.hashToken(token));
  if (!here.ok) { send(res, 403, { error: "This player belongs to another device" }); return true; }

  // first sign-in with this Google account: it takes over this device's progress
  if (!linked) {
    if (await store.acctByUid(uid)) { send(res, 409, { error: "This progress is already linked to another Google account" }); return true; }
    await store.acctPut(k, uid, seal(token));
    signedIn.set(uid, true);
    console.log("Auth: linked a Google account");
    send(res, 200, { uid, token, email: g.email || "", switched: false });
    return true;
  }
  // the account already has progress: hand it to this device
  if (linked.uid === uid) { send(res, 200, { uid, token, email: g.email || "", switched: false }); return true; }
  if (!here.isNew && !body.confirm) { send(res, 409, { need: "switch", error: "This Google account already has progress on another device" }); return true; }
  let tok;
  try { tok = open(linked.tok); } catch { send(res, 500, { error: "Couldn't restore this account" }); return true; }
  // this device's own results join the account: the first result played each day counts, so playing a day on two
  // devices never helps. Once per account per season, so it can't be repeated to stack up days.
  let merged = 0, mergeSkipped = false;
  if (!here.isNew) {
    const mk = "merge:" + k, prev = await store.metaGet(mk).catch(() => null), se = R.curSeason();
    if (prev && prev.se === se) mergeSkipped = true;
    else {
      try {
        const r = await require("./merges").mergePlayers(linked.uid, uid, require("./merges").FIRST);
        merged = r.days;
        await store.metaPut(mk, { se, at: Date.now() });
        console.log(`Auth: merged a device into an account (${r.days} day(s): ${r.where.join(", ") || "none"})`);
      } catch (e) { console.error("Auth: merge failed", e); }
    }
  }
  send(res, 200, { uid: linked.uid, token: tok, email: g.email || "", switched: true, merged, mergeSkipped });
  return true;
}

module.exports = { handle, isSignedIn, verifyGoogle };
