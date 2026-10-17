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
const fs = require("fs");
const path = require("path");

function jsonStore() {
  const file = process.env.DATA_FILE || path.join(__dirname, "data", "players.json");
  let db = { players: {}, trivia: {}, seen: {}, harf: {}, words: {} };
  let writing = Promise.resolve();
  const flush = () => (writing = writing.then(() => fs.promises.writeFile(file, JSON.stringify(db))).catch(e => console.error(e)));
  return {
    kind: "json file",
    async init() {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      try {
        const raw = JSON.parse(fs.readFileSync(file, "utf8"));
        // older files held only the Hangman players
        db = raw && raw.players ? { players: raw.players, trivia: raw.trivia || {}, seen: raw.seen || {}, harf: raw.harf || {}, words: raw.words || {} }
          : { players: raw || {}, trivia: {}, seen: {}, harf: {}, words: {} };
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
    async wordsGet(keys) { const m = new Map(); for (const k of keys) if (k in db.words) m.set(k, db.words[k]); return m; },
    async wordsPut(pairs) { for (const [k, v] of pairs) db.words[k] = v; return flush(); },

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
    async wordsGet(keys) {
      if (!keys.length) return new Map();
      const r = await pool.query("SELECT k, ok FROM harf_words WHERE k = ANY($1)", [keys]);
      return new Map(r.rows.map(x => [x.k, x.ok]));
    },
    async wordsPut(pairs) {
      if (!pairs.length) return;
      await pool.query(`INSERT INTO harf_words (k, ok) SELECT * FROM unnest($1::text[], $2::smallint[])
        ON CONFLICT (k) DO UPDATE SET ok = EXCLUDED.ok, at = now()`, [pairs.map(p => p[0]), pairs.map(p => p[1])]);
    },

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
for (const k of ["all", "get", "put", "tAll", "tGet", "tPut", "seenGet", "seenAll", "seenMark", "seenPrune", "hAll", "hGet", "hPut", "hSetData", "wordsGet", "wordsPut"]) store[k] = (...a) => impl[k](...a);

module.exports = store;
