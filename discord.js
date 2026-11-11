// Rush Games on Discord: slash commands answered by this server (Discord "interactions": Discord sends each command
// here as a signed web request, so no always-on bot connection is needed), and linking a Discord account to a player.
//
// Set on the server (all three, or the bot stays off and /api/discord/* answers 404):
//   DISCORD_APP_ID      the application's id (Developer Portal, General Information)
//   DISCORD_PUBLIC_KEY  the application's public key (same page): every request from Discord is checked against it
//   DISCORD_BOT_TOKEN   the bot's token (Bot page): registers the commands at start-up, and posts the Activity's
//                       daily summary in a channel (the bot must be in that server with Send Messages)
//   DISCORD_CLIENT_SECRET  (OAuth2 page) needed for the Activity: it turns the Activity's login code into the
//                       player's Discord account
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
// The Activity (site/discord/, the dailies inside Discord): Discord shows our site at <app id>.discordsays.com and
// passes requests on through its URL mappings ("/" -> rushgames.cc, "/server" -> api.rushgames.cc). The page asks
// Discord for a login code and sends it here:
//   POST /api/discord/activity {code}     -> {access_token, me: {id, name}, ds, player: {uid, token, n} | null, relink}
//        ds is a signed pass for this Discord account (24 h) used by the calls below; player is the linked player,
//        handed over with its token (kept sealed when the code from the profile was made), so the Activity plays as
//        them; relink means linked before tokens were kept: link again once from the profile.
//   POST /api/discord/me {ds}             -> the same player, after linking with /link while the Activity is open
//   POST /api/discord/claim {ds, uid, token} -> links this Discord account to a new player started in the Activity
//   POST /api/discord/home {ds, guild, tab} -> the Activity's menu in one call: {no, today, all, server}. today is the
//        linked player's own dailies so far (points only); all is this week's (or the season's) leaders as on the hub;
//        server is the same ranked among the linked players seen in that Discord server (null outside a server).
//   POST /api/discord/played {ds, channel, guild} -> after a daily: one message per channel per day listing how the
//        players there did (points and times only), edited as more play. Meta: dchan:<channel>:<day> -> Discord ids,
//        dmsg:<channel>:<day> -> message id, dlinktok:<player> -> the sealed token.
//
// The channel's messages (as the Wordle app does it): the day's summary carries a "Play now!" button that opens the
// Activity (a button press arrives here as an interaction, answered with Discord's "launch activity" reply), and each
// new day the channels that played yesterday get one recap: the group's streak and yesterday's ranking. Meta:
//   dstreak:<channel> -> {n, last}   days in a row someone there played a daily through the Activity
//   dactive           -> {channel: last day played}   where to post the recap (channels drop out after a day off)
//   drecap            -> the day whose recap round has been done
//   dremind           -> the day whose streak reminders have gone out
// Both messages carry a picture card (card.js): each player's avatar and a grid of how their dailies went, in the
// site's fonts. The recap is posted as a reply to the day's summary it sums up. In the evening (DISCORD_REMIND_HOUR,
// Saudi time, default 21; "off" for none) a channel whose streak of two days or more hasn't been kept up today gets
// one short reminder.
//
// Commands and messages never show a daily's word, letter or answers: only points, times and how many were right.
const crypto = require("crypto");
const store = require("./store");
const ident = require("./ident");
const R = require("./site/shared/rules");
const card = require("./card");

const APP_ID = process.env.DISCORD_APP_ID || "";
const PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY || "";
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || "";
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || "";
const OAUTH = process.env.DISCORD_OAUTH || "https://discord.com/api/v10";
const API = process.env.DISCORD_API || "https://discord.com/api/v10";
const SITE = (process.env.SITE_URL || "https://rushgames.cc").replace(/\/+$/, "");
const enabled = () => !!(APP_ID && PUBLIC_KEY);

const CDN = process.env.DISCORD_CDN || "https://cdn.discordapp.com";
const REMIND_HOUR = /^off$/i.test(process.env.DISCORD_REMIND_HOUR || "") ? -1 : Math.min(23, Math.max(0, Number(process.env.DISCORD_REMIND_HOUR || 21)));
const RECAP_HOURS = Number(process.env.DISCORD_RECAP_HOURS || 6); // a restart later in the day than this skips that day's recaps
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
// a player's token is kept sealed so the Activity (another browser) can play as them; same scheme as auth.js
const SEAL_SRC = process.env.ACCOUNT_KEY || process.env.DAILY_KEY || "";
const SEAL = crypto.createHash("sha256").update("discord|" + (SEAL_SRC || PUBLIC_KEY)).digest();
function seal(token) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", SEAL, iv);
  const data = Buffer.concat([c.update(token, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), data].map(b => b.toString("base64")).join(".");
}
function unseal(v) {
  try { const [iv, tag, data] = String(v).split(".").map(x => Buffer.from(x, "base64")); const d = crypto.createDecipheriv("aes-256-gcm", SEAL, iv); d.setAuthTag(tag); return Buffer.concat([d.update(data), d.final()]).toString("utf8"); } catch { return null; }
}
// the Activity's pass: Discord id and expiry, signed
const PASS_MS = 24 * 3600e3;
const passSig = s => crypto.createHmac("sha256", SEAL).update("pass|" + s).digest("base64url").slice(0, 32);
const makePass = duid => { const s = duid + "." + (Date.now() + PASS_MS); return s + "." + passSig(s); };
function readPass(p) {
  const m = /^(\d{5,25})\.(\d{13})\.([\w-]{32})$/.exec(String(p || ""));
  if (!m || Number(m[2]) < Date.now()) return null;
  const want = passSig(m[1] + "." + m[2]);
  return crypto.timingSafeEqual(Buffer.from(want), Buffer.from(m[3])) ? m[1] : null;
}
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
// today's results for some linked players (player id -> Discord id): no words, letters or answers
// day (optional): a Map filled with each player's day for the picture card: id -> {name, color, pts, g: {board: detail}}
async function results(boards, who, tab = "today", day = null) {
  const lines = [];
  for (const [game, lg, name] of BOARDS) {
    const d = await boards.board(game, lg, tab, "");
    const rows = d.rows.filter(r => who.has(r.id));
    if (!rows.length) continue;
    lines.push(`**${name}**`);
    rows.forEach(r => {
      const x = r.d || {};
      if (day) { const p = day.get(r.id) || { name: clean(r.n), color: r.c, pts: 0, g: {} }; p.pts += r.pts; p.g[game + (lg ? "-" + lg : "")] = game === "hangman" ? { ok: x.ok, m: x.m } : game === "trivia" ? { s: x.s } : { c: x.c }; day.set(r.id, p); }
      const what = game === "hangman" ? (x.ok ? `✅ ${secs(x.t)}, ${x.m} miss${x.m === 1 ? "" : "es"}` : "❌")
        : game === "trivia" ? String(x.s || "").split("").map(c => (c === "1" ? "🟩" : "🟥")).join("") + ` ${secs(x.t)}`
        : `${x.c} answer${x.c === 1 ? "" : "s"}`;
      lines.push(`<@${who.get(r.id)}> ${clean(r.n)} · ${what} · **${r.pts}**`);
    });
  }
  return lines;
}
async function whoOf(duids) {
  const who = new Map();
  for (const duid of duids) { const id = await playerOf(duid); if (id) who.set(id, duid); }
  return who;
}
// /today: the linked players seen in this Discord server
async function today(boards, guild) {
  const who = await whoOf((await store.metaGet("dguild:" + guild)) || []);
  if (!who.size) return null;
  const lines = await results(boards, who);
  return embed(`Today · ${R.todayKey()}`, lines.length ? lines : ["Nobody linked here has played today's games yet."], { url: SITE + "/", footer: { text: "Play the dailies at rushgames.cc" } });
}

/* ---------- sending to a channel, with the picture card when it can be drawn ---------- */
// a player's Discord avatar, kept for a few hours (null when they have none, or Discord can't be reached)
const avatars = new Map();
async function avatarOf(duid) {
  const had = avatars.get(duid);
  if (had && Date.now() - had.at < 6 * 3600e3) return had.img;
  let img = null;
  try {
    const u = await fetch(`${API}/users/${duid}`, { headers: { Authorization: "Bot " + BOT_TOKEN }, signal: AbortSignal.timeout(5000) });
    const j = u.ok ? await u.json() : null;
    if (j && /^[\w]{6,64}$/.test(j.avatar || "")) { const r = await fetch(`${CDN}/avatars/${duid}/${j.avatar}.png?size=128`, { signal: AbortSignal.timeout(5000) }); if (r.ok) img = Buffer.from(await r.arrayBuffer()); }
  } catch (e) {}
  if (avatars.size > 2000) avatars.clear();
  avatars.set(duid, { img, at: Date.now() });
  return img;
}
// the card for a day: who (player id -> Discord id) and day (from results), best first
async function drawCard(title, who, day) {
  if (!card.available() || !day.size) return null;
  const players = [...day].sort((a, b) => b[1].pts - a[1].pts).map(([id, p]) => Object.assign({ duid: who.get(id) }, p));
  await Promise.all(players.slice(0, card.MAX_PLAYERS).map(async p => { p.avatar = await avatarOf(p.duid); }));
  return card.render({ title, players });
}
function channelSend(method, url, body, png) {
  const headers = { Authorization: "Bot " + BOT_TOKEN };
  if (!png) return fetch(API + url, { method, headers: Object.assign(headers, { "Content-Type": "application/json" }), body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  const form = new FormData();
  form.append("payload_json", JSON.stringify(Object.assign({}, body, { attachments: [{ id: 0, filename: "rush-games.png" }] })));
  form.append("files[0]", new Blob([png], { type: "image/png" }), "rush-games.png");
  return fetch(API + url, { method, headers, body: form, signal: AbortSignal.timeout(20000) });
}

// the button under the channel's messages: pressing it opens the Activity (see handle)
const PLAY = { components: [{ type: 1, components: [{ type: 2, style: 1, label: "Play now!", custom_id: "rush-play" }] }] };
const ACTIVE_MAX = 5000;
// someone played in this channel today: its streak goes on (or starts again), and it gets tomorrow's recap
async function touchChannel(channel, day) {
  const ks = "dstreak:" + channel, s = (await store.metaGet(ks)) || { n: 0, last: "" };
  if (s.last === day) return s.n;
  s.n = s.last === R.ydayKey() ? s.n + 1 : 1; s.last = day;
  await store.metaPut(ks, s);
  const act = (await store.metaGet("dactive")) || {}, yd = R.ydayKey();
  for (const c of Object.keys(act)) if (act[c] < yd) delete act[c];
  act[channel] = day;
  const keys = Object.keys(act); while (keys.length > ACTIVE_MAX) delete act[keys.shift()];
  await store.metaPut("dactive", act);
  return s.n;
}
const fires = n => "🔥".repeat(n >= 7 ? 3 : n >= 3 ? 2 : 1);

// a new day's recap for one channel: the group's streak and how yesterday ended there (each player's points over all
// the dailies, best first, ties sharing a line)
async function postRecap(boards, channel, yd) {
  const who = await whoOf((await store.metaGet(`dchan:${channel}:${yd}`)) || []);
  if (!who.size) return false;
  const day = new Map(); await results(boards, who, "yday", day);
  const tot = new Map([...day].map(([id, p]) => [id, p.pts]));
  if (!tot.size) return false;
  const byPts = new Map();
  for (const [id, pts] of [...tot].sort((a, b) => b[1] - a[1])) byPts.set(pts, (byPts.get(pts) || []).concat(`<@${who.get(id)}>`));
  const lines = [...byPts].map(([pts, ids], i) => `${i === 0 ? "👑 " : ""}**${pts}** pts: ${ids.join(" ")}`);
  const s = (await store.metaGet("dstreak:" + channel)) || { n: 1 }, n = Math.max(1, s.n | 0);
  const head = n > 1 ? `**Your group is on a ${n} day streak!** ${fires(n)}` : "**Your group started a streak yesterday!** 🔥";
  const body = Object.assign({ content: `${head} Here are yesterday's results:\n${lines.join("\n")}`.slice(0, 1900), allowed_mentions: { parse: [] } }, PLAY);
  // as a reply to yesterday's summary ("X was playing"), when it's still there
  const prev = await store.metaGet(`dmsg:${channel}:${yd}`);
  if (prev) body.message_reference = { message_id: String(prev), fail_if_not_exists: false };
  const png = await drawCard(`Rush Games No. ${R.dailyNo() - 1}`, who, day);
  const r = await channelSend("POST", `/channels/${channel}/messages`, body, png);
  if (!r.ok) console.log("Discord: posting the recap failed", r.status);
  return r.ok;
}
// once per day, soon after the day changes (midnight Saudi time): a recap in every channel that played yesterday
let recapping = false;
async function recapRound() {
  if (recapping || !enabled() || !BOT_TOKEN) return 0;
  recapping = true;
  try {
    const day = R.todayKey(), done = await store.metaGet("drecap");
    if (done === day) return 0;
    await store.metaPut("drecap", day); // first, so a crash can't post twice
    if (!done || R.DAY - R.msToMidnight() > RECAP_HOURS * 36e5) return 0; // the very first run, or too late in the day
    const boards = require("./boards"), yd = R.ydayKey(), act = (await store.metaGet("dactive")) || {};
    let n = 0;
    for (const [channel, last] of Object.entries(act)) {
      if (last !== yd) continue;
      try { if (await postRecap(boards, channel, yd)) n++; } catch (e) { console.log("Discord recap", e.message); }
      await new Promise(r => setTimeout(r, 300)); // gently: Discord limits how fast a bot may post
    }
    if (n) console.log(`Discord: posted ${n} recap(s) for ${yd}`);
    return n;
  } catch (e) { console.log("Discord recap round", e.message); return 0; }
  finally { recapping = false; }
}
// in the evening: channels with a streak of two days or more that nobody has kept up today get one reminder
let reminding = false;
async function remindRound() {
  if (reminding || !enabled() || !BOT_TOKEN || REMIND_HOUR < 0) return 0;
  const left = R.msToMidnight(), hour = Math.floor((R.DAY - left) / 36e5);
  if (hour < REMIND_HOUR) return 0;
  reminding = true;
  try {
    const day = R.todayKey();
    if ((await store.metaGet("dremind")) === day) return 0;
    await store.metaPut("dremind", day); // first, so a crash can't post twice
    const yd = R.ydayKey(), act = (await store.metaGet("dactive")) || {}, hrs = Math.max(1, Math.round(left / 36e5));
    let n = 0;
    for (const [channel, last] of Object.entries(act)) {
      if (last !== yd) continue; // played today already, or the streak is over
      const s = await store.metaGet("dstreak:" + channel);
      if (!s || s.last !== yd || (s.n | 0) < 2) continue;
      const body = Object.assign({ content: `⏳ **Your group's ${s.n} day streak ends in ${hrs === 1 ? "about an hour" : hrs + " hours"}.** Nobody has played today's dailies here yet.`, allowed_mentions: { parse: [] } }, PLAY);
      try { const r = await channelSend("POST", `/channels/${channel}/messages`, body); if (r.ok) n++; else console.log("Discord: posting the reminder failed", r.status); } catch (e) { console.log("Discord reminder", e.message); }
      await new Promise(r => setTimeout(r, 300));
    }
    if (n) console.log(`Discord: posted ${n} streak reminder(s)`);
    return n;
  } catch (e) { console.log("Discord reminder round", e.message); return 0; }
  finally { reminding = false; }
}
function start() {
  if (!enabled() || !BOT_TOKEN) return;
  const round = () => recapRound().then(remindRound);
  setTimeout(round, 1500).unref();
  setInterval(round, 60e3).unref();
}

// the Activity's summary in a channel: one message per channel per day, edited as more people play
async function postSummary(boards, channel, duid) {
  if (!BOT_TOKEN) return false;
  const day = R.todayKey(), kc = `dchan:${channel}:${day}`, km = `dmsg:${channel}:${day}`;
  const streak = await touchChannel(channel, day);
  const list = (await store.metaGet(kc)) || [];
  if (!list.includes(duid)) { list.push(duid); while (list.length > 100) list.shift(); await store.metaPut(kc, list); }
  const who = await whoOf(list), cardDay = new Map(), lines = await results(boards, who, "today", cardDay);
  if (!lines.length) return false;
  // "Ann was playing" / "Ann and Ben were playing" / "Ann and 3 others were playing", latest first, nobody pinged
  const names = list.slice().reverse().map(d => `<@${d}>`);
  const playing = names.length === 1 ? `${names[0]} was playing` : names.length === 2 ? `${names[0]} and ${names[1]} were playing` : `${names[0]} and ${names.length - 1} others were playing`;
  const png = await drawCard(`Rush Games No. ${R.dailyNo()}`, who, cardDay);
  const body = Object.assign({ content: playing, allowed_mentions: { parse: [] } }, embed(`Rush Games · today's dailies`, lines, Object.assign({ url: SITE + "/", footer: { text: (streak > 1 ? `Group streak: ${streak} days ${fires(streak)} · ` : "") + day } }, png ? { image: { url: "attachment://rush-games.png" } } : {})), PLAY);
  const call = (method, url) => channelSend(method, url, body, png);
  const prev = await store.metaGet(km);
  if (prev) { const r = await call("PATCH", `/channels/${channel}/messages/${prev}`); if (r.ok) return true; if (r.status !== 404) return false; }
  const r = await call("POST", `/channels/${channel}/messages`);
  if (!r.ok) { console.log("Discord: posting the summary failed", r.status); return false; }
  const m = await r.json(); await store.metaPut(km, String(m.id));
  return true;
}

/* ---------- the commands as Discord sees them ---------- */
const BOARD_CHOICES = [["Overall", "overall"], ["Hangman (English)", "hangman-en"], ["Hangman (Arabic)", "hangman-ar"], ["Trivia", "trivia"], ["Harf (Arabic)", "harf-ar"], ["Harf (English)", "harf-en"]];
const COMMANDS = [
  { name: "link", description: "Link your Rush Games player (get the code from your profile on rushgames.cc)", options: [{ type: 3, name: "code", description: "The 6-letter code", required: true, min_length: 6, max_length: 6 }] },
  { name: "unlink", description: "Unlink your Rush Games player from this Discord account" },
  { name: "leaderboard", description: "This week's Rush Games leaderboard", options: [{ type: 3, name: "board", description: "Which board (default: overall)", required: false, choices: BOARD_CHOICES.map(([name, value]) => ({ name, value })) }] },
  { name: "streak", description: "Your streaks and this week's points" },
  { name: "today", description: "How the linked players in this server did in today's dailies" },
].map(c => Object.assign({ type: 1, integration_types: [0, 1], contexts: [0, 1, 2] }, c))
  // the Activity's own "Launch" command (Discord made it when Activities were switched on). Left to Discord, each
  // launch also posts a "Game Invitation" card in the channel that later reads "Game ended. Start a new one?"; handled
  // here (handler 1) the Activity just opens. It has to be listed, or Discord refuses the whole list.
  .concat(CLIENT_SECRET ? [{ type: 4, handler: 1, name: "launch", description: "Launch Rush Games", integration_types: [0, 1], contexts: [0, 1, 2] }] : []);

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
    // the token, so the Activity can play as this player (only if the player wasn't merged since the code was made)
    if (c.t && uid === String(c.u)) await store.metaPut("dlinktok:" + uid, c.t);
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

/* ---------- the Activity ---------- */
async function linkedPlayer(boards, duid) {
  const uid = await playerOf(duid);
  if (!uid) return { player: null, relink: false };
  const token = unseal(await store.metaGet("dlinktok:" + uid));
  if (!token) return { player: null, relink: true };
  const p = await boards.player(uid, true).catch(() => null);
  return { player: { uid, token, n: (p && p.n) || "", c: (p && p.c) || "", tag: R.tagOf(uid) }, relink: false };
}
async function activity(what, req, res, { send, readJson, ip }, limits, boards) {
  // Activity players reach us through Discord's proxy, so many share an address: the limits here are per Discord account
  if (!limits.take("dca|" + ip, 300, 60)) { send(res, 429, { error: "Too many requests. Try again in a minute." }); return; }
  const body = (await readJson(req)) || {};
  if (what === "activity") {
    if (!CLIENT_SECRET) { send(res, 503, { error: "The Discord activity isn't set up yet" }); return; }
    const code = String(body.code || "");
    if (!/^[\w-]{10,100}$/.test(code)) { send(res, 400, { error: "Bad code" }); return; }
    let tok, me;
    try {
      const r = await fetch(OAUTH + "/oauth2/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: APP_ID, client_secret: CLIENT_SECRET, grant_type: "authorization_code", code }), signal: AbortSignal.timeout(10000) });
      tok = await r.json();
      if (!r.ok || !tok.access_token) { send(res, 401, { error: "Discord didn't accept the login" }); return; }
      const u = await fetch(OAUTH + "/users/@me", { headers: { Authorization: "Bearer " + tok.access_token }, signal: AbortSignal.timeout(10000) });
      me = await u.json();
      if (!u.ok || !/^\d{5,25}$/.test(String(me.id || ""))) { send(res, 401, { error: "Couldn't read your Discord account" }); return; }
    } catch (e) { console.log("Discord activity login", e.message, e.cause && (e.cause.code || e.cause.message)); send(res, 502, { error: "Couldn't reach Discord" }); return; }
    const duid = String(me.id);
    send(res, 200, Object.assign({ access_token: tok.access_token, me: { id: duid, name: clean(me.global_name || me.username) }, ds: makePass(duid) }, await linkedPlayer(boards, duid)));
    return;
  }
  const duid = readPass(body.ds);
  if (!duid) { send(res, 401, { error: "Open the activity again" }); return; }
  if (!limits.take("dcu|" + duid, 30, 10)) { send(res, 429, { error: "Too many requests. Slow down a little." }); return; }
  if (what === "me") { send(res, 200, await linkedPlayer(boards, duid)); return; }
  if (what === "claim") {
    const uid = String(body.uid || "");
    if (!ident.isUid(uid) || typeof body.token !== "string" || body.token.length < 16) { send(res, 400, { error: "Bad player" }); return; }
    const o = await ident.owner(uid, ident.hashToken(body.token));
    if (!o.ok) { send(res, 403, { error: "This player belongs to another device" }); return; }
    if (await playerOf(duid)) { send(res, 409, { error: "This Discord account is already linked" }); return; }
    await unlinkPlayer(uid);
    await store.metaPut("dlink:" + duid, uid); await store.metaPut("dlinkp:" + uid, duid); await store.metaPut("dlinktok:" + uid, seal(body.token));
    send(res, 200, await linkedPlayer(boards, duid));
    return;
  }
  if (what === "home") {
    const guild = body.guild ? String(body.guild) : null, tab = body.tab === "season" ? "season" : "week";
    if (guild && !/^\d{5,25}$/.test(guild)) { send(res, 400, { error: "Bad server" }); return; }
    const uid = await playerOf(duid), today = {};
    if (uid) {
      await seenIn(guild, duid);
      for (const [game, lg] of BOARDS) {
        const row = (await boards.board(game, lg, "today", "")).rows.find(r => r.id === uid);
        if (row) today[game + (lg ? "-" + lg : "")] = { pts: row.pts, ok: game !== "hangman" || !!(row.d && row.d.ok) };
      }
    }
    const slim = h => ({ tab: h.tab, wk: h.wk, wleft: h.wleft, se: h.se, day: h.day, len: h.len, games: h.games, overall: h.overall, me: h.me });
    const all = slim(await boards.hub(uid || "", tab));
    const who = guild ? await whoOf((await store.metaGet("dguild:" + guild)) || []) : null;
    const server = who ? slim(await boards.hub(uid || "", tab, new Set(who.keys()))) : null;
    send(res, 200, { no: R.dailyNo(), today, all, server });
    return;
  }
  if (what === "played") {
    const channel = String(body.channel || ""), guild = body.guild ? String(body.guild) : null;
    if (!/^\d{5,25}$/.test(channel) || (guild && !/^\d{5,25}$/.test(guild))) { send(res, 400, { error: "Bad channel" }); return; }
    if (!(await playerOf(duid))) { send(res, 200, { posted: false }); return; }
    await seenIn(guild, duid);
    let posted = false;
    try { posted = await postSummary(boards, channel, duid); } catch (e) { console.log("Discord summary", e.message); }
    send(res, 200, { posted });
    return;
  }
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
    // the "Play now!" button under the channel's messages: Discord opens the Activity for whoever pressed it
    if (i.type === 3) { if (i.data && i.data.custom_id === "rush-play") send(res, 200, { type: 12 }); else send(res, 400, { error: "Unsupported" }); return true; }
    if (i.type !== 2) { send(res, 400, { error: "Unsupported" }); return true; }
    if (i.data && (i.data.type === 4 || i.data.name === "launch")) { send(res, 200, { type: 12 }); return true; } // "Launch": open the Activity
    try { send(res, 200, await command(i, boards)); }
    catch (e) { console.error("Discord command", e); send(res, 200, say("Something went wrong. Try again in a moment.")); }
    return true;
  }
  if (req.method !== "POST") return false;
  if (/^\/api\/discord\/(activity|me|claim|played|home)$/.test(p)) { await activity(p.slice(13), req, res, { send, readJson, ip }, limits, boards); return true; }
  if (!limits.take("dc|" + ip, 20, 10)) { send(res, 429, { error: "Too many requests. Slow down a little." }); return true; }
  const body = await readJson(req), uid = await owned(body);
  if (!uid) { send(res, 403, { error: "This player belongs to another device" }); return true; }
  if (p === "/api/discord/code") {
    const prev = await store.metaGet("dcodep:" + uid);
    if (prev && prev.code) await store.metaPut("dcode:" + prev.code, null); // only the newest code works
    let code; for (let n = 0; n < 5; n++) { code = newCode(); if (!(await store.metaGet("dcode:" + code))) break; }
    const exp = Date.now() + CODE_MS;
    await store.metaPut("dcode:" + code, { u: uid, exp, t: seal(body.token) }); await store.metaPut("dcodep:" + uid, { code, exp });
    send(res, 200, { code, exp, ms: CODE_MS });
    return true;
  }
  if (p === "/api/discord/status") { send(res, 200, { linked: !!(await store.metaGet("dlinkp:" + uid)) }); return true; }
  if (p === "/api/discord/unlink") { await unlinkPlayer(uid); send(res, 200, { ok: true }); return true; }
  return false;
}

module.exports = { handle, register, start, enabled, verify, COMMANDS, makePass, readPass };
