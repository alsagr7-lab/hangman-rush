// Stand-in for the claude.ai artifact runtime, so the game runs on its own server.
// Implements the small part of claude.use("room" | "db" | "user") the game needs.
(function () {
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  };
  const rand = n => { const a = new Uint8Array(n); crypto.getRandomValues(a); return [...a].map(b => b.toString(16).padStart(2, "0")).join(""); };
  let uid = store.get("hr-uid"); if (!uid) { uid = "p_" + rand(10); store.set("hr-uid", uid); }
  let token = store.get("hr-token"); if (!token) { token = rand(24); store.set("hr-token", token); }

  /* ---------- room ---------- */
  const wsUrl = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws";
  let ws = null, open = false, myPeer = null;
  const joined = new Map(); // name -> state
  const connListeners = new Set();

  function sendRaw(obj) { if (open) ws.send(JSON.stringify(obj)); }
  function setOpen(v) { open = v; connListeners.forEach(f => { try { f(v); } catch {} }); joined.forEach(s => s.conn.forEach(f => { try { f(v); } catch {} })); }

  function connect() {
    ws = new WebSocket(wsUrl);
    ws.onopen = () => {
      setOpen(true);
      joined.forEach((s, name) => sendRaw({ t: "join", room: name, presence: s.presence }));
    };
    ws.onclose = () => { setOpen(false); setTimeout(connect, 1200); };
    ws.onerror = () => {};
    ws.onmessage = ev => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      const s = joined.get(m.room); if (!s) return;
      if (m.t === "error") { if (s.pending) { s.pending.reject({ code: m.code, message: "Room limit reached" }); s.pending = null; joined.delete(m.room); } return; }
      if (m.t !== "peers") return;
      myPeer = m.me;
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
        setTimeout(() => { if (s.pending) { s.pending = null; joined.delete(name); reject({ code: "upstream_error", message: "Server didn't answer" }); } }, 10000);
      });
    },
  };

  /* ---------- db (players collection only) ---------- */
  const snapListeners = new Set();
  let lastRows = [];
  async function refresh() {
    try {
      const r = await fetch("/api/players", { cache: "no-store" });
      if (!r.ok) throw new Error(r.status);
      lastRows = await r.json();
      const snap = { docs: lastRows.map(row => ({ id: row.id, exists: true, data: () => row.data })) };
      snapListeners.forEach(s => { try { s.next(snap); } catch (e) { console.error(e); } });
    } catch (e) {
      snapListeners.forEach(s => { if (s.err) { try { s.err({ code: "unavailable", message: String(e) }); } catch {} } });
      snapListeners.clear();
    }
  }
  setInterval(() => { if (snapListeners.size && document.visibilityState === "visible") refresh(); }, 15000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && snapListeners.size) refresh(); });

  const db = {
    collection(path) {
      return {
        onSnapshot(next, err) { const s = { next, err }; snapListeners.add(s); refresh(); return () => snapListeners.delete(s); },
      };
    },
    doc(path) {
      const id = path.split("/")[1];
      return {
        async set(data) {
          const r = await fetch("/api/players/" + encodeURIComponent(id), {
            method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, data }),
          });
          if (!r.ok) throw { code: r.status === 403 ? "permission_denied" : "invalid_argument", message: "Save failed (" + r.status + ")" };
          refresh();
        },
      };
    },
  };

  /* ---------- user ---------- */
  const user = { id: async () => uid, isOwner: () => false, canEdit: () => false, can: () => true };

  const caps = { room, db, user };
  window.claude = { use: name => Promise.resolve(caps[name] || null) };
})();
