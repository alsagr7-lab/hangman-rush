// Storage. Uses Postgres when DATABASE_URL is set, otherwise a JSON file.
// If Postgres can't be reached at start-up (for example the free Render database has expired),
// the server falls back to the JSON file instead of crashing, and logs a warning.
//
// Three kinds of data:
//   players         Hangman Rush daily records, written by each player's device
//   trivia_players  Trivia Rush daily records, written by the server (it times every answer)
//   trivia_seen     which room/practice questions each player has seen, and when
//   harf_players    Harf Rush daily records, written by the server (it times and checks every answer)
//   harf_words      verdicts on Harf Rush answers ("lang|category|word" -> valid or not), so each word is checked once
//   harf_ip         which player ids each network (a hashed IP address, never the address itself) used AI checks for, by month
//   harf_meta       small counters, such as this hour's Claude API calls, kept across restarts
//   auth_accounts   Google sign-ins: Google's account number -> player id and the player's token (encrypted)
const fs = require("fs");
const path = require("path");

function jsonStore() {
  const file = process.env.DATA_FILE || path.join(__dirname, "data", "players.json");
  let db = { players: {}, trivia: {}, seen: {}, harf: {}, words: {}, ip: {}, meta: {}, acct: {} };
  let writing = Promise.resolve();
  const flush = () => (writing = writing.then(() => fs.promises.writeFile(file, JSON.stringify(db))).catch(e => console.error(e)));
  return {
    kind: "json file",
    async init() {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      try {
        const raw = JSON.parse(fs.readFileSync(file, "utf8"));
        // older files held only the Hangman players
        db = raw && raw.players ? { players: raw.players, trivia: raw.trivia || {}, seen: raw.seen || {}, harf: raw.harf || {}, words: raw.words || {}, ip: raw.ip || {}, meta: raw.meta || {}, acct: raw.acct || {} }
          : { players: raw || {}, trivia: {}, seen: {}, harf: {}, words: {}, ip: {}, meta: {}, acct: {} };
      } catch { /* fresh file */ }
    },
    async all() { return Object.entries(db.players).map(([id, r]) => ({ id, data: r.data })); },
    async get(id) { return db.players[id] ? { id, ...db.players[id] } : null; },
    async put(id, token, data) { db.players[id] = { token, data }; return flush(); },

    async tAll() { return Object.entries(db.trivia).map(([id, r]) => ({ id, data: r.data })); },
    async tGet(id) { return db.trivia[id] ? { id, ...db.trivia[id] } : null; },
    async tPut(id, token, data) { db.trivia[id] = { token, data }; return flush(); },

    async hAll() { return Object.entries(db.harf).map(([id, r]) => ({ id, data: r.data })); },
    async hGet(id) { return db.harf[id] ? { id, ...db.harf[id] } : null; },
    async hPut(id, token, data) { db.harf[id] = { token, data }; return flush(); },
    async hSetData(id, data) { if (db.harf[id]) { db.harf[id].data = data; return flush(); } },
    async hDel(id) { delete db.harf[id]; return flush(); },
    // verdicts: {ok: 1/0, fix: correct spelling or null}; older files hold a bare 1/0
    async wordsGet(keys) { const m = new Map(); for (const k of keys) if (k in db.words) { const v = db.words[k]; m.set(k, typeof v === "object" && v ? { ok: Number(v.ok) ? 1 : 0, fix: v.fix || null } : { ok: Number(v) ? 1 : 0, fix: null }); } return m; },
    async wordsPut(pairs) { for (const [k, v] of pairs) db.words[k] = { ok: v.ok ? 1 : 0, fix: v.fix || null, at: Date.now() }; return flush(); },
    async wordsRecent(limit) {
      return Object.entries(db.words).map(([k, v]) => ({ k, ok: typeof v === "object" ? Number(v.ok) : Number(v), fix: (v && v.fix) || null, at: (v && v.at) || 0 }))
        .sort((a, b) => b.at - a.at).slice(0, limit);
    },
    // clears verdicts saved as valid with no correction since a time; -> their keys
    async wordsPurge(sinceMs) {
      const out = [];
      for (const [k, v] of Object.entries(db.words)) if (v && typeof v === "object" && Number(v.ok) === 1 && !v.fix && (v.at || 0) >= sinceMs) { out.push(k); delete db.words[k]; }
      await flush(); return out;
    },
    async ipUids(ip, month) { return ((db.ip[month] || {})[ip]) || []; },
    async ipAdd(ip, month, uid) {
      for (const m of Object.keys(db.ip)) if (m < month) delete db.ip[m]; // only this month matters
      const l = ((db.ip[month] = db.ip[month] || {})[ip] = (db.ip[month][ip] || []));
      if (!l.includes(uid)) l.push(uid);
      return flush();
    },
    async metaGet(k) { return k in db.meta ? db.meta[k] : null; },
    async metaPut(k, v) { db.meta[k] = v; return flush(); },
    async acctGet(k) { return db.acct[k] ? { k, ...db.acct[k] } : null; },
    async acctByUid(uid) { const e = Object.entries(db.acct).find(([, v]) => v.uid === uid); return e ? { k: e[0], ...e[1] } : null; },
    async acctPut(k, uid, tok) { db.acct[k] = { uid, tok, at: Date.now() }; return flush(); },
    // entries whose key starts with prefix and sorts at or after from -> [{k, v}]
    async metaSince(prefix, from) { return Object.entries(db.meta).filter(([k]) => k.startsWith(prefix) && k >= from).map(([k, v]) => ({ k, v })); },
    async metaPruneBefore(prefix, before) { for (const k of Object.keys(db.meta)) if (k.startsWith(prefix) && k < before) delete db.meta[k]; return flush(); },

    // -> Map(qid -> latest seen time in ms) across these players, only rows newer than sinceMs
    async seenGet(uids, sinceMs) {
      const out = new Map();
      for (const u of uids) for (const [q, ts] of Object.entries(db.seen[u] || {})) if (ts >= sinceMs && !(out.get(q) >= ts)) out.set(q, ts);
      return out;
    },
    async seenAll(uids) { return this.seenGet(uids, 0); },
    async seenMark(uids, qids, now) {
      for (const u of uids) { const m = (db.seen[u] = db.seen[u] || {}); for (const q of qids) m[q] = now; }
      return flush();
    },
    async seenPrune(beforeMs) {
      for (const u of Object.keys(db.seen)) {
        const m = db.seen[u];
        for (const q of Object.keys(m)) if (m[q] < beforeMs) delete m[q];
        if (!Object.keys(m).length) delete db.seen[u];
      }
      return flush();
    },
  };
}

function pgStore(url) {
  const { Pool } = require("pg");
  // Render's internal database hostnames have no dot and don't use SSL; external ones do.
  let host = "";
  try { host = new URL(url).hostname; } catch {}
  const ssl = process.env.PGSSL === "off" || (host && !host.includes(".")) ? false : { rejectUnauthorized: false };
  const pool = new Pool({ connectionString: url, ssl, connectionTimeoutMillis: 8000, max: 5 });
  pool.on("error", e => console.error("Postgres error:", e.message));
  const upsert = table => (id, token, data) => pool.query(
    `INSERT INTO ${table} (id, token, data, updated_at) VALUES ($1,$2,$3,now())
     ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data, updated_at=now()`, [id, token, data]);
  return {
    kind: "postgres",
    async init() {
      await pool.query(`CREATE TABLE IF NOT EXISTS players (
        id TEXT PRIMARY KEY, token TEXT NOT NULL, data JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT now())`);
      await pool.query(`CREATE TABLE IF NOT EXISTS trivia_players (
        id TEXT PRIMARY KEY, token TEXT NOT NULL, data JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT now())`);
      await pool.query(`CREATE TABLE IF NOT EXISTS trivia_seen (
        uid TEXT NOT NULL, qid TEXT NOT NULL, seen_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (uid, qid))`);
      await pool.query(`CREATE INDEX IF NOT EXISTS trivia_seen_at ON trivia_seen (seen_at)`);
      await pool.query(`CREATE TABLE IF NOT EXISTS harf_players (
        id TEXT PRIMARY KEY, token TEXT NOT NULL, data JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT now())`);
      await pool.query(`CREATE TABLE IF NOT EXISTS harf_words (
        k TEXT PRIMARY KEY, ok SMALLINT NOT NULL, at TIMESTAMPTZ DEFAULT now())`);
      await pool.query(`ALTER TABLE harf_words ADD COLUMN IF NOT EXISTS fix TEXT`);
      await pool.query(`CREATE TABLE IF NOT EXISTS harf_ip (
        ip TEXT NOT NULL, month TEXT NOT NULL, uid TEXT NOT NULL, PRIMARY KEY (ip, month, uid))`);
      await pool.query(`CREATE TABLE IF NOT EXISTS harf_meta (k TEXT PRIMARY KEY, v JSONB NOT NULL)`);
      await pool.query(`CREATE TABLE IF NOT EXISTS auth_accounts (
        k TEXT PRIMARY KEY, uid TEXT NOT NULL UNIQUE, tok TEXT NOT NULL, at TIMESTAMPTZ DEFAULT now())`);
    },
    async all() { return (await pool.query("SELECT id, data FROM players ORDER BY updated_at DESC LIMIT 500")).rows; },
    async get(id) { return (await pool.query("SELECT id, token, data FROM players WHERE id=$1", [id])).rows[0] || null; },
    put: upsert("players"),

    async tAll() { return (await pool.query("SELECT id, data FROM trivia_players ORDER BY updated_at DESC LIMIT 500")).rows; },
    async tGet(id) { return (await pool.query("SELECT id, token, data FROM trivia_players WHERE id=$1", [id])).rows[0] || null; },
    tPut: upsert("trivia_players"),

    async hAll() { return (await pool.query("SELECT id, data FROM harf_players ORDER BY updated_at DESC LIMIT 1000")).rows; },
    async hGet(id) { return (await pool.query("SELECT id, token, data FROM harf_players WHERE id=$1", [id])).rows[0] || null; },
    hPut: upsert("harf_players"),
    async hSetData(id, data) { await pool.query("UPDATE harf_players SET data=$2 WHERE id=$1", [id, data]); },
    async hDel(id) { await pool.query("DELETE FROM harf_players WHERE id=$1", [id]); },
    async wordsGet(keys) {
      if (!keys.length) return new Map();
      const r = await pool.query("SELECT k, ok, fix FROM harf_words WHERE k = ANY($1)", [keys]);
      return new Map(r.rows.map(x => [x.k, { ok: Number(x.ok) ? 1 : 0, fix: x.fix || null }]));
    },
    async wordsPut(pairs) {
      if (!pairs.length) return;
      await pool.query(`INSERT INTO harf_words (k, ok, fix) SELECT * FROM unnest($1::text[], $2::smallint[], $3::text[])
        ON CONFLICT (k) DO UPDATE SET ok = EXCLUDED.ok, fix = EXCLUDED.fix, at = now()`,
        [pairs.map(p => p[0]), pairs.map(p => (p[1].ok ? 1 : 0)), pairs.map(p => p[1].fix || null)]);
    },
    async wordsRecent(limit) {
      const r = await pool.query("SELECT k, ok, fix, at FROM harf_words ORDER BY at DESC LIMIT $1", [limit]);
      return r.rows.map(x => ({ k: x.k, ok: Number(x.ok), fix: x.fix || null, at: new Date(x.at).getTime() }));
    },
    async wordsPurge(sinceMs) {
      const r = await pool.query("DELETE FROM harf_words WHERE ok = 1 AND fix IS NULL AND at >= $1 RETURNING k", [new Date(sinceMs)]);
      return r.rows.map(x => x.k);
    },
    async ipUids(ip, month) { return (await pool.query("SELECT uid FROM harf_ip WHERE ip=$1 AND month=$2", [ip, month])).rows.map(x => x.uid); },
    async ipAdd(ip, month, uid) {
      await pool.query("INSERT INTO harf_ip (ip, month, uid) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [ip, month, uid]);
      await pool.query("DELETE FROM harf_ip WHERE month < $1", [month]);
    },
    async metaGet(k) { const r = await pool.query("SELECT v FROM harf_meta WHERE k=$1", [k]); return r.rows[0] ? r.rows[0].v : null; },
    async metaPut(k, v) { await pool.query("INSERT INTO harf_meta (k, v) VALUES ($1,$2) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v", [k, JSON.stringify(v)]); },
    async metaSince(prefix, from) {
      return (await pool.query("SELECT k, v FROM harf_meta WHERE k LIKE $1 AND k >= $2", [prefix + "%", from])).rows;
    },
    async acctGet(k) { return (await pool.query("SELECT k, uid, tok FROM auth_accounts WHERE k=$1", [k])).rows[0] || null; },
    async acctByUid(uid) { return (await pool.query("SELECT k, uid FROM auth_accounts WHERE uid=$1", [uid])).rows[0] || null; },
    async acctPut(k, uid, tok) { await pool.query("INSERT INTO auth_accounts (k, uid, tok) VALUES ($1,$2,$3)", [k, uid, tok]); },
    async metaPruneBefore(prefix, before) { await pool.query("DELETE FROM harf_meta WHERE k LIKE $1 AND k < $2", [prefix + "%", before]); },

    async seenGet(uids, sinceMs) {
      const r = await pool.query(
        `SELECT qid, max(seen_at) AS ts FROM trivia_seen WHERE uid = ANY($1) AND seen_at >= $2 GROUP BY qid`,
        [uids, new Date(sinceMs)]);
      return new Map(r.rows.map(x => [x.qid, new Date(x.ts).getTime()]));
    },
    async seenAll(uids) { return this.seenGet(uids, 0); },
    async seenMark(uids, qids, now) {
      if (!uids.length || !qids.length) return;
      // one statement: every (uid, qid) pair, refreshed if it already exists
      await pool.query(
        `INSERT INTO trivia_seen (uid, qid, seen_at)
         SELECT u, q, $3 FROM unnest($1::text[]) AS u CROSS JOIN unnest($2::text[]) AS q
         ON CONFLICT (uid, qid) DO UPDATE SET seen_at = EXCLUDED.seen_at`,
        [uids, qids, new Date(now)]);
    },
    async seenPrune(beforeMs) { await pool.query("DELETE FROM trivia_seen WHERE seen_at < $1", [new Date(beforeMs)]); },
  };
}

let impl = null;
const store = {
  get kind() { return impl ? impl.kind : "starting"; },
  async init() {
    if (process.env.DATABASE_URL) {
      const pg = pgStore(process.env.DATABASE_URL);
      try { await pg.init(); impl = pg; return; }
      catch (e) { console.warn("Postgres unavailable, using the JSON file instead:", e.message); }
    }
    impl = jsonStore();
    await impl.init();
  },
};
for (const k of ["all", "get", "put", "tAll", "tGet", "tPut", "seenGet", "seenAll", "seenMark", "seenPrune", "hAll", "hGet", "hPut", "hSetData", "hDel", "wordsGet", "wordsPut", "wordsRecent", "wordsPurge", "ipUids", "ipAdd", "metaGet", "metaPut", "metaSince", "metaPruneBefore", "acctGet", "acctByUid", "acctPut"]) store[k] = (...a) => impl[k](...a);

module.exports = store;
