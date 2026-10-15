// Connects the pages to the game server: player identity, live rooms (WebSocket), the Hangman leaderboard,
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
     the static site; this pings the server and shows a small notice until it answers. */
  const serverListeners = new Set();
  let serverState = "checking"; // checking | waking | up | down
  function setServer(s) { if (s === serverState) return; serverState = s; serverListeners.forEach(f => { try { f(s); } catch {} }); paintNotice(); }
  let notice = null;
  function paintNotice() {
    const ar = (store.get("hr-lang") || document.documentElement.lang) === "ar";
    const msg = serverState === "waking" ? (ar ? "جارٍ إيقاظ خادم اللعبة… قد يستغرق ذلك دقيقة." : "Waking up the game server… this can take up to a minute.")
      : serverState === "down" ? (ar ? "تعذّر الوصول إلى خادم اللعبة. اللعب الفردي يعمل، وسنحاول مجدداً." : "Can't reach the game server. Solo practice still works; retrying.")
      : "";
    if (!msg) { if (notice) notice.hidden = true; return; }
    if (!notice) {
      notice = document.createElement("div");
      notice.setAttribute("role", "status");
      notice.style.cssText = "position:fixed;inset-inline:0;bottom:0;z-index:50;padding:10px 16px calc(10px + env(safe-area-inset-bottom,0px));font:600 14px system-ui,sans-serif;text-align:center;background:#1b2333;color:#fff";
      document.body.appendChild(notice);
    }
    notice.hidden = false; notice.dir = ar ? "rtl" : "ltr"; notice.textContent = msg;
  }
  async function ping() {
    const started = Date.now();
    const slow = setTimeout(() => { if (serverState !== "up") setServer("waking"); }, 1500);
    while (Date.now() - started < 120000) {
      try {
        const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 20000);
        const r = await fetch(http("/healthz"), { cache: "no-store", signal: ctl.signal });
        clearTimeout(to);
        if (r.ok) { clearTimeout(slow); setServer("up"); return true; }
      } catch {}
      await new Promise(r => setTimeout(r, 2500));
    }
    clearTimeout(slow); setServer("down");
    setTimeout(ping, 30000);
    return false;
  }
  const ready = new Promise(res => { const f = s => { if (s === "up") { serverListeners.delete(f); res(); } }; serverListeners.add(f); });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ping); else ping();

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
     collection("players") is Hangman's (each device writes its own record); collection("trivia") is read-only here,
     because the server writes Trivia records itself. */
  function collection(kind) {
    const listeners = new Set();
    const url = kind === "trivia" ? "/api/trivia/players" : "/api/players";
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
        listeners.forEach(s => { if (s.err) { try { s.err({ code: "unavailable", message: String(e) }); } catch {} } });
        listeners.clear();
      }
    }
    setInterval(() => { if (listeners.size && document.visibilityState === "visible") refresh(); }, 15000);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && listeners.size) refresh(); });
    return { refresh, onSnapshot(next, err) { const s = { next, err }; listeners.add(s); refresh(); return () => listeners.delete(s); } };
  }
  const cols = {};
  const colOf = k => (cols[k] = cols[k] || collection(k));
  const db = {
    collection(path) { return colOf(path === "trivia" ? "trivia" : "players"); },
    doc(path) {
      const id = path.split("/")[1];
      return {
        async set(data) {
          const r = await fetch(http("/api/players/" + encodeURIComponent(id)), {
            method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, data }),
          });
          if (!r.ok) throw { code: r.status === 403 ? "permission_denied" : "invalid_argument", message: "Save failed (" + r.status + ")" };
          colOf("players").refresh();
        },
      };
    },
  };

  /* ---------- user ---------- */
  const user = { id: async () => uid, isOwner: () => false, canEdit: () => false, can: () => true };

  /* ---------- Hangman daily word (served one day at a time) ---------- */
  const daily = {
    async today() {
      await Promise.race([ready, new Promise(r => setTimeout(r, 70000))]);
      const r = await fetch(http("/api/daily"), { cache: "no-store" });
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

  window.Rush = { api: API, http, uid, token, store, room, db, trivia, ready, moveLink,
    server: () => serverState, onServer(f) { serverListeners.add(f); queueMicrotask(() => f(serverState)); return () => serverListeners.delete(f); } };
  const caps = { room, db, user, daily };
  window.claude = { use: name => Promise.resolve(caps[name] || null) };
})();
