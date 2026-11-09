// Discord (discord.js): signed slash commands, and linking a Discord account to a player with a code.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const R = require("../site/shared/rules");
const { startServer, hashToken } = require("./helper");

const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const PUB = publicKey.export({ format: "der", type: "spki" }).subarray(12).toString("hex");
const se = R.curSeason(), today = R.todayKey();
const TOK = id => "token-" + id.replace(/_(ar|en)$/, "");
const rec = (id, n, h) => [id, { token: hashToken(TOK(id)), data: { n, c: "#d93c30", se, played: 1, wins: 1, streak: 3, best: 3, ls: today, h } }];
const players = Object.fromEntries([rec("p_discA00001", "Ann", { [today]: { ok: 1, pts: 250, t: 42300, m: 1 } }), rec("p_discB00001", "Ben", { [today]: { ok: 0, pts: 0, t: 90000, m: 6 } })]);

let srv, BASE;
before(async () => { srv = await startServer({ seed: { players, trivia: {}, harf: {} }, env: { DISCORD_APP_ID: "123456789", DISCORD_PUBLIC_KEY: PUB } }); BASE = srv.base; });
after(() => srv.stop());

const post = async (p, body, code = 200) => { const r = await fetch(BASE + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); assert.equal(r.status, code, p); return r.json(); };
async function discord(body, { sign = true, ts = Math.floor(Date.now() / 1000) } = {}) {
  const raw = JSON.stringify(body), h = { "Content-Type": "application/json", "X-Signature-Timestamp": String(ts) };
  h["X-Signature-Ed25519"] = sign ? crypto.sign(null, Buffer.from(ts + raw), privateKey).toString("hex") : "00".repeat(64);
  const r = await fetch(BASE + "/api/discord/interactions", { method: "POST", headers: h, body: raw });
  return { status: r.status, body: await r.json() };
}
const cmd = (name, user, opts = {}, guild = "900000000000000001") => discord({ type: 2, guild_id: guild, member: { user: { id: user } }, data: { name, options: Object.entries(opts).map(([n, value]) => ({ name: n, type: 3, value })) } });
const text = r => r.body.data.content || JSON.stringify(r.body.data.embeds);

test("requests not signed by Discord, or too old, are refused; Discord's ping is answered", async () => {
  assert.equal((await discord({ type: 1 }, { sign: false })).status, 401);
  assert.equal((await discord({ type: 1 }, { ts: Math.floor(Date.now() / 1000) - 3600 })).status, 401);
  const r = await discord({ type: 1 });
  assert.equal(r.status, 200); assert.deepEqual(r.body, { type: 1 });
});

test("a code from the player's own device links Discord; only the owner can get one", async () => {
  await post("/api/discord/code", { uid: "p_discA00001", token: "wrong-token-wrong-token" }, 403);
  assert.equal((await post("/api/discord/status", { uid: "p_discA00001", token: TOK("p_discA00001") })).linked, false);
  const old = await post("/api/discord/code", { uid: "p_discA00001", token: TOK("p_discA00001") });
  const { code } = await post("/api/discord/code", { uid: "p_discA00001", token: TOK("p_discA00001") });
  assert.match(code, /^[A-Z2-9]{6}$/);
  // only the newest code works, and a code works once
  assert.match(text(await cmd("link", "111111111111", { code: old.code })), /didn't work/);
  assert.match(text(await cmd("link", "111111111111", { code: code.toLowerCase() })), /Linked! You're \*\*Ann\*\*/);
  assert.match(text(await cmd("link", "222222222222", { code })), /didn't work/);
  assert.equal((await post("/api/discord/status", { uid: "p_discA00001", token: TOK("p_discA00001") })).linked, true);
  const prof = await post("/api/player", { id: "p_discA00001", uid: "p_discA00001", token: TOK("p_discA00001") });
  assert.equal(prof.discord, true);
});

test("/streak, /leaderboard and /today show points and times, never ephemeral for shared ones", async () => {
  const s = await cmd("streak", "111111111111");
  assert.match(text(s), /Ann/); assert.match(text(s), /streak 3/); assert.equal(s.body.data.flags, undefined);
  assert.match(text(await cmd("streak", "333333333333")), /Link your player first/);
  const lb = await cmd("leaderboard", "333333333333", { board: "hangman-en" });
  assert.match(text(lb), /Ann/); assert.match(text(lb), /250 pts/);
  const t = await cmd("today", "111111111111");
  assert.match(text(t), /<@111111111111> Ann · ✅ 42\.3s, 1 miss · \*\*250\*\*/);
  assert.doesNotMatch(text(t), /Ben/); // not linked here
  assert.deepEqual(t.body.data.allowed_mentions, { parse: [] }); // nobody gets pinged
});

test("unlinking from the site or from Discord", async () => {
  await post("/api/discord/unlink", { uid: "p_discA00001", token: TOK("p_discA00001") });
  assert.equal((await post("/api/discord/status", { uid: "p_discA00001", token: TOK("p_discA00001") })).linked, false);
  assert.match(text(await cmd("unlink", "111111111111")), /isn't linked/);
});

test("without the Discord settings the bot is off", async () => {
  const off = await startServer({});
  try { assert.equal((await fetch(off.base + "/api/discord/interactions", { method: "POST", body: "{}" })).status, 404); }
  finally { await off.stop(); }
});
