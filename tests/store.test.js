// The Postgres store, on a real database when TEST_DATABASE_URL is set (skipped otherwise):
//   - the "every player" reads return everyone written in the last 45 days, however many there are (they used to stop
//     at the newest 500 or 1000, so boards and the Harf nightly count quietly left players out);
//   - a write marked quiet (a Harf draft, a Hangman guess mid-word) leaves the boards' cache alone.
const { test, before, after } = require("node:test");
const assert = require("node:assert");

const URL = process.env.TEST_DATABASE_URL;
let store, pool;
before(async () => {
  if (!URL) return;
  process.env.DATABASE_URL = URL; process.env.PGSSL = "off";
  store = require("../store");
  await store.init();
  const { Pool } = require("pg");
  pool = new Pool({ connectionString: URL });
  for (const t of ["players", "trivia_players", "harf_players"]) await pool.query(`TRUNCATE ${t}`);
});
after(async () => { if (pool) await pool.end(); });

test("every player of the last 45 days is read, past the old 500/1000 limits; older ones are not", { skip: !URL && "TEST_DATABASE_URL not set" }, async () => {
  for (const [t, n] of [["players", 600], ["trivia_players", 600], ["harf_players", 1100]]) {
    await pool.query(`INSERT INTO ${t} (id, token, data, updated_at) SELECT 'p_' || g, 'x', '{}'::jsonb, now() - (g % 40) * interval '1 day' FROM generate_series(1, $1) g`, [n]);
    await pool.query(`INSERT INTO ${t} (id, token, data, updated_at) VALUES ('p_old', 'x', '{}', now() - interval '60 days')`);
  }
  for (const [f, n] of [["all", 600], ["tAll", 600], ["hAll", 1100]]) {
    const rows = await store[f]();
    assert.equal(rows.length, n, f);
    assert.ok(!rows.some(r => r.id === "p_old"), f + " leaves out a record untouched for 60 days");
  }
});

test("a quiet write doesn't move the boards' counter; a normal one does", { skip: !URL && "TEST_DATABASE_URL not set" }, async () => {
  const v = store.ver.harf;
  await store.hPut("p_draft_en", "x", { n: "A" }, { quiet: true });
  assert.equal(store.ver.harf, v);
  assert.deepEqual((await store.hGet("p_draft_en")).data, { n: "A" }, "the quiet write is still saved");
  await store.hPut("p_draft_en", "x", { n: "B" });
  assert.equal(store.ver.harf, v + 1);
  const h = store.ver.hangman;
  await store.put("p_guess", "x", { n: "C" }, { quiet: true });
  assert.equal(store.ver.hangman, h);
});
