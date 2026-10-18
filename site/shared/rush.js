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
  const wsUrl = API ? API.replace(/^http/, "ws") + "/ws" : (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws";

  /* ---------- identity ----------
     Moving to the static site: the old address links here with #move=<id>.<token>.<profile>, so the player keeps
     their leaderboard entry. The fragment never reaches any server. */
  (function adopt() {
    const m = location.hash.match(/^#move=([A-Za-z0-9_-]{8,64})\.([0-9a-f]{16,128})(?:\.(.*))?$/);
    if (!m) return;
    store.set("hr-uid", m[1]); store.set("hr-token", m[2]);
    if (m[3]) { try { const extra = JSON.parse(decodeURIComponent(m[3])); for (const k of ["hr-me", "hr-lang", "hr-daily", "hr-cv", "tr-cv"]) if (typeof extra[k] === "string") store.set(k, extra[k]); } catch {} }
    history.replaceState(null, "", location.pathname + location.search);
  })();
  let uid = store.get("hr-uid"); if (!uid) { uid = "p_" + rand(10); store.set("hr-uid", uid); }
  let token = store.get("hr-token"); if (!token) { token = rand(24); store.set("hr-token", token); }
  function moveLink(target) {
    const extra = {};
    for (const k of ["hr-me", "hr-lang", "hr-daily", "hr-cv", "tr-cv"]) { const v = store.get(k); if (v) extra[k] = v; }
    return target.replace(/\/+$/, "") + location.pathname + "#move=" + uid + "." + token + "." + encodeURIComponent(JSON.stringify(extra));
  }

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
.rush-splash{position:fixed;inset:0;z-index:100;display:grid;place-items:center;padding:24px 16px;background:var(--bg,#eef2f7);color:var(--ink,#1b2333);
  background-image:repeating-linear-gradient(to bottom,transparent 0 31px,var(--line,#d3dbe8) 31px 32px);transition:opacity .35s}
.rush-splash.out{opacity:0;pointer-events:none}
.rush-splash .in{width:min(420px,100%);display:grid;gap:14px;text-align:center}
.rush-splash .ic{justify-self:center;width:56px;height:64px;color:var(--ink,#1b2333)}
.rush-splash .wl{font:600 15px var(--f-body,system-ui,sans-serif);color:var(--muted,#5d6a80);letter-spacing:.04em}
.rush-splash h1{font-family:var(--f-hand,cursive);font-weight:400;font-size:clamp(44px,13vw,64px);line-height:1.05;margin:0}
:root[lang="ar"] .rush-splash h1,.rush-splash[dir="rtl"] h1{font-weight:700}
.rush-splash p{margin:0;font:16px/1.45 var(--f-body,system-ui,sans-serif)}
.rush-splash .track{height:12px;border:2px solid var(--ink,#1b2333);border-radius:99px;overflow:hidden;background:var(--surface,#fff)}
.rush-splash .fill{height:100%;width:3%;background:var(--accent,#2c56e0);border-radius:99px;transition:width .6s ease-out}
.rush-splash .ok .fill,.rush-splash .fill.ok{background:var(--good,#178a5c)}
.rush-splash .st{font:600 14px var(--f-body,system-ui,sans-serif);min-height:20px}
.rush-splash .why{font-size:13px;color:var(--muted,#5d6a80)}
.rush-splash .slow{display:grid;gap:10px}
.rush-splash .rush-go{justify-self:center;text-decoration:none;font:700 15px var(--f-body,system-ui,sans-serif);color:var(--accent-ink,#fff);background:var(--accent,#2c56e0);
  border:2px solid var(--ink,#1b2333);border-radius:10px;padding:11px 18px;box-shadow:3px 3px 0 var(--ink,#1b2333)}
.rush-splash button{justify-self:center;font:700 15px var(--f-body,system-ui,sans-serif);color:var(--ink,#1b2333);background:var(--surface,#fff);
  border:2px solid var(--ink,#1b2333);border-radius:10px;padding:10px 16px;box-shadow:3px 3px 0 var(--ink,#1b2333);cursor:pointer}
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
    const logo = document.querySelector(".brand svg");
    if (logo) { const ic = logo.cloneNode(true); ic.setAttribute("class", "ic"); inner.append(ic); }
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

  /* ---------- sign in with Google ----------
     Optional. Links this device's player to a Google account, so signing in on another device brings the same
     player (name aside, which each device keeps). Shown under the name box on every page, once the server says
     sign-in is set up. The server keeps no email address; this device remembers it only to show who's signed in. */
  const AUTH_TXT = {
    en: { pitch: "Sign in with Google to keep your streaks and scores on any device.", as: "Signed in as {e}. Your progress is saved to your Google account.",
          out: "Sign out", outQ: "Sign out on this device? It starts again as a new guest; your progress stays in your Google account.",
          switchQ: "This Google account already has progress from another device. Switch to it? Your results from this device will be added to it (if both played the same day, the first result counts).",
          merged: "Added {e} day(s) from your other device.", mergedNone: "Nothing new to add from your other device.", mergeSkipped: "Results from another device were already added this season, so this device's weren't added.",
          fail: "Sign-in didn't work. Try again in a moment.", taken: "This progress is already linked to a different Google account." },
    ar: { pitch: "سجّل الدخول بحساب Google لتحتفظ بسلاسلك ونقاطك على أي جهاز.", as: "مسجّل باسم {e}. تقدّمك محفوظ في حساب Google.",
          out: "تسجيل الخروج", outQ: "تسجيل الخروج من هذا الجهاز؟ سيبدأ كضيف جديد، ويبقى تقدّمك محفوظاً في حساب Google.",
          switchQ: "لهذا الحساب تقدّم من جهاز آخر. هل تنتقل إليه؟ ستُضاف نتائجك من هذا الجهاز إليه (إذا لعب الجهازان نفس اليوم تُحتسب النتيجة الأولى).",
          merged: "أُضيفت {e} يوماً من جهازك الآخر.", mergedNone: "لا جديد لإضافته من جهازك الآخر.", mergeSkipped: "سبق أن أُضيفت نتائج جهاز آخر هذا الموسم، فلم تُضف نتائج هذا الجهاز.",
          fail: "تعذّر تسجيل الدخول. حاول بعد لحظات.", taken: "هذا التقدّم مرتبط بحساب Google آخر." },
  };
  let acct = null; try { acct = JSON.parse(store.get("hr-acct") || "null"); } catch {}
  let authCfg = null, gsi = null, acctBox = null, acctMsg = "";
  const at = (k, v) => { const s = AUTH_TXT[isAr() ? "ar" : "en"][k]; return v ? s.replace("{e}", v) : s; };
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
      if (e.status === 409 && e.data && e.data.need === "switch") { if (confirm(at("switchQ"))) return onCredential(resp, true); }
      else acctMsg = e.status === 409 ? "taken" : "fail";
    }
    renderAcct();
  }
  function signOut() {
    if (!confirm(at("outQ"))) return;
    try { localStorage.removeItem("hr-acct"); } catch {}
    switchTo("p_" + rand(10), rand(24));
  }
  function renderAcct() {
    if (!acctBox) return;
    acctBox.textContent = "";
    if (acct) {
      const p = document.createElement("p"); p.className = "note"; p.textContent = at("as", acct.email || "Google");
      const b = document.createElement("button"); b.type = "button"; b.className = "rush-acct-out"; b.textContent = at("out"); b.onclick = signOut;
      p.append(" ", b); acctBox.append(p);
      let mg = null; try { mg = JSON.parse(store.get("hr-merged") || "null"); } catch {}
      if (mg) {
        const m = document.createElement("p"); m.className = "note";
        m.textContent = mg.skip ? at("mergeSkipped") : mg.n ? at("merged", String(mg.n)) : at("mergedNone");
        acctBox.append(m);
        setTimeout(() => { try { localStorage.removeItem("hr-merged"); } catch {} }, 1000);
      }
    } else if (authCfg && authCfg.google) {
      const p = document.createElement("p"); p.className = "note"; p.textContent = at("pitch");
      const slot = document.createElement("div"); slot.className = "rush-acct-btn";
      acctBox.append(p, slot);
      loadGsi().then(() => window.google.accounts.id.renderButton(slot, { type: "standard", theme: "outline", size: "medium", text: "signin_with", shape: "pill", locale: isAr() ? "ar" : "en" })).catch(() => {});
    }
    if (acctMsg) { const m = document.createElement("p"); m.className = "note warn"; m.textContent = at(acctMsg); acctBox.append(m); }
  }
  onBody(async () => {
    const hint = document.getElementById("nameHint");
    if (!hint) return;
    acctBox = document.createElement("div"); acctBox.className = "rush-acct";
    hint.after(acctBox);
    const st = document.createElement("style");
    st.textContent = ".rush-acct{display:grid;gap:6px;margin-top:4px}.rush-acct p{margin:0}.rush-acct-out{font:600 13px var(--f-body,system-ui,sans-serif);background:none;border:0;padding:0;color:var(--accent,#2c56e0);text-decoration:underline;cursor:pointer}.rush-acct-btn{min-height:32px}";
    document.head.appendChild(st);
    // the page's language switch changes <html lang>: redraw in the new language
    new MutationObserver(renderAcct).observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
    renderAcct();
    await ready;
    try { authCfg = await get("/api/auth/config"); } catch { authCfg = { google: null }; }
    renderAcct();
  });

  // one visit count per page load (the admin page's visitor numbers): which game, and this device's player id
  try {
    const pg = (location.pathname.match(/\/(hangman|trivia|harf)(\/|$)/) || [])[1] || "home", b = JSON.stringify({ p: pg, v: uid });
    if (!(navigator.sendBeacon && navigator.sendBeacon(http("/api/hit"), b))) fetch(http("/api/hit"), { method: "POST", body: b, keepalive: true }).catch(() => {});
  } catch {}
  window.Rush = { api: API, http, uid, token, store, room, db, trivia, harf, ready, moveLink,
    server: () => serverState, onServer(f) { serverListeners.add(f); queueMicrotask(() => f(serverState)); return () => serverListeners.delete(f); } };
  const caps = { room, db, user, daily };
  window.claude = { use: name => Promise.resolve(caps[name] || null) };
})();
