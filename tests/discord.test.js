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

// a stand-in for Discord's own API: OAuth login and posting messages
const http = require("node:http");
const sent = [];
let fake, FAKE;
const USERS = { "code-ann-0001": "111111111111", "code-new-0001": "555555555555", "code-old-0001": "666666666666" };
before(async () => {
  fake = http.createServer((req, res) => {
    let b = ""; req.on("data", c => (b += c)); req.on("end", () => {
      const j = (code, o) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
      if (req.url === "/oauth2/token") { const code = new URLSearchParams(b).get("code"); return USERS[code] ? j(200, { access_token: "at-" + USERS[code] }) : j(400, { error: "invalid_grant" }); }
      if (req.url === "/users/@me") return j(200, { id: String(req.headers.authorization || "").replace("Bearer at-", ""), global_name: "Tester" });
      const m = req.url.match(/^\/channels\/(\d+)\/messages(?:\/(\w+))?$/);
      if (m) { sent.push({ method: req.method, channel: m[1], id: m[2], body: JSON.parse(b) }); return j(200, { id: "m" + sent.length }); }
      j(404, {});
    });
  });
  await new Promise(r => fake.listen(0, "127.0.0.1", r));
  FAKE = "http://127.0.0.1:" + fake.address().port;
  srv = await startServer({ seed: { players, trivia: {}, harf: {} }, env: { DISCORD_APP_ID: "123456789", DISCORD_PUBLIC_KEY: PUB, DISCORD_CLIENT_SECRET: "secret", DISCORD_BOT_TOKEN: "bot", DISCORD_OAUTH: FAKE, DISCORD_API: FAKE } }); BASE = srv.base;
});
after(async () => { await srv.stop(); fake.close(); });
let srv, BASE;

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

test("the Activity: the linked player comes with its token, new players can start fresh, the channel gets one summary", async () => {
  // Ann linked from her profile in the test above: the Activity plays as her
  const a = await post("/api/discord/activity", { code: "code-ann-0001" });
  assert.equal(a.me.id, "111111111111"); assert.ok(a.ds); assert.equal(a.relink, false);
  assert.deepEqual([a.player.uid, a.player.token, a.player.n], ["p_discA00001", TOK("p_discA00001"), "Ann"]);
  // a Discord account nobody linked: no player; it can start fresh, once
  const n = await post("/api/discord/activity", { code: "code-new-0001" });
  assert.equal(n.player, null);
  const c = await post("/api/discord/claim", { ds: n.ds, uid: "p_discN00001", token: "fresh-token-fresh-token-1234" });
  assert.equal(c.player.uid, "p_discN00001");
  await post("/api/discord/claim", { ds: n.ds, uid: "p_discN00002", token: "fresh-token-fresh-token-5678" }, 409);
  assert.equal((await post("/api/discord/me", { ds: n.ds })).player.uid, "p_discN00001");
  // passes can't be made up, and bad codes are turned away
  await post("/api/discord/me", { ds: "111111111111.9999999999999.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }, 401);
  await post("/api/discord/activity", { code: "code-nobody-01" }, 401);
  // after a daily: one message, then the same message edited; scores only
  sent.length = 0;
  assert.equal((await post("/api/discord/played", { ds: a.ds, channel: "700000000000000001", guild: "900000000000000001" })).posted, true);
  assert.equal((await post("/api/discord/played", { ds: a.ds, channel: "700000000000000001", guild: "900000000000000001" })).posted, true);
  assert.deepEqual(sent.map(x => [x.method, x.id || ""]), [["POST", ""], ["PATCH", "m1"]]);
  assert.match(sent[0].body.embeds[0].description, /<@111111111111> Ann · ✅ 42\.3s, 1 miss · \*\*250\*\*/);
  assert.deepEqual(sent[0].body.allowed_mentions, { parse: [] });
});

test("a link made before tokens were kept asks to link again in the Activity", async () => {
  // Ben linked through /link without a sealed token (as links made before the Activity existed)
  const { code } = await post("/api/discord/code", { uid: "p_discB00001", token: TOK("p_discB00001") });
  await cmd("link", "666666666666", { code });
  const before = await post("/api/discord/activity", { code: "code-old-0001" });
  assert.equal(before.player.uid, "p_discB00001"); // the code from the profile now carries the token
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
