// Leaderboard storage. Uses Postgres when DATABASE_URL is set, otherwise a JSON file.
// If Postgres can't be reached at start-up (for example the free Render database has expired),
// the server falls back to the JSON file instead of crashing, and logs a warning.
const fs = require("fs");
const path = require("path");

function jsonStore() {
  const file = process.env.DATA_FILE || path.join(__dirname, "data", "players.json");
  let rows = {};
  let writing = Promise.resolve();
  return {
    kind: "json file",
    async init() {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      try { rows = JSON.parse(fs.readFileSync(file, "utf8")); } catch { rows = {}; }
    },
    async all() { return Object.entries(rows).map(([id, r]) => ({ id, data: r.data })); },
    async get(id) { return rows[id] ? { id, ...rows[id] } : null; },
    async put(id, token, data) {
      rows[id] = { token, data };
      writing = writing.then(() => fs.promises.writeFile(file, JSON.stringify(rows))).catch(e => console.error(e));
      return writing;
    },
  };
}

function pgStore(url) {
  const { Pool } = require("pg");
  // Render's internal database hostnames have no dot and don't use SSL; external ones do.
  let host = "";
  try { host = new URL(url).hostname; } catch {}
  const ssl = process.env.PGSSL === "off" || (host && !host.includes(".")) ? false : { rejectUnauthorized: false };
  const pool = new Pool({ connectionString: url, ssl, connectionTimeoutMillis: 8000 });
  pool.on("error", e => console.error("Postgres error:", e.message));
  return {
    kind: "postgres",
    async init() {
      await pool.query(`CREATE TABLE IF NOT EXISTS players (
        id TEXT PRIMARY KEY, token TEXT NOT NULL, data JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT now())`);
    },
    async all() { return (await pool.query("SELECT id, data FROM players ORDER BY updated_at DESC LIMIT 500")).rows; },
    async get(id) { return (await pool.query("SELECT id, token, data FROM players WHERE id=$1", [id])).rows[0] || null; },
    async put(id, token, data) {
      await pool.query(
        `INSERT INTO players (id, token, data, updated_at) VALUES ($1,$2,$3,now())
         ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data, updated_at=now()`,
        [id, token, data]);
    },
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
  all: (...a) => impl.all(...a),
  get: (...a) => impl.get(...a),
  put: (...a) => impl.put(...a),
};

module.exports = store;
