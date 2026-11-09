// Rush Games on Discord: slash commands answered by this server (Discord "interactions": Discord sends each command
// here as a signed web request, so no always-on bot connection is needed), and linking a Discord account to a player.
//
// Set on the server (all three, or the bot stays off and /api/discord/* answers 404):
//   DISCORD_APP_ID      the application's id (Developer Portal, General Information)
//   DISCORD_PUBLIC_KEY  the application's public key (same page): every request from Discord is checked against it
//   DISCORD_BOT_TOKEN   the bot's token (Bot page): only used to register the commands with Discord at start-up
//
// Linking: the player's own profile on the site asks for a code (POST /api/discord/code {uid, token} -> {code, exp}),
// six letters valid for 10 minutes, and they type /link <code> in Discord. Kept in meta:
//   dcode:<CODE>   -> {u: player id, exp}      (cleared once used)
//   dlink:<discord user id> -> player id
//   dlinkp:<player id>      -> discord user id
//   dguild:<server id>      -> [discord user ids]  linked players seen in that Discord server, for /today
//   POST /api/discord/status {uid, token} -> {linked}
//   POST /api/discord/unlink {uid, token} -> {ok}
//   POST /api/discord/interactions         (Discord only; signature checked)
//
// Commands never show a daily's word, letter or answers: only points, times and how many were right.
const crypto = require("crypto");
const store = require("./store");
const ident = require("./ident");
const R = require("./site/shared/rules");

const APP_ID = process.env.DISCORD_APP_ID || "";
const PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY || "";
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || "";
const API = process.env.DISCORD_API || "https://discord.com/api/v10";
const SITE = (process.env.SITE_URL || "https://rushgames.cc").replace(/\/+$/, "");
const enabled = () => !!(APP_ID && PUBLIC_KEY);

const CODE_MS = 10 * 60e3;
const CODE_ABC = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I
const GUILD_MAX = 500;
const GOLD = 0xf2b632;

/* ---------- checking a request really comes from Discord (Ed25519) ---------- */
let pubKey = null;
function key() {
  if (!pubKey) pubKey = crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(PUBLIC_KEY, "hex")]), format: "der", type: "spki" });
  return pubKey;
}
function verify(sig, ts, body) {
  try {
    if (!/^[0-9a-f]{128}$/i.test(sig || "") || !/^\d{1,12}$/.test(ts || "")) return false;
    // a request more than 5 minutes old is a replay
    if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
    return crypto.verify(null, Buffer.from(ts + body), key(), Buffer.from(sig, "hex"));
  } catch { return false; }
}

/* ---------- links ---------- */
function newCode() { const b = crypto.randomBytes(6); let s = ""; for (const x of b) s += CODE_ABC[x % CODE_ABC.length]; return s; }
// the player's id now, following merges (signing in on a device with progress moves a player to another id)
async function follow(id) {
  const seen = new Set([id]);
  for (let i = 0; i < 10; i++) { const n = await store.metaGet("awlink:" + id).catch(() => null); if (!n || seen.has(String(n))) break; id = String(n); seen.add(id); }
  return id;
}
async function playerOf(duid) { const id = await store.metaGet("dlink:" + duid); return id ? follow(String(id)) : null; }
async function unlinkDiscord(duid) {
  const id = await store.metaGet("dlink:" + duid);
  await store.metaPut("dlink:" + duid, null);
  if (id && (await store.metaGet("dlinkp:" + id)) === duid) await store.metaPut("dlinkp:" + id, null);
  return !!id;
}
async function unlinkPlayer(uid) {
  const duid = await store.metaGet("dlinkp:" + uid);
  if (duid) { await store.metaPut("dlinkp:" + uid, null); if ((await store.metaGet("dlink:" + duid)) === uid) await store.metaPut("dlink:" + duid, null); }
  return !!duid;
}
async function seenIn(guild, duid) {
  if (!guild) return;
  const k = "dguild:" + guild, list = (await store.metaGet(k)) || [];
  if (list.includes(duid)) return;
  list.push(duid); while (list.length > GUILD_MAX) list.shift();
  await store.metaPut(k, list);
}

/* ---------- what the commands say ---------- */
const BOARDS = [["hangman", "en", "Hangman (EN)"], ["hangman", "ar", "Hangman (ع)"], ["trivia", "", "Trivia"], ["harf", "ar", "Harf (ع)"], ["harf", "en", "Harf (EN)"]];
const MEDAL = ["🥇", "🥈", "🥉"];
const clean = s => String(s || "").replace(/[\\*_~`|>@#<\[\]()]/g, "").slice(0, 16) || "Player";
const place = i => MEDAL[i] || "`" + String(i + 1).padStart(2) + "`";
const secs = ms => (Number(ms) / 1000).toFixed(1) + "s";
const reply = (data, ephemeral) => ({ type: 4, data: Object.assign({ allowed_mentions: { parse: [] } }, ephemeral ? { flags: 64 } : {}, data) });
const say = (text, ephemeral = true) => reply({ content: text }, ephemeral);
const embed = (title, lines, extra) => ({ embeds: [Object.assign({ title, description: lines.join("\n").slice(0, 4000) || "—", color: GOLD }, extra)] });

async function leaderboard(boards, which) {
  if (!which || which === "overall") {
    const h = await boards.hub("", "week");
    const lines = h.overall.map((x, i) => `${place(i)} **${clean(x.n)}** #${x.tag} · ${x.score}`);
    return embed(`Week ${h.wk} · overall`, lines.length ? lines : ["Nobody has played this week yet."], { url: SITE + "/", footer: { text: `${h.wleft} day(s) left this week · Friday to Thursday, Saudi time` } });
  }
  const [game, lg = ""] = which.split("-"), b = BOARDS.find(x => x[0] === game && x[1] === lg) || BOARDS[0];
  const d = await boards.board(b[0], b[1], "week", "");
  const lines = d.rows.slice(0, 10).map((r, i) => `${place(i)} **${clean(r.n)}** #${r.tag} · ${r.pts} pts`);
  return embed(`Week ${d.wk} · ${b[2]}`, lines.length ? lines : ["Nobody has played this board this week yet."], { url: SITE + "/" });
}

async function stats(boards, uid) {
  const p = await boards.player(uid, true);
  if (!p) return null;
  const lines = [];
  for (const b of p.boards || []) {
    const name = (BOARDS.find(x => x[0] === b.game && x[1] === (b.lg || "")) || [, , b.game])[2];
    lines.push(`**${name}** · week ${b.week.pts} pts${b.week.rank ? ` (#${b.week.rank})` : ""} · streak ${b.streak}🔥`);
  }
  const medals = (p.medals || []).length;
  if (medals) lines.push(`🏅 ${medals} medal${medals === 1 ? "" : "s"} won`);
  return embed(`${clean(p.n)} #${p.tag}`, lines.length ? lines : ["No results this week yet."], { url: SITE + "/" });
}

// today's results for the linked players seen in this Discord server: no words, letters or answers
async function today(boards, guild) {
  const list = (await store.metaGet("dguild:" + guild)) || [];
  const who = new Map(); // player id -> discord user id
  for (const duid of list) { const id = await playerOf(duid); if (id) who.set(id, duid); }
  if (!who.size) return null;
  const lines = [];
  for (const [game, lg, name] of BOARDS) {
    const d = await boards.board(game, lg, "today", "");
    const rows = d.rows.filter(r => who.has(r.id));
    if (!rows.length) continue;
    lines.push(`**${name}**`);
    rows.forEach(r => {
      const x = r.d || {};
      const what = game === "hangman" ? (x.ok ? `✅ ${secs(x.t)}, ${x.m} miss${x.m === 1 ? "" : "es"}` : "❌")
        : game === "trivia" ? String(x.s || "").split("").map(c => (c === "1" ? "🟩" : "🟥")).join("") + ` ${secs(x.t)}`
        : `${x.c} answer${x.c === 1 ? "" : "s"}`;
      lines.push(`<@${who.get(r.id)}> ${clean(r.n)} · ${what} · **${r.pts}**`);
    });
  }
  return embed(`Today · ${R.todayKey()}`, lines.length ? lines : ["Nobody linked here has played today's games yet."], { url: SITE + "/", footer: { text: "Play the dailies at rushgames.cc" } });
}

/* ---------- the commands as Discord sees them ---------- */
const BOARD_CHOICES = [["Overall", "overall"], ["Hangman (English)", "hangman-en"], ["Hangman (Arabic)", "hangman-ar"], ["Trivia", "trivia"], ["Harf (Arabic)", "harf-ar"], ["Harf (English)", "harf-en"]];
const COMMANDS = [
  { name: "link", description: "Link your Rush Games player (get the code from your profile on rushgames.cc)", options: [{ type: 3, name: "code", description: "The 6-letter code", required: true, min_length: 6, max_length: 6 }] },
  { name: "unlink", description: "Unlink your Rush Games player from this Discord account" },
  { name: "leaderboard", description: "This week's Rush Games leaderboard", options: [{ type: 3, name: "board", description: "Which board (default: overall)", required: false, choices: BOARD_CHOICES.map(([name, value]) => ({ name, value })) }] },
  { name: "streak", description: "Your streaks and this week's points" },
  { name: "today", description: "How the linked players in this server did in today's dailies" },
].map(c => Object.assign({ type: 1, integration_types: [0, 1], contexts: [0, 1, 2] }, c));

async function command(i, boards) {
  const name = i.data && i.data.name, user = (i.member && i.member.user) || i.user || {}, duid = String(user.id || ""), guild = i.guild_id || null;
  const opt = n => { const o = ((i.data && i.data.options) || []).find(x => x.name === n); return o ? String(o.value) : ""; };
  if (!/^\d{5,25}$/.test(duid)) return say("Couldn't tell who you are.");
  if (name === "link") {
    const code = opt("code").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const c = code.length === 6 ? await store.metaGet("dcode:" + code) : null;
    if (!c || !c.u || c.exp < Date.now()) return say("That code didn't work. Open your profile on " + SITE + ", press **Link Discord**, and use the new code within 10 minutes.");
    await store.metaPut("dcode:" + code, null);
    const uid = await follow(String(c.u));
    // one Discord account per player and one player per Discord account: an older link on either side goes
    await unlinkDiscord(duid); await unlinkPlayer(uid);
    await store.metaPut("dlink:" + duid, uid); await store.metaPut("dlinkp:" + uid, duid);
    await seenIn(guild, duid);
    const p = await boards.player(uid, true).catch(() => null);
    return say(`Linked! You're **${clean(p && p.n)}** #${R.tagOf(uid)}. Try /streak, /leaderboard and /today.`);
  }
  if (name === "unlink") return say((await unlinkDiscord(duid)) ? "Unlinked. Your results stay on Rush Games." : "This Discord account isn't linked.");
  if (name === "leaderboard") return reply(await leaderboard(boards, opt("board")), false);
  const uid = await playerOf(duid);
  if (uid) await seenIn(guild, duid);
  if (name === "streak") {
    if (!uid) return say("Link your player first: open your profile on " + SITE + ", press **Link Discord**, then type /link with the code.");
    const e = await stats(boards, uid);
    return e ? reply(e, false) : say("No results yet. Play a daily at " + SITE + "!");
  }
  if (name === "today") {
    if (!guild) return say("Use /today in a server: it shows how the linked players there did.");
    const e = await today(boards, guild);
    return e ? reply(e, false) : say("Nobody linked in this server has used Rush Games here yet. Link with /link, then try again.", false);
  }
  return say("Unknown command.");
}

/* ---------- registering the commands with Discord (once per change) ---------- */
async function register() {
  if (!enabled() || !BOT_TOKEN) return;
  const want = crypto.createHash("sha256").update(JSON.stringify(COMMANDS)).digest("hex").slice(0, 16);
  try {
    if ((await store.metaGet("dcmds")) === want) return;
    const r = await fetch(`${API}/applications/${APP_ID}/commands`, { method: "PUT", headers: { Authorization: "Bot " + BOT_TOKEN, "Content-Type": "application/json" }, body: JSON.stringify(COMMANDS), signal: AbortSignal.timeout(15000) });
    if (!r.ok) { console.log("Discord: registering commands failed", r.status, (await r.text()).slice(0, 300)); return; }
    await store.metaPut("dcmds", want);
    console.log("Discord: commands registered (" + COMMANDS.length + ")");
  } catch (e) { console.log("Discord: registering commands failed", e.message); }
}

/* ---------- routes ---------- */
async function owned(body) {
  const uid = String((body && body.uid) || "");
  if (!body || !ident.isUid(uid) || typeof body.token !== "string" || body.token.length < 16) return null;
  const o = await ident.owner(uid, ident.hashToken(body.token));
  return o.ok && !o.isNew ? uid : null;
}

async function handle(req, res, url, { send, readJson, readBody, ip }, limits) {
  const p = url.pathname;
  if (!p.startsWith("/api/discord/")) return false;
  if (!enabled()) { send(res, 404, { error: "Discord isn't set up" }); return true; }
  const boards = require("./boards");
  if (p === "/api/discord/interactions" && req.method === "POST") {
    let raw;
    try { raw = await readBody(req, 64 * 1024); } catch { send(res, 413, { error: "Too large" }); return true; }
    if (!verify(req.headers["x-signature-ed25519"], req.headers["x-signature-timestamp"], raw)) { send(res, 401, { error: "Bad signature" }); return true; }
    let i; try { i = JSON.parse(raw); } catch { send(res, 400, { error: "Bad body" }); return true; }
    if (i.type === 1) { send(res, 200, { type: 1 }); return true; } // Discord's check that this address works
    if (i.type !== 2) { send(res, 400, { error: "Unsupported" }); return true; }
    try { send(res, 200, await command(i, boards)); }
    catch (e) { console.error("Discord command", e); send(res, 200, say("Something went wrong. Try again in a moment.")); }
    return true;
  }
  if (req.method !== "POST") return false;
  if (!limits.take("dc|" + ip, 20, 10)) { send(res, 429, { error: "Too many requests. Slow down a little." }); return true; }
  const body = await readJson(req), uid = await owned(body);
  if (!uid) { send(res, 403, { error: "This player belongs to another device" }); return true; }
  if (p === "/api/discord/code") {
    const prev = await store.metaGet("dcodep:" + uid);
    if (prev && prev.code) await store.metaPut("dcode:" + prev.code, null); // only the newest code works
    let code; for (let n = 0; n < 5; n++) { code = newCode(); if (!(await store.metaGet("dcode:" + code))) break; }
    const exp = Date.now() + CODE_MS;
    await store.metaPut("dcode:" + code, { u: uid, exp }); await store.metaPut("dcodep:" + uid, { code, exp });
    send(res, 200, { code, exp, ms: CODE_MS });
    return true;
  }
  if (p === "/api/discord/status") { send(res, 200, { linked: !!(await store.metaGet("dlinkp:" + uid)) }); return true; }
  if (p === "/api/discord/unlink") { await unlinkPlayer(uid); send(res, 200, { ok: true }); return true; }
  return false;
}

module.exports = { handle, register, enabled, verify, COMMANDS };
