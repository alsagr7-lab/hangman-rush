// Connects the pages to the game server (named rush.js rather than api.js, which some content blockers block): player identity, live rooms (WebSocket), the Hangman leaderboard,
// the Trivia API and a "waking up" notice for the free server's cold start.
// It also stands in for the claude.ai artifact runtime (window.claude), which Hangman Rush was first written for.
(function () {
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  };
  const rand = n => { const a = new Uint8Array(n); crypto.getRandomValues(a); return [...a].map(b => b.toString(16).padStart(2, "0")).join(""); };

  /* ---------- where the server is ---------- */
  const cfg = window.RUSH_CONFIG || {};
  const API = String(cfg.api || "").replace(/\/+$/, "");
  const http = p => API + p;
  // the public address: shared links always use it, and old onrender.com addresses send players to it
  const HOME = String(cfg.home || "").replace(/\/+$/, "");
  const wsUrl = API ? API.replace(/^http/, "ws") + "/ws" : (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws";

  /* ---------- identity ----------
     Moving to the static site: the old address links here with #move=<id>.<token>.<profile>, so the player keeps
     their leaderboard entry. The fragment never reaches any server. */
  const MOVED = ["hr-me", "hr-lang", "hr-daily", "hr-daily-ar", "hr-cv", "tr-cv", "hr-acct"];
  (function adopt() {
    const m = location.hash.match(/^#move=([A-Za-z0-9_-]{8,64})\.([0-9a-f]{16,128})(?:\.(.*))?$/);
    if (!m) return;
    store.set("hr-uid", m[1]); store.set("hr-token", m[2]);
    if (m[3]) { try { const extra = JSON.parse(decodeURIComponent(m[3])); for (const k of MOVED) if (typeof extra[k] === "string") store.set(k, extra[k]); } catch {} }
    history.replaceState(null, "", location.pathname + location.search);
  })();
  let uid = store.get("hr-uid"); if (!uid) { uid = "p_" + rand(10); store.set("hr-uid", uid); }
  let token = store.get("hr-token"); if (!token) { token = rand(24); store.set("hr-token", token); }
  function moveLink(target) {
    const extra = {};
    for (const k of MOVED) { const v = store.get(k); if (v) extra[k] = v; }
    return target.replace(/\/+$/, "") + location.pathname + "#move=" + uid + "." + token + "." + encodeURIComponent(JSON.stringify(extra));
  }
  // an old onrender.com address: carry the player (id, profile, sign-in) over to the public address
  (function leaveOld() {
    if (!HOME || !/\.onrender\.com$/i.test(location.hostname)) return;
    try { if (new URL(HOME).origin === location.origin) return; } catch { return; }
    location.replace(moveLink(HOME));
  })();
  // the link put in shared results
  function shareUrl() { return (HOME || location.origin) + location.pathname; }

  /* ---------- waking the free server ----------
     A free Render service sleeps after 15 idle minutes and takes up to a minute to wake. Pages load instantly from
     the static site; a welcome screen covers the page until the server answers. It asks "are you awake?" every
     5 seconds (each try also nudges the server to start), and steps aside as soon as the answer is yes. */
  const serverListeners = new Set();
  let serverState = "checking"; // checking | waking | up | down
  function setServer(s) { if (s === serverState) return; serverState = s; serverListeners.forEach(f => { try { f(s); } catch {} }); }

  const POLL_MS = 5000, TRY_MS = 8000, SLOW_MS = 90000;
  const GAMES = {
    hangman: { en: "Hangman Rush", ar: "سباق المشنقة" },
    trivia: { en: "Trivia Rush", ar: "سباق المعلومات" },
    harf: { en: "Harf Rush", ar: "سباق الحروف" },
    hub: { en: "Rush Games", ar: "ألعاب السباق" },
  };
  const gameKey = /^\/hangman/.test(location.pathname) ? "hangman" : /^\/trivia/.test(location.pathname) ? "trivia" : /^\/harf/.test(location.pathname) ? "harf" : "hub";
  // each game has its own accent colour in rush.css
  document.documentElement.setAttribute("data-game", gameKey);
  const isAr = () => (store.get("hr-lang") || (navigator.language || "").slice(0, 2)) === "ar";
  const TXT = {
    en: { welcome: "Welcome to", sub: "Give us a moment while the game server wakes up.", check: "Checking if the server is awake…",
          tries: n => `Still waking up · asked ${n} time${n === 1 ? "" : "s"}`, ready: "Ready! Let's play.",
          slow: "This is taking longer than usual. We'll keep asking every 10 seconds.", offline: "Practise offline meanwhile",
          blocked: "Your browser is blocking the connection to the game server.", blockedBrave: "Brave Shields is blocking the connection to the game server.",
          blockedHelp: "Open the direct version instead. Your name, streaks and scores come with you.", direct: "Open the direct version",
          why: "The games run on a free server that naps when nobody's playing." },
    ar: { welcome: "أهلاً بك في", sub: "لحظات من فضلك حتى يستيقظ خادم اللعبة.", check: "نتحقق إن كان الخادم مستيقظاً…",
          tries: n => `ما زال يستيقظ · سألناه ${n} ${n === 1 ? "مرة" : "مرات"}`, ready: "جاهز! لنلعب.",
          slow: "يستغرق الأمر أطول من المعتاد. سنواصل السؤال كل 10 ثوانٍ.", offline: "تدرّب بدون اتصال في هذه الأثناء",
          blocked: "متصفحك يمنع الاتصال بخادم اللعبة.", blockedBrave: "دروع Brave تمنع الاتصال بخادم اللعبة.",
          blockedHelp: "افتح النسخة المباشرة بدلاً من ذلك. اسمك وسلاسلك ونقاطك تنتقل معك.", direct: "افتح النسخة المباشرة",
          why: "الألعاب تعمل على خادم مجاني يغفو عندما لا يلعب أحد." },
  };

  // the welcome screen; it uses the page's own colours and fonts, so it looks like part of the game
  let splash = null, bar = null, line = null, slowBox = null, blockBox = null, blockMsg = null, started = 0, tries = 0, dismissed = false, ticker = null;
  function showSplash() {
    if (splash || dismissed) return;
    const ar = isAr(), T = TXT[ar ? "ar" : "en"], g = GAMES[gameKey][ar ? "ar" : "en"];
    splash = document.createElement("div");
    splash.className = "rush-splash"; splash.dir = ar ? "rtl" : "ltr"; splash.setAttribute("role", "status");
    const st = document.createElement("style");
    st.textContent = `
.rush-splash{position:fixed;inset:0;z-index:100;display:grid;place-items:center;padding:24px 16px;background:var(--bg,#0B0C10);color:var(--ink,#F4F1EA);transition:opacity .35s}
.rush-splash.out{opacity:0;pointer-events:none}
.rush-splash .in{width:min(420px,100%);display:grid;gap:16px;text-align:center}
.rush-splash .gtile{justify-self:center;width:76px;height:76px;border-radius:24px}
.rush-splash .wl{font:600 12px var(--f-display,system-ui,sans-serif);font-stretch:125%;color:var(--muted,#9EA3B0);letter-spacing:.18em;text-transform:uppercase}
.rush-splash[dir="rtl"] .wl{letter-spacing:0;text-transform:none;font:700 14px var(--f-ar,system-ui,sans-serif)}
.rush-splash h1{font-family:var(--f-display,system-ui,sans-serif);font-stretch:118%;font-weight:800;font-size:clamp(36px,11vw,56px);line-height:1;margin:0}
.rush-splash[dir="rtl"] h1{font-family:var(--f-ar,system-ui,sans-serif);font-stretch:100%;font-weight:900;line-height:1.25}
.rush-splash p{margin:0;font:16px/1.5 var(--f-body,system-ui,sans-serif);color:var(--soft,#B4B8C3)}
.rush-splash .track{height:8px;border-radius:99px;overflow:hidden;background:var(--key,#262A35)}
.rush-splash .fill{height:100%;width:3%;background:var(--accent,#F2B544);border-radius:99px;transition:width .6s ease-out}
.rush-splash .ok .fill,.rush-splash .fill.ok{background:var(--good,#3DD68C)}
.rush-splash .st{font:600 14px var(--f-body,system-ui,sans-serif);min-height:20px;font-variant-numeric:tabular-nums}
.rush-splash .why{font-size:13px;color:var(--muted,#9EA3B0)}
.rush-splash .slow{display:grid;gap:10px}
.rush-splash .rush-go,.rush-splash button{justify-self:center;text-decoration:none;font:800 15px var(--f-body,system-ui,sans-serif);color:var(--accent-ink,#0B0C10);background:var(--accent,#F2B544);
  border:0;border-radius:14px;padding:0 20px;min-height:48px;display:inline-flex;align-items:center;cursor:pointer}
.rush-splash button{background:var(--raised,#1B1E26);color:var(--ink,#F4F1EA);border:1px solid var(--line3,#343846)}
@media (prefers-reduced-motion:reduce){.rush-splash,.rush-splash .fill{transition:none}}`;
    const inner = document.createElement("div"); inner.className = "in";
    const wl = document.createElement("div"); wl.className = "wl"; wl.textContent = T.welcome;
    const h = document.createElement("h1"); h.textContent = g;
    const sub = document.createElement("p"); sub.textContent = T.sub;
    const track = document.createElement("div"); track.className = "track"; track.setAttribute("role", "progressbar"); track.setAttribute("aria-label", T.check);
    bar = document.createElement("div"); bar.className = "fill"; track.appendChild(bar);
    line = document.createElement("div"); line.className = "st"; line.textContent = T.check;
    const why = document.createElement("p"); why.className = "why"; why.textContent = T.why;
    slowBox = document.createElement("div"); slowBox.className = "slow"; slowBox.hidden = true;
    const sp = document.createElement("p"); sp.textContent = T.slow;
    const off = document.createElement("button"); off.type = "button"; off.textContent = T.offline; off.onclick = () => hideSplash(true);
    slowBox.append(sp, off);
    blockBox = document.createElement("div"); blockBox.className = "slow"; blockBox.hidden = true;
    blockMsg = document.createElement("p"); blockMsg.style.fontWeight = "700";
    const bh = document.createElement("p"); bh.textContent = T.blockedHelp;
    const go = document.createElement("a"); go.className = "rush-go"; go.textContent = T.direct; go.href = directLink();
    blockBox.append(blockMsg, bh, go);
    const ic = document.createElement("span"); ic.className = "gtile " + gameKey; ic.setAttribute("aria-hidden", "true");
    const mk = document.createElement("span"); mk.className = "rmark"; ic.append(mk); inner.append(ic);
    inner.append(wl, h, sub, track, line, slowBox, blockBox, why);
    splash.append(st, inner);
    document.body.appendChild(splash);
    // the bar creeps towards 95% over about a minute (a typical wake-up), then waits for the real answer
    ticker = setInterval(() => {
      const t = Date.now() - started;
      if (bar && serverState !== "up") bar.style.width = Math.min(95, 3 + 92 * (1 - Math.exp(-t / 25000))).toFixed(1) + "%";
      if (t > SLOW_MS && slowBox && !blocked) slowBox.hidden = false;
    }, 500);
  }
  function hideSplash(byUser) {
    dismissed = true; clearInterval(ticker);
    if (!splash) return;
    const el = splash; splash = null;
    if (byUser) { el.remove(); return; }
    bar.style.width = "100%"; bar.classList.add("ok"); line.textContent = TXT[isAr() ? "ar" : "en"].ready;
    setTimeout(() => { el.classList.add("out"); setTimeout(() => el.remove(), 400); }, 450);
  }

  // the same game on the server's own address, where nothing is cross-site; carries the player's id and profile
  function directLink() { return API ? moveLink(API) : location.href; }
  async function reachable() {
    const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), TRY_MS);
    try { await fetch(http("/healthz"), { mode: "no-cors", cache: "no-store", signal: ctl.signal }); return true; }
    catch (e) { return e && e.name === "AbortError"; } // a slow answer is a waking server, not a block
    finally { clearTimeout(to); }
  }
  let blockedTries = 0, blocked = false;
  function showBlocked() {
    blocked = true; setServer("down");
    onBody(() => {
      if (dismissed) { dismissed = false; }
      showSplash();
      if (!splash) return;
      const T = TXT[isAr() ? "ar" : "en"];
      blockMsg.textContent = navigator.brave ? T.blockedBrave : T.blocked;
      blockBox.hidden = false; slowBox.hidden = true; line.textContent = "";
      bar.parentElement.hidden = true;
    });
  }
  async function askOnce() {
    tries++;
    const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), TRY_MS);
    try { const r = await fetch(http("/healthz"), { cache: "no-store", signal: ctl.signal }); return r.ok; }
    catch { return false; }
    finally { clearTimeout(to); }
  }
  async function ping() {
    started = Date.now();
    // a server that's already awake answers in well under a second: only show the welcome screen if it doesn't
    const show = setTimeout(() => { if (serverState !== "up") { setServer("waking"); onBody(showSplash); } }, 600);
    for (;;) {
      const t0 = Date.now();
      if (await askOnce()) { clearTimeout(show); setServer("up"); hideSplash(false); return true; }
      if (API && !blocked) {
        blockedTries = (await reachable()) ? 0 : blockedTries + 1;
        if (blockedTries >= 2) { clearTimeout(show); showBlocked(); }
      }
      if (line && splash && !blocked) line.textContent = TXT[isAr() ? "ar" : "en"].tries(tries);
      if (Date.now() - started > SLOW_MS) setServer("down");
      const gap = Date.now() - started > SLOW_MS ? 10000 : POLL_MS;
      await new Promise(r => setTimeout(r, Math.max(0, gap - (Date.now() - t0))));
    }
  }
  function onBody(f) { if (document.body) f(); else document.addEventListener("DOMContentLoaded", f); }
  const ready = new Promise(res => { const f = s => { if (s === "up") { serverListeners.delete(f); res(); } }; serverListeners.add(f); });
  ping();

  /* ---------- room ---------- */
  let ws = null, open = false;
  const joined = new Map(); // name -> state
  function sendRaw(obj) { if (open) ws.send(JSON.stringify(obj)); }
  function setOpen(v) { open = v; joined.forEach(s => s.conn.forEach(f => { try { f(v); } catch {} })); }
  function connect() {
    ws = new WebSocket(wsUrl);
    ws.onopen = () => { setOpen(true); setServer("up"); joined.forEach((s, name) => sendRaw({ t: "join", room: name, presence: s.presence })); };
    ws.onclose = () => { setOpen(false); setTimeout(connect, 1200); };
    ws.onerror = () => {};
    ws.onmessage = ev => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      const s = joined.get(m.room); if (!s) return;
      if (m.t === "error") { if (s.pending) { s.pending.reject({ code: m.code, message: "Room limit reached" }); s.pending = null; joined.delete(m.room); } return; }
      if (m.t !== "peers") return;
      const now = Date.now(), prev = new Map(s.peers.map(p => [p.peer, p]));
      s.peers = Object.freeze(m.peers.map(p => {
        const old = prev.get(p.peer), same = old && JSON.stringify(old.presence) === JSON.stringify(p.presence);
        if (same) return old;
        return Object.freeze({ peer: p.peer, by: null, isMe: p.peer === m.me, sameTab: p.peer === m.me, kind: "viewer", guest: false,
          presence: Object.freeze(p.presence || {}), updatedAt: now });
      }));
      const ids = new Set(s.peers.map(p => p.peer));
      const change = { peers: s.peers, joined: s.peers.filter(p => !prev.has(p.peer)), left: [...prev.values()].filter(p => !ids.has(p.peer)),
        updated: s.peers.filter(p => prev.has(p.peer) && prev.get(p.peer) !== p) };
      s.listeners.forEach(f => { try { f(change); } catch (e) { console.error(e); } });
      if (s.pending) { s.pending.resolve(s.api); s.pending = null; }
    };
  }
  const room = {
    join(name) {
      if (!/^[a-z0-9][a-z0-9_.-]{0,47}$/.test(name)) return Promise.reject({ code: "invalid_argument", message: "Bad room name" });
      if (joined.has(name)) return Promise.resolve(joined.get(name).api);
      if (!ws) connect();
      const s = { presence: {}, peers: Object.freeze([]), listeners: new Set(), conn: new Set(), pending: null };
      s.api = {
        name,
        presence(patch) {
          for (const [k, v] of Object.entries(patch || {})) { if (v === null) delete s.presence[k]; else s.presence[k] = v; }
          sendRaw({ t: "presence", room: name, patch });
          return Promise.resolve();
        },
        peers() { return s.peers; },
        onPeers(fn) { s.listeners.add(fn); queueMicrotask(() => { if (s.listeners.has(fn)) fn({ peers: s.peers, joined: s.peers, left: [], updated: [] }); }); return () => s.listeners.delete(fn); },
        connected() { return open; },
        onConnection(fn) { s.conn.add(fn); queueMicrotask(() => fn(open)); return () => s.conn.delete(fn); },
        emit() { return Promise.reject({ code: "not_permitted", message: "Events are not used in this build" }); },
        on() { return () => {}; },
        leave() { joined.delete(name); sendRaw({ t: "leave", room: name }); s.listeners.clear(); s.conn.clear(); return Promise.resolve(); },
      };
      joined.set(name, s);
      return new Promise((resolve, reject) => {
        s.pending = { resolve, reject };
        sendRaw({ t: "join", room: name, presence: s.presence });
        // a sleeping server can take a minute to wake, so wait longer than a normal round trip
        setTimeout(() => { if (s.pending) { s.pending = null; joined.delete(name); reject({ code: "upstream_error", message: "Server didn't answer" }); } }, 75000);
      });
    },
  };

  /* ---------- leaderboards ----------
     collection("players") is Hangman's (each device writes its own record); collection("trivia") and collection("harf") are
     read-only here, because the server writes those records itself. */
  function collection(kind) {
    const listeners = new Set();
    const url = kind === "trivia" ? "/api/trivia/players" : kind === "harf" ? "/api/harf/players" : "/api/players";
    async function refresh() {
      try {
        const r = await fetch(http(url), { cache: "no-store" });
        if (!r.ok) throw new Error(r.status);
        const rows = await r.json();
        const snap = { docs: rows.map(row => ({ id: row.id, exists: true, data: () => row.data })) };
        listeners.forEach(s => { try { s.next(snap); } catch (e) { console.error(e); } });
      } catch (e) {
        // the server may still be waking: try again once it's up rather than giving up
        if (serverState !== "up") { ready.then(refresh); return; }
        // a failed load (a restart, a dropped connection) is reported but the board stays subscribed: the next
        // 15-second tick tries again, and the next good load clears the error
        listeners.forEach(s => { if (s.err) { try { s.err({ code: "unavailable", message: String(e) }); } catch {} } });
      }
    }
    setInterval(() => { if (listeners.size && document.visibilityState === "visible") refresh(); }, 15000);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && listeners.size) refresh(); });
    return { refresh, onSnapshot(next, err) { const s = { next, err }; listeners.add(s); refresh(); return () => listeners.delete(s); } };
  }
  const cols = {};
  const colOf = k => (cols[k] = cols[k] || collection(k));
  const db = {
    collection(path) { return colOf(path === "trivia" || path === "harf" ? path : "players"); },
    doc(path) {
      const id = path.split("/")[1];
      return {
        async set(data) {
          // a dropped connection becomes {status: 0}, so the page can tell it apart from a refusal and try again
          const r = await fetch(http("/api/players/" + encodeURIComponent(id)), {
            method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, data }),
          }).catch(() => { throw { code: "unavailable", status: 0, message: "Save failed (offline)" }; });
          if (!r.ok) throw { code: r.status === 403 ? "permission_denied" : "invalid_argument", status: r.status, message: "Save failed (" + r.status + ")" };
          colOf("players").refresh();
        },
      };
    },
  };

  /* ---------- user ---------- */
  const user = { id: async () => uid, isOwner: () => false, canEdit: () => false, can: () => true };

  /* ---------- Hangman daily word (served one day at a time) ---------- */
  const daily = {
    async today(lg) {
      await Promise.race([ready, new Promise(r => setTimeout(r, 70000))]);
      const r = await fetch(http("/api/daily" + (lg === "ar" ? "?lg=ar" : "")), { cache: "no-store" });
      if (!r.ok) throw new Error("daily " + r.status);
      return r.json();
    },
  };

  /* ---------- Trivia ---------- */
  async function post(path, body) {
    const r = await fetch(http(path), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.assign({ uid, token }, body || {})) });
    let data = null; try { data = await r.json(); } catch {}
    if (!r.ok) { const e = new Error((data && data.error) || "HTTP " + r.status); e.status = r.status; e.data = data; throw e; }
    return data;
  }
  async function get(path) {
    const r = await fetch(http(path), { cache: "no-store" });
    if (!r.ok) { const e = new Error("HTTP " + r.status); e.status = r.status; throw e; }
    return r.json();
  }
  // the Hangman daily, run by the server (hangman.js): the word stays there until the player has finished
  const hangman = {
    async info(lg) {
      await Promise.race([ready, new Promise(r => setTimeout(r, 70000))]);
      return get("/api/hangman/info" + (lg === "ar" ? "?lg=ar" : ""));
    },
    state: (lg, profile) => post("/api/hangman/daily/state", Object.assign({ lg }, profile)),
    start: (lg, profile) => post("/api/hangman/daily/start", Object.assign({ lg }, profile)),
    guess: (lg, L) => post("/api/hangman/daily/guess", { lg, L }),
    hint: (lg, kind) => post("/api/hangman/daily/hint", { lg, kind }),
  };
  const trivia = {
    info: () => get("/api/trivia/info"),
    state: profile => post("/api/trivia/daily/state", profile),
    next: profile => post("/api/trivia/daily/next", profile),
    fifty: i => post("/api/trivia/daily/fifty", { i }),
    answer: (i, pick) => post("/api/trivia/daily/answer", { i, pick }),
    archive: n => get("/api/trivia/archive/" + n),
    pick: (uids, cat, diff, count, exclude) => post("/api/trivia/pick", { uids, cat, diff, count, exclude }),
    level: (d, profile) => post("/api/trivia/level", Object.assign({ d }, profile || {})),
    bank: () => fetch("/trivia/questions.json", { cache: "no-cache" }).then(r => { if (!r.ok) throw new Error("bank " + r.status); return r.json(); }),
  };

  /* ---------- Harf ---------- */
  const harf = {
    info: () => get("/api/harf/info"),
    state: profile => post("/api/harf/daily/state", profile),
    start: (lg, profile) => post("/api/harf/daily/start", Object.assign({ lg }, profile || {})),
    save: (dr, lg) => post("/api/harf/daily/save", { dr, lg }),
    submit: (answers, lg) => post("/api/harf/daily/submit", { answers, lg }),
    check: (lg, L, answers) => post("/api/harf/check", { lg, L, answers }),
    appeal: (lg, L, i, w, daily, yd) => post("/api/harf/appeal", { lg, L, i, w, daily: !!daily, yd: !!yd }),
  };

  /* ---------- sign in with Google, the top bar and the profile sheet ----------
     Sign-in is optional. It links this device's player to a Google account, so signing in on another device brings
     the same player (name aside, which each device keeps). The server keeps no email address; this device remembers
     it only to show who's signed in.
     Every page gets the same top bar: the logo (or, in a game, a back button and the game's name), the language
     switch, a "Save progress" button while signed out, and the player's avatar. The avatar opens a profile sheet
     holding the page's own name-and-colour card (moved in whole, so the page's code keeps working) and sign-in.
     A Rush+ link in the bar and the sheet stays hidden until RUSH_CONFIG.subscriptions is turned on. */
  const AUTH_TXT = {
    en: { pitch: "Sign in with Google to keep your streaks and scores on any device.", as: "Signed in as {e}. Your progress is saved to your Google account.",
          out: "Sign out", outQ: "Sign out on this device? It starts again as a new guest; your progress stays in your Google account.",
          switchQ: "This Google account already has progress from another device. Switch to it? Your results from this device will be added to it (if both played the same day, the first result counts).",
          merged: "Added {e} day(s) from your other device.", mergedNone: "Nothing new to add from your other device.", mergeSkipped: "Results from another device were already added this season, so this device's weren't added.",
          fail: "Sign-in didn't work. Try again in a moment.", taken: "This progress is already linked to a different Google account.",
          guest: "Playing as a guest", saved: "Progress saved to Google", priv: "We don't keep your email or name, only your Google account number, so your progress can follow you.",
          save: "Save progress", saveShort: "Save", profile: "Your profile", close: "Close", allGames: "All games", home: "Rush Games home",
          switchT: "Switch to this account?", switchOk: "Switch account", outT: "Sign out?", cancel: "Cancel",
          plusFree: "Free plan", plusSee: "See plans", me: "Your profile" },
    ar: { pitch: "سجّل الدخول بحساب Google لتحتفظ بسلاسلك ونقاطك على أي جهاز.", as: "مسجّل باسم {e}. تقدّمك محفوظ في حساب Google.",
          out: "تسجيل الخروج", outQ: "تسجيل الخروج من هذا الجهاز؟ سيبدأ كضيف جديد، ويبقى تقدّمك محفوظاً في حساب Google.",
          switchQ: "لهذا الحساب تقدّم من جهاز آخر. هل تنتقل إليه؟ ستُضاف نتائجك من هذا الجهاز إليه (إذا لعب الجهازان نفس اليوم تُحتسب النتيجة الأولى).",
          merged: "أُضيفت {e} يوماً من جهازك الآخر.", mergedNone: "لا جديد لإضافته من جهازك الآخر.", mergeSkipped: "سبق أن أُضيفت نتائج جهاز آخر هذا الموسم، فلم تُضف نتائج هذا الجهاز.",
          fail: "تعذّر تسجيل الدخول. حاول بعد لحظات.", taken: "هذا التقدّم مرتبط بحساب Google آخر.",
          guest: "تلعب كضيف", saved: "تقدّمك محفوظ في Google", priv: "لا نحتفظ ببريدك أو اسمك، بل برقم حسابك في Google فقط، ليتبعك تقدّمك.",
          save: "احفظ تقدّمك", saveShort: "احفظ", profile: "ملفك", close: "إغلاق", allGames: "كل الألعاب", home: "الصفحة الرئيسية",
          switchT: "الانتقال إلى هذا الحساب؟", switchOk: "انتقل للحساب", outT: "تسجيل الخروج؟", cancel: "إلغاء",
          plusFree: "الخطة المجانية", plusSee: "الخطط", me: "ملفك" },
  };
  let acct = null; try { acct = JSON.parse(store.get("hr-acct") || "null"); } catch {}
  let authCfg = null, gsi = null, acctBox = null, acctMsg = "";
  const at = (k, v) => { const s = AUTH_TXT[isAr() ? "ar" : "en"][k]; return v ? s.replace("{e}", v) : s; };
  const SUBS = !!cfg.subscriptions;
  const PLAYER_COLORS = ["#2c56e0", "#d93c30", "#178a5c", "#c27a00", "#8a3ffc", "#d6337f"];
  const TAG_ABC = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  function tagOf(id) { let h = 2166136261; for (const ch of String(id)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; } let s = ""; for (let i = 0; i < 4; i++) { s += TAG_ABC[h % 32]; h = Math.floor(h / 32); } return s; }
  const SVGNS = "http://www.w3.org/2000/svg";
  function svg(markup, cls) { const t = document.createElement("template"); t.innerHTML = markup.trim(); const s = t.content.firstChild; if (cls) s.setAttribute("class", cls); s.setAttribute("aria-hidden", "true"); return s; }
  const G_LOGO = '<svg viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>';
  const CLOUD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M7 18a5 5 0 0 1-.5-9.97A6 6 0 0 1 18 9a4.5 4.5 0 0 1-.5 9H7z"/><path d="M12 11v5M9.5 13.5L12 11l2.5 2.5"/></svg>';
  const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M5 12l5 5L20 7"/></svg>';
  const X_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  const BACK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>';
  const mkEl = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  /* an in-page question with two buttons, in place of the browser's grey confirm() box; resolves true or false */
  function ask({ title, body, ok, cancel }) {
    return new Promise(resolve => {
      const bg = mkEl("div", "rdlg-bg"), box = mkEl("div", "rdlg");
      box.setAttribute("role", "alertdialog"); box.setAttribute("aria-modal", "true"); box.dir = isAr() ? "rtl" : "ltr";
      const h = mkEl("h2", null, title), p = mkEl("p", null, body), acts = mkEl("div", "acts");
      const yes = mkEl("button", "btn primary", ok), no = mkEl("button", "btn", cancel || at("cancel"));
      yes.type = no.type = "button"; h.id = "rdlg-t"; box.setAttribute("aria-labelledby", "rdlg-t");
      acts.append(yes, no); box.append(h, p, acts); bg.append(box); document.body.append(bg);
      const prev = document.activeElement;
      const done = v => { document.removeEventListener("keydown", key, true); bg.remove(); try { prev && prev.focus && prev.focus(); } catch {} resolve(v); };
      const key = e => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(false); } };
      document.addEventListener("keydown", key, true);
      yes.onclick = () => done(true); no.onclick = () => done(false);
      bg.addEventListener("click", e => { if (e.target === bg) done(false); });
      yes.focus();
    });
  }

  // a different player on this device: forget the old player's local copies so they can't overwrite the new one
  function switchTo(u, t) {
    for (const k of ["hr-daily", "hr-daily-ar", "hf-today", "tr-today"]) { try { localStorage.removeItem(k); } catch {} }
    store.set("hr-uid", u); store.set("hr-token", t);
    location.reload();
  }
  function loadGsi() {
    return gsi || (gsi = new Promise((res, rej) => {
      const s = document.createElement("script"); s.src = "https://accounts.google.com/gsi/client"; s.async = true;
      s.onload = () => { try { window.google.accounts.id.initialize({ client_id: authCfg.google, callback: onCredential }); res(); } catch (e) { rej(e); } };
      s.onerror = rej; document.head.appendChild(s);
    }));
  }
  async function onCredential(resp, confirmed) {
    acctMsg = "";
    try {
      const r = await post("/api/auth/google", { credential: resp.credential, confirm: !!confirmed });
      acct = { email: r.email || "" }; store.set("hr-acct", JSON.stringify(acct));
      if (r.uid !== uid) {
        // shown once after the reload: what came across from this device
        if (r.mergeSkipped || r.merged != null) store.set("hr-merged", JSON.stringify({ n: Number(r.merged) || 0, skip: !!r.mergeSkipped }));
        return switchTo(r.uid, r.token);
      }
    } catch (e) {
      if (e.status === 409 && e.data && e.data.need === "switch") {
        if (await ask({ title: at("switchT"), body: at("switchQ"), ok: at("switchOk") })) return onCredential(resp, true);
      }
      else acctMsg = e.status === 409 ? "taken" : "fail";
    }
    renderAcct(); renderBar();
  }
  async function signOut() {
    if (!(await ask({ title: at("outT"), body: at("outQ"), ok: at("out") }))) return;
    try { localStorage.removeItem("hr-acct"); } catch {}
    switchTo("p_" + rand(10), rand(24));
  }
  // Google draws its own button; its dark version sits on the dark design. It needs a width, so it's drawn once the sheet is open.
  let gsiSlot = null, gsiDrawn = null;
  function drawGsi() {
    if (!gsiSlot || gsiDrawn === gsiSlot || !sheetOpen || !(authCfg && authCfg.google)) return;
    const slot = gsiSlot; gsiDrawn = slot;
    const w = Math.max(220, Math.min(400, Math.round(slot.getBoundingClientRect().width || 300)));
    loadGsi().then(() => window.google.accounts.id.renderButton(slot, { type: "standard", theme: "filled_black", size: "large", text: "signin_with", shape: "pill", width: w, locale: isAr() ? "ar" : "en" }))
      .catch(() => { gsiDrawn = null; });
  }
  function renderAcct() {
    if (!acctBox) return;
    acctBox.textContent = ""; gsiSlot = null; gsiDrawn = null;
    if (acct) {
      const head = mkEl("div", "ah"), dot = mkEl("span", "gdot"), em = mkEl("span", "em");
      dot.append(svg(G_LOGO)); em.append(mkEl("b", null, acct.email || "Google"), mkEl("span", null, at("saved")));
      head.append(dot, em); acctBox.append(head);
      let mg = null; try { mg = JSON.parse(store.get("hr-merged") || "null"); } catch {}
      if (mg) {
        const m = mkEl("p", "merged"); m.append(svg(CHECK), document.createTextNode(mg.skip ? at("mergeSkipped") : mg.n ? at("merged", String(mg.n)) : at("mergedNone")));
        acctBox.append(m);
        setTimeout(() => { try { localStorage.removeItem("hr-merged"); } catch {} }, 1000);
      }
      const b = mkEl("button", "rush-acct-out", at("out")); b.type = "button"; b.onclick = signOut; acctBox.append(b);
    } else if (authCfg && authCfg.google) {
      const head = mkEl("p", "ah"); head.append(svg(CLOUD), document.createTextNode(at("guest")));
      head.firstChild.style.color = "var(--gold)";
      gsiSlot = mkEl("div", "rush-acct-btn");
      acctBox.append(head, mkEl("p", "pitch", at("pitch")), gsiSlot, mkEl("p", "priv", at("priv")));
      drawGsi();
    }
    if (acctMsg) acctBox.append(mkEl("p", "note warn", at(acctMsg)));
  }

  /* the player as this device knows them, for the avatar */
  function profile() {
    let me = null; try { me = JSON.parse(store.get("hr-me") || "null"); } catch {}
    const nickIn = document.getElementById("nick");
    let nick = (nickIn && nickIn.value.trim()) || (me && me.nick) || "";
    let color = me && PLAYER_COLORS.includes(me.color) ? me.color : PLAYER_COLORS[0];
    const on = document.querySelector('#sw [aria-pressed="true"]');
    if (on && on.style.background) { const c = PLAYER_COLORS.find(x => sameColor(x, on.style.background)); if (c) color = c; }
    return { nick: nick.slice(0, 16), color };
  }
  function sameColor(hex, css) {
    if (css.toLowerCase() === hex) return true;
    const m = css.match(/\d+/g); if (!m) return false;
    return m.slice(0, 3).map(n => Number(n).toString(16).padStart(2, "0")).join("") === hex.slice(1);
  }
  function fillAvatar(av) {
    const p = profile();
    av.style.background = p.color;
    av.firstChild.textContent = p.nick ? [...p.nick][0].toUpperCase() : "?";
    av.querySelector(".gbadge") && av.querySelector(".gbadge").remove();
    if (acct) { const g = mkEl("span", "gbadge"); g.append(svg(G_LOGO)); av.append(g); }
  }
  function avatar() { const a = mkEl("span", "av"); a.append(document.createTextNode("")); return a; }

  let topbar = null, barRefs = {}, sheet = null, sheetBg = null, sheetOpen = false, sheetRefs = {};
  function renderBar() {
    if (!topbar) return;
    const ar = isAr(), g = GAMES[gameKey], p = profile(), tag = tagOf(uid);
    topbar.dir = ar ? "rtl" : "ltr";
    if (barRefs.home) barRefs.home.setAttribute("aria-label", at("home"));
    if (barRefs.back) barRefs.back.setAttribute("aria-label", at("allGames"));
    if (barRefs.name) {
      barRefs.name.textContent = "";
      const full = g[ar ? "ar" : "en"];
      if (!ar && / /.test(full)) { const i = full.lastIndexOf(" "); barRefs.name.append(document.createTextNode(full.slice(0, i + 1)), mkEl("b", null, full.slice(i + 1))); }
      else barRefs.name.textContent = full;
    }
    barRefs.save.hidden = !(authCfg && authCfg.google) || !!acct;
    barRefs.saveT.textContent = at("save"); barRefs.saveT2.textContent = at("saveShort");
    barRefs.save.setAttribute("aria-label", at("save"));
    barRefs.me.setAttribute("aria-label", at("me"));
    fillAvatar(barRefs.av);
    barRefs.who.textContent = p.nick || "—";
    barRefs.who.append(mkEl("small", "ltr", "#" + tag));
    if (sheet) {
      sheet.dir = ar ? "rtl" : "ltr";
      sheetRefs.title.textContent = at("profile");
      sheetRefs.tag.textContent = (p.nick ? p.nick + " " : "") + "#" + tag;
      sheetRefs.x.setAttribute("aria-label", at("close"));
      fillAvatar(sheetRefs.av);
      if (sheetRefs.plus) { sheetRefs.plusT.textContent = "Rush+ "; sheetRefs.plusT.append(mkEl("small", null, "· " + at("plusFree"))); sheetRefs.plusS.textContent = at("plusSee"); }
    }
  }
  function openSheet() {
    if (!sheet || sheetOpen) return;
    sheetOpen = true; sheet.hidden = false; sheetBg.hidden = false;
    requestAnimationFrame(() => requestAnimationFrame(() => { sheet.classList.add("open"); sheetBg.classList.add("open"); drawGsi(); }));
    renderBar();
    barRefs.me.setAttribute("aria-expanded", "true");
  }
  function closeSheet() {
    if (!sheetOpen) return;
    sheetOpen = false; sheet.classList.remove("open"); sheetBg.classList.remove("open");
    barRefs.me.setAttribute("aria-expanded", "false");
    // let the page save the name first (it saves on "change", which fires as the box loses focus)
    if (document.activeElement && sheet.contains(document.activeElement)) document.activeElement.blur();
    setTimeout(() => { if (!sheetOpen) { sheet.hidden = true; sheetBg.hidden = true; } renderBar(); }, 260);
    try { barRefs.me.focus({ preventScroll: true }); } catch {}
  }
  function buildChrome() {
    const g = gameKey;
    topbar = mkEl("header", "rbar"); topbar.setAttribute("data-game", g);
    const inner = mkEl("div", "rbar-in"); topbar.append(inner);
    const home = mkEl("a", "rbar-home"); home.href = "/"; home.append(mkEl("span", "rwordmark")); barRefs.home = home;
    if (g === "hub") inner.append(home);
    else {
      const back = mkEl("a", "rbar-back"); back.href = "/"; back.append(svg(BACK)); barRefs.back = back;
      const game = mkEl("div", "rbar-game"), tile = mkEl("span", "gtile " + g), name = mkEl("span", "rbar-name");
      tile.setAttribute("aria-hidden", "true"); tile.append(mkEl("span", "rmark")); game.append(tile, name); barRefs.name = name;
      inner.append(back, home, mkEl("span", "rbar-sep"), game);
    }
    inner.append(mkEl("span", "rbar-sp"));
    if (SUBS) { const plus = mkEl("a", "rbar-plus"); plus.href = "/plus/"; plus.append(document.createTextNode("Rush"), mkEl("b", null, "+")); inner.append(plus); }
    // the page's own language button moves into the bar (its click handler comes with it)
    const lang = document.getElementById("langLobby") || document.getElementById("lang");
    if (lang) inner.append(lang);
    const save = mkEl("button", "rbar-save"); save.type = "button"; save.hidden = true;
    const saveT = mkEl("span", "t1"), saveT2 = mkEl("span", "t2");
    save.append(svg(CLOUD), saveT, saveT2); barRefs.saveT2 = saveT2; barRefs.saveT = saveT; save.onclick = openSheet; barRefs.save = save;
    const me = mkEl("button", "rbar-me"); me.type = "button"; me.setAttribute("aria-haspopup", "dialog"); me.setAttribute("aria-expanded", "false");
    const av = avatar(), who = mkEl("span", "who"); me.append(av, who); me.onclick = () => (sheetOpen ? closeSheet() : openSheet());
    barRefs.me = me; barRefs.av = av; barRefs.who = who;
    inner.append(save, me);
    document.body.prepend(topbar);

    // the profile sheet, holding the page's name-and-colour card
    const nick = document.getElementById("nick"), card = nick && nick.closest(".card");
    sheetBg = mkEl("div", "rsheet-bg"); sheetBg.hidden = true; sheetBg.onclick = closeSheet;
    sheet = mkEl("section", "rsheet"); sheet.hidden = true; sheet.setAttribute("role", "dialog"); sheet.setAttribute("aria-labelledby", "rsheet-t");
    const head = mkEl("div", "rsheet-head"), hav = avatar(), hd = mkEl("div"), ht = mkEl("h2"), htag = mkEl("span", "tagl"), x = mkEl("button", "rsheet-x");
    ht.id = "rsheet-t"; x.type = "button"; x.append(svg(X_ICON)); x.onclick = closeSheet;
    hd.append(ht, htag); head.append(hav, hd, x);
    sheet.append(mkEl("span", "grab"), head);
    sheetRefs = { av: hav, title: ht, tag: htag, x };
    if (SUBS) {
      const plus = mkEl("a", "rsheet-plus"); plus.href = "/plus/";
      const pi = mkEl("i", null, "+"), pt = mkEl("span"), ps = mkEl("small");
      plus.append(pi, pt, ps); sheet.append(plus); sheetRefs.plus = plus; sheetRefs.plusT = pt; sheetRefs.plusS = ps;
    }
    acctBox = mkEl("div", "rush-acct");
    if (card) { card.classList.add("rsheet-card"); sheet.append(card); }
    sheet.append(acctBox);
    document.body.append(sheetBg, sheet);
    sheet.addEventListener("keydown", e => { if (e.key === "Escape") { e.stopPropagation(); closeSheet(); } });
    sheet.addEventListener("input", renderBar);
    sheet.addEventListener("click", e => { if (e.target.closest && e.target.closest("#sw")) setTimeout(renderBar, 0); });
    // when the page asks for a name (it marks the box and focuses it), bring the sheet up
    if (nick) {
      new MutationObserver(() => { if (nick.classList.contains("need")) { openSheet(); setTimeout(() => { try { nick.focus(); } catch {} }, 280); } })
        .observe(nick, { attributes: true, attributeFilter: ["class"] });
      nick.addEventListener("focus", openSheet);
    }
    window.addEventListener("pageshow", renderBar);
    renderBar();
  }
  onBody(async () => {
    buildChrome();
    // the page's language switch changes <html lang>: redraw in the new language
    new MutationObserver(() => { renderAcct(); renderBar(); }).observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
    renderAcct();
    await ready;
    try { authCfg = await get("/api/auth/config"); } catch { authCfg = { google: null }; }
    renderAcct(); renderBar();
  });

  // one visit count per page load (the admin page's visitor numbers): which game, and this device's player id
  try {
    const pg = (location.pathname.match(/\/(hangman|trivia|harf)(\/|$)/) || [])[1] || "home", b = JSON.stringify({ p: pg, v: uid });
    if (!(navigator.sendBeacon && navigator.sendBeacon(http("/api/hit"), b))) fetch(http("/api/hit"), { method: "POST", body: b, keepalive: true }).catch(() => {});
  } catch {}
  window.Rush = { api: API, http, uid, token, store, room, db, trivia, harf, ready, moveLink, shareUrl, ask, openProfile: () => openSheet(),
    server: () => serverState, onServer(f) { serverListeners.add(f); queueMicrotask(() => f(serverState)); return () => serverListeners.delete(f); } };
  const caps = { room, db, user, daily, hangman };
  window.claude = { use: name => Promise.resolve(caps[name] || null) };
})();
