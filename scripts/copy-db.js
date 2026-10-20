// Copies the whole game database to a new Postgres (the move to the paid Frankfurt database).
//
//   FROM_URL=postgres://...old... TO_URL=postgres://...new... node scripts/copy-db.js
//
// Use the databases' External URLs from Render. Switch the old server to read-only first (MOVE_MODE=readonly, or
// POST /api/move), so nothing changes while it copies.
//
// Safe by design:
//   - refuses to run when the new database already holds any game data (it never overwrites or merges)
//   - creates the tables with the server's own set-up code, then copies every row of every table
//   - checks each table's row count matches at the end and exits with an error if any differs
//   - only reads from the old database
const { Pool } = require("pg");
const path = require("path");

const TABLES = ["players", "trivia_players", "trivia_seen", "harf_players", "harf_words", "harf_archive", "harf_ip", "harf_meta", "auth_accounts"];
const BATCH = 1000;

function pool(url) {
  let host = ""; try { host = new URL(url).hostname; } catch {}
  const ssl = process.env.PGSSL === "off" || (host && !host.includes(".")) || host === "localhost" || host === "127.0.0.1" ? false : { rejectUnauthorized: false };
  return new Pool({ connectionString: url, ssl, max: 2, connectionTimeoutMillis: 15000 });
}
const count = async (db, t) => Number((await db.query(`SELECT count(*)::bigint AS n FROM ${t}`)).rows[0].n);
async function exists(db, t) { return !!(await db.query("SELECT to_regclass($1) AS r", ["public." + t])).rows[0].r; }

async function copy({ from, to, log = console.log }) {
  if (!from || !to) throw new Error("Set FROM_URL (old database) and TO_URL (new database).");
  if (from === to) throw new Error("FROM_URL and TO_URL are the same database.");
  const src = pool(from), dst = pool(to);
  try {
    for (const t of TABLES) if (!(await exists(src, t))) throw new Error(`The old database has no ${t} table. Is FROM_URL right?`);
    // never copy into a database that already has game data
    for (const t of TABLES) if ((await exists(dst, t)) && (await count(dst, t)) > 0) throw new Error(`The new database already has rows in ${t}. Refusing to overwrite it.`);
    // the server's own table set-up, pointed at the new database
    process.env.DATABASE_URL = to; process.env.PG_RETRY_MS = "";
    delete require.cache[require.resolve(path.join(__dirname, "..", "store.js"))];
    const store = require(path.join(__dirname, "..", "store.js"));
    await store.init();
    if (store.kind !== "postgres") throw new Error("Couldn't set up the tables in the new database.");

    const result = [];
    for (const t of TABLES) {
      const total = await count(src, t);
      // primary key columns, for a stable order across batches
      const pk = (await src.query(`SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = $1::regclass AND i.indisprimary ORDER BY a.attnum`, [t])).rows.map(r => r.attname);
      const cols = (await src.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`, [t])).rows.map(r => r.column_name);
      const list = cols.map(c => `"${c}"`).join(", ");
      let done = 0;
      for (let off = 0; off < total; off += BATCH) {
        const rows = (await src.query(`SELECT row_to_json(x) AS j FROM (SELECT ${list} FROM ${t} ORDER BY ${pk.map(c => `"${c}"`).join(", ")} LIMIT ${BATCH} OFFSET ${off}) x`)).rows.map(r => r.j);
        if (!rows.length) break;
        await dst.query(`INSERT INTO ${t} (${list}) SELECT ${list} FROM json_populate_recordset(null::${t}, $1::json)`, [JSON.stringify(rows)]);
        done += rows.length;
      }
      const after = await count(dst, t);
      result.push({ t, old: total, new: after, ok: after === total });
      log(`${after === total ? "ok  " : "DIFF"} ${t}: ${total} -> ${after}`);
    }
    const bad = result.filter(r => !r.ok);
    if (bad.length) throw new Error("Row counts differ for: " + bad.map(r => r.t).join(", "));
    log("All tables copied and counts match.");
    return result;
  } finally { await src.end().catch(() => {}); await dst.end().catch(() => {}); }
}

module.exports = { copy, TABLES };

if (require.main === module) {
  copy({ from: process.env.FROM_URL, to: process.env.TO_URL }).then(() => process.exit(0)).catch(e => { console.error("Copy failed:", e.message); process.exit(1); });
}
