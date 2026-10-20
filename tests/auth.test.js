// Google sign-in: the page asks whether its player is the one linked to an account, so a browser that still says
// "saved in Google" after its player was swapped (an old onrender.com bookmark used to do that) can ask for a sign-in.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { startServer } = require("./helper");

let srv, BASE;
before(async () => {
  srv = await startServer({
    env: { GOOGLE_CLIENT_ID: "test-client.apps.googleusercontent.com", ACCOUNT_KEY: "k".repeat(32) },
    seed: { players: {}, acct: { "g:1234": { uid: "p_linked0001", tok: "sealed", at: 1 } } },
  });
  BASE = srv.base;
});
after(() => srv.stop());
const cfg = async q => (await fetch(BASE + "/api/auth/config" + q)).json();

test("config says whether a player id is the one linked to a Google account", async () => {
  assert.deepEqual(await cfg("?uid=p_linked0001"), { google: "test-client.apps.googleusercontent.com", linked: true });
  assert.equal((await cfg("?uid=p_guest00001")).linked, false);
  assert.equal("linked" in (await cfg("")), false, "no id, no answer");
  assert.equal("linked" in (await cfg("?uid=bad id")), false);
});
