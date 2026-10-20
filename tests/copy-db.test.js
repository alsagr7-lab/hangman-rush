// The database copy for the server move (scripts/copy-db.js). Needs two empty Postgres databases, so it only runs
// when TEST_PG_FROM and TEST_PG_TO are set, e.g.
//   PGSSL=off TEST_PG_FROM=postgres://postgres@127.0.0.1:5499/olddb TEST_PG_TO=postgres://postgres@127.0.0.1:5499/newdb node --test tests/copy-db.test.js
const test = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const FROM = process.env.TEST_PG_FROM, TO = process.env.TEST_PG_TO;

test("copies every table exactly and refuses a second copy", { skip: !FROM || !TO ? "set TEST_PG_FROM and TEST_PG_TO" : false }, async () => {
  // fill the old database through the server's own store, in a child process so this one stays clean
  const seed = `
    process.env.DATABASE_URL = ${JSON.stringify(FROM)}; process.env.PG_RETRY_MS = "";
    const store = require(${JSON.stringify(path.join(__dirname, "..", "store.js"))});
    (async () => {
      await store.init();
      await store.put("p_aaaa1111", "tok1", { h: { "2026-10-20": { ok: true, t: 1234 } }, nick: "يوسف" });
      await store.tPut("p_aaaa1111", "tok1", { d: { "2026-10-20": [1, 0, 1] } });
      await store.hPut("p_bbbb2222", "tok2", { lg: "ar", a: ["أسد", "زيتون"] });
      await store.wordsPut([["ar|animal|أسد", { ok: 1, src: "ai" }], ["en|plant|tomato", { ok: 0, fix: "tomatoes", src: "mod", by: "m1" }]]);
      await store.archivePut([["p_bbbb2222", "2026-10-19", { s: 40 }]]);
      await store.ipAdd("hash1", "2026-10", "p_bbbb2222");
      await store.metaPut("visits:2026-10-20", { home: { v: 3, u: ["a"] } });
      await store.acctPut("g123", "p_aaaa1111", "enc-token");
      const qids = Array.from({ length: 2600 }, (_, i) => "q" + i);
      await store.seenMark(["p_aaaa1111"], qids, Date.now());
      process.exit(0);
    })().catch(e => { console.error(e); process.exit(1); });`;
  const s = spawnSync(process.execPath, ["-e", seed], { encoding: "utf8" });
  assert.strictEqual(s.status, 0, s.stderr);

  const run = () => spawnSync(process.execPath, [path.join(__dirname, "..", "scripts", "copy-db.js")], { env: { ...process.env, FROM_URL: FROM, TO_URL: TO }, encoding: "utf8" });
  const first = run();
  assert.strictEqual(first.status, 0, first.stderr + first.stdout);
  assert.match(first.stdout, /counts match/);

  // same content, row for row
  const { Pool } = require("pg");
  const a = new Pool({ connectionString: FROM }), b = new Pool({ connectionString: TO });
  try {
    for (const t of require("../scripts/copy-db").TABLES) {
      const q = `SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h, count(*)::int AS n FROM ${t} x`;
      const [ra, rb] = [(await a.query(q)).rows[0], (await b.query(q)).rows[0]];
      assert.deepStrictEqual(rb, ra, t + " differs");
    }
    assert.strictEqual((await b.query("SELECT count(*)::int AS n FROM trivia_seen")).rows[0].n, 2600);
  } finally { await a.end(); await b.end(); }

  // the new database now has data: a second run must refuse and change nothing
  const second = run();
  assert.notStrictEqual(second.status, 0);
  assert.match(second.stderr, /Refusing to overwrite/);
});
