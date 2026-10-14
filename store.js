// Leaderboard storage. Uses Postgres when DATABASE_URL is set, otherwise a JSON file.
// Note: on Render's free plan the disk is wiped on every deploy or restart, so the JSON file
// is fine for trying things out but streaks will reset. Add a Postgres database for keeps.
const fs = require("fs");
const path = require("path");

let impl;

if (process.env.DATABASE_URL) {
  const { Pool } = require("pg");
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === "off" ? false : { rejectUnauthorized: false },
  });
  impl = {
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
} else {
  const file = process.env.DATA_FILE || path.join(__dirname, "data", "players.json");
  let rows = {};
  let writing = Promise.resolve();
  impl = {
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

module.exports = impl;
