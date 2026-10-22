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
     their leaderboard entry. The fragment never reaches any server. A player signed in with Google here is never
     replaced by one coming from an old address (an old bookmark used to swap a signed-in player for a guest). */
  const MOVED = ["hr-me", "hr-lang", "hr-daily", "hr-daily-ar", "hr-cv", "tr-cv", "hr-acct"];
  (function adopt() {
    const m = location.hash.match(/^#move=([A-Za-z0-9_-]{8,64})\.([0-9a-f]{16,128})(?:\.(.*))?$/);
    if (!m) return;
    const here = store.get("hr-uid");
    if (here && here !== m[1] && store.get("hr-acct")) { history.replaceState(null, "", location.pathname + location.search); return; }
    store.set("hr-uid", m[1]); store.set("hr-token", m[2]);
    if (m[3]) { try { const extra = JSON.parse(decodeURIComponent(m[3])); for (const k of MOVED) if (typeof extra[k] === "string") store.set(k, extra[k]); } catch {} }
    history.replaceState(null, "", location.pathname + location.search);
  })();
  // an old onrender.com address only forwards (leaveOld below): it carries a player it really had, and never saves a
  // new one, which a later visit would otherwise carry over in place of the player at the public address
  const oldAddress = !!HOME && /\.onrender\.com$/i.test(location.hostname) && (() => { try { return new URL(HOME).origin !== location.origin; } catch { return false; } })();
  const hadPlayer = !!store.get("hr-uid");
  let uid = store.get("hr-uid"); if (!uid) { uid = "p_" + rand(10); if (!oldAddress) store.set("hr-uid", uid); }
  let token = store.get("hr-token"); if (!token) { token = rand(24); if (!oldAddress) store.set("hr-token", token); }
  function moveLink(target) {
    const extra = {};
    for (const k of MOVED) { const v = store.get(k); if (v) extra[k] = v; }
    return target.replace(/\/+$/, "") + location.pathname + "#move=" + uid + "." + token + "." + encodeURIComponent(JSON.stringify(extra));
  }
  // an old onrender.com address: carry the player (id, profile, sign-in) over to the public address. One that never
  // had a player in this browser just sends the visitor on, so a made-up guest can't replace the player there.
  (function leaveOld() {
    if (!oldAddress) return;
    location.replace(hadPlayer ? moveLink(HOME) : HOME.replace(/\/+$/, "") + location.pathname + location.search);
  })();
  // the link put in shared results
  function shareUrl() { return (HOME || location.origin) + location.pathname; }
  // Keeps the address on the page's language: /ar/... in Arabic, /... in English, so a shared link opens (and
  // previews) in the language it was shared from. Runs now and whenever the page switches language.
  function syncLangPath() {
    const ar = document.documentElement.lang === "ar", base = basePath();
    const want = (ar ? "/ar" + (base === "/" ? "/" : base) : base);
    if (want !== location.pathname) { try { history.replaceState(history.state, "", want + location.search + location.hash); } catch {} }
  }
  new MutationObserver(syncLangPath).observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
  document.addEventListener("DOMContentLoaded", syncLangPath);
  // links between the pages follow the language the page is in now (the Arabic copies are built with /ar/ links,
  // and the English ones with plain links, but either can be switched after loading)
  document.addEventListener("click", e => {
    const a = e.target.closest && e.target.closest("a[href]");
    if (!a) return;
    const m = a.getAttribute("href").match(/^\/(?:ar\/)?((?:hangman|trivia|harf)\/)?$/);
    if (m) a.setAttribute("href", (document.documentElement.lang === "ar" ? "/ar/" : "/") + (m[1] || ""));
  }, true);

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
    hub: { en: "Rush Games", ar: "ألعاب رش" },
  };
  // the page's address without the /ar/ prefix the Arabic copies live under
  const basePath = () => location.pathname.replace(/^\/ar(?=\/|$)/, "") || "/";
  const gameKey = /^\/hangman/.test(basePath()) ? "hangman" : /^\/trivia/.test(basePath()) ? "trivia" : /^\/harf/.test(basePath()) ? "harf" : "hub";
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
.rush-splash{position:fixed;inset:0;z-index:100;display:grid;place-items:center;padding:24px 16px;background:var(--bg,#0B0C10);color:var(--ink,#F4F1EA);transition:opacity .18s ease-out}
.rush-splash.out{opacity:0;pointer-events:none}
.rush-splash .in{width:min(420px,100%);display:grid;gap:16px;text-align:center}
.rush-splash .gtile{justify-self:center;width:76px;height:76px;border-radius:24px}
.rush-splash .wl{font:600 12px var(--f-display,system-ui,sans-serif);font-stretch:125%;color:var(--muted,#9EA3B0);letter-spacing:.18em;text-transform:uppercase}
.rush-splash[dir="rtl"] .wl{letter-spacing:0;text-transform:none;font:700 14px var(--f-ar,system-ui,sans-serif)}
.rush-splash h1{font-family:var(--f-display,system-ui,sans-serif);font-stretch:118%;font-weight:800;font-size:clamp(36px,11vw,56px);line-height:1;margin:0}
.rush-splash[dir="rtl"] h1{font-family:var(--f-ar,system-ui,sans-serif);font-stretch:100%;font-weight:900;line-height:1.25}
.rush-splash p{margin:0;font:16px/1.5 var(--f-body,system-ui,sans-serif);color:var(--soft,#B4B8C3)}
.rush-splash .track{height:8px;border-radius:99px;overflow:hidden;background:var(--key,#262A35)}
.rush-splash .fill{height:100%;width:100%;transform:scaleX(.03);transform-origin:left;background:var(--accent,#F2B544);border-radius:99px;transition:transform .6s cubic-bezier(.23,1,.32,1)}
.rush-splash[dir="rtl"] .fill{transform-origin:right}
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
      if (bar && serverState !== "up") bar.style.transform = "scaleX(" + (Math.min(95, 3 + 92 * (1 - Math.exp(-t / 25000))) / 100).toFixed(3) + ")";
      if (t > SLOW_MS && slowBox && !blocked) slowBox.hidden = false;
    }, 500);
  }
  function hideSplash(byUser) {
    dismissed = true; clearInterval(ticker);
    if (!splash) return;
    const el = splash; splash = null;
    if (byUser) { el.remove(); return; }
    bar.style.transform = "none"; bar.classList.add("ok"); line.textContent = TXT[isAr() ? "ar" : "en"].ready;
    setTimeout(() => { el.classList.add("out"); setTimeout(() => el.remove(), 220); }, 450);
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

  /* ---------- the daily leaderboards (shared by the three games) ----------
     The server ranks everyone (/api/board) and sends the top 50 plus your own row; this draws them in the page's
     <aside class="board"> (#boardLbl, #pcount, #tabs, #players), the same way in every game, including the small
     menu version. A page calls Rush.board.init({game, lg, active}) once, then board.show() from its own render while
     the daily board should be showing, and board.refresh() after a daily finishes. */
  const BTXT = {
    en: { today: "Today", yday: "Yesterday", season: "Season", seasonN: "Season {n}", dayOf: "Day {d}/{t}", left: "{n} days left", tonight: "Resets tonight",
      final: "Final {n} days", yEmpty: "No results for yesterday.", you: "you", streak: "streak {n}", err: "The leaderboard didn't load. Your results are still saved on the server.",
      loading: "Loading…", secs: "{n}s", solved: "Solved {t}", hanged: "Hanged", miss1: "1 miss", missN: "{n} misses", noMiss: "no misses", hint1: "1 hint", hintN: "{n} hints",
      rare: "+{n} rare", pending: "Yesterday's bonuses are being added…", harfToday: "Today's answers stay hidden until tomorrow. Points here don't include rarity bonuses yet.",
      gap: "Your place" },
    ar: { today: "اليوم", yday: "أمس", season: "الموسم", seasonN: "الموسم {n}", dayOf: "اليوم {d} من {t}", left: "باقي {n} أيام", tonight: "يبدأ من جديد الليلة",
      final: "آخر {n} أيام", yEmpty: "لا نتائج ليوم أمس.", you: "أنت", streak: "السلسلة {n}", err: "تعذّر تحميل لوحة الترتيب. نتائجك محفوظة على الخادم.",
      loading: "جارٍ التحميل…", secs: "{n} ث", solved: "حلّها في {t}", hanged: "شُنق", miss1: "خطأ واحد", missN: "الأخطاء: {n}", noMiss: "بلا أخطاء", hint1: "تلميح واحد", hintN: "تلميحات: {n}",
      rare: "+{n} ندرة", pending: "جارٍ إضافة مكافآت الأمس…", harfToday: "إجابات اليوم تبقى مخفية حتى الغد. النقاط هنا لا تشمل مكافآت الندرة بعد.",
      gap: "ترتيبك" },
  };
  const BGAME = {
    hangman: {
      en: { label: "Daily leaderboard", tEmpty: "Nobody has played today's word yet. Be first.", sEmpty: "Season standings show up after the first daily word is played.",
        note: "Ranked by total daily points this season. Everything resets when Season {n} starts.", of: "{w}/{p} solved · best streak {b}" },
      ar: { label: "ترتيب كلمة اليوم", tEmpty: "لم يلعب أحد كلمة اليوم بعد. كن الأول.", sEmpty: "يظهر ترتيب الموسم بعد أول مشاركة في كلمة اليوم.",
        note: "الترتيب حسب مجموع نقاط كلمة اليوم في هذا الموسم. كل شيء يبدأ من جديد مع الموسم {n}.", of: "حلّ {w} من {p} · أفضل سلسلة {b}" } },
    trivia: {
      en: { label: "Daily leaderboard", tEmpty: "Nobody has played today's questions yet. Be first.", sEmpty: "Season standings show up after the first daily is played.",
        note: "Ranked by total daily points this season. Everything resets when Season {n} starts.", of: "{w} of {p} days with 3+ right · best streak {b}" },
      ar: { label: "ترتيب أسئلة اليوم", tEmpty: "لم يلعب أحد أسئلة اليوم بعد. كن الأول.", sEmpty: "يظهر ترتيب الموسم بعد أول مشاركة في أسئلة اليوم.",
        note: "الترتيب حسب مجموع نقاط أسئلة اليوم في هذا الموسم. كل شيء يبدأ من جديد مع الموسم {n}.", of: "{w} من {p} أيام بـ3 صحيحة أو أكثر · أفضل سلسلة {b}" } },
    harf: {
      en: { label: "Daily leaderboard", tEmpty: "Nobody has played today's letter yet. Be first.", sEmpty: "Season standings show up after the first daily is played.",
        note: "Ranked by total daily points this season, rarity bonuses included. Everything resets when Season {n} starts.", of: "{w} perfect days of {p}" },
      ar: { label: "ترتيب حرف اليوم", tEmpty: "لم يلعب أحد حرف اليوم بعد. كن الأول.", sEmpty: "يظهر ترتيب الموسم بعد أول مشاركة في حرف اليوم.",
        note: "الترتيب حسب مجموع نقاط حرف اليوم في هذا الموسم، مع مكافآت الندرة. كل شيء يبدأ من جديد مع الموسم {n}.", of: "{w} أيام كاملة من {p}" } },
  };
  const LANGS = { hangman: ["ar", "en"], trivia: [], harf: ["ar", "en"] };
  function makeBoard() {
    let o = null, tab = "today", lgSel = null;
    const cacheB = new Map(); // "lg|tab" -> { at, data, err }
    const ui = () => (document.documentElement.lang === "ar" ? "ar" : "en");
    const fill = (s, v) => String(s).replace(/\{(\w+)\}/g, (m, k) => (v && k in v ? v[k] : m));
    const T = (k, v) => fill(BTXT[ui()][k], v), G = (k, v) => fill(BGAME[o.game][ui()][k], v);
    const q = id => document.getElementById(id);
    const mk = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
    const lgNow = () => (LANGS[o.game].length ? lgSel || (o.lg && o.lg()) || "en" : "");
    const keyNow = () => lgNow() + "|" + tab;
    async function load(force) {
      const key = keyNow(), c = cacheB.get(key);
      if (!force && c && Date.now() - c.at < 15000) return;
      try {
        await ready;
        const r = await fetch(http("/api/board?game=" + o.game + "&lg=" + encodeURIComponent(lgNow()) + "&tab=" + tab + "&me=" + encodeURIComponent(uid)), { cache: "no-store" });
        if (!r.ok) throw new Error(r.status);
        cacheB.set(key, { at: Date.now(), data: await r.json(), err: false });
      } catch { cacheB.set(key, { at: Date.now() - 10000, data: c && c.data, err: true }); }
      if (o.active()) draw();
    }
    const fmtS = ms => T("secs", { n: (ms / 1000).toFixed(1) });
    function detail(r) {
      const pp = mk("div", "pp"), d = r.d || {}, g = o.game;
      if (tab === "season") pp.append(mk("span", null, G("of", { w: d.w, p: d.p, b: d.b })));
      else if (g === "hangman") {
        if (d.ok) pp.append(mk("span", "ok", T("solved", { t: fmtS(d.t) }) + " · " + (d.m ? (d.m === 1 ? T("miss1") : T("missN", { n: d.m })) : T("noMiss")) + (d.hn ? " · " + (d.hn === 1 ? T("hint1") : T("hintN", { n: d.hn })) : "")));
        else pp.append(mk("span", "dead", T("hanged")));
      } else if (g === "trivia") {
        const m = mk("span", "marks");
        String(d.s || "").split("").slice(0, 5).forEach(ch => m.append(ch === "1" ? mk("b", null, "✓") : ch === "0" ? mk("s", null, "✗") : document.createTextNode("·")));
        pp.append(m, mk("span", null, fmtS(d.t)));
      } else {
        pp.append(mk("span", null, d.c + "/5" + (tab === "yday" && d.L ? " · " + d.L : "")));
        if (tab === "yday" && d.rb) pp.append(mk("span", "ok", T("rare", { n: d.rb })));
      }
      if (r.streak) pp.append(mk("span", "streak", g === "harf" ? "🔥 " + r.streak : T("streak", { n: r.streak })));
      if (g === "harf" && tab === "yday" && Array.isArray(d.a)) {
        const w = mk("div", "words"); w.dir = "auto";
        d.a.forEach((a, i) => { if (i) w.append(document.createTextNode(" · ")); const t = a && a.w ? a.w : "—"; w.append(a && a.ok ? mk("b", null, t) : mk("s", null, t)); });
        pp.append(w);
      }
      return pp;
    }
    function row(r, first, info) {
      const el = mk("div", "pl" + (first ? " first" : "")), dot = mk("span", "dot"); dot.style.background = r.c;
      const nm = mk("span", "pn"), rk = mk("span", "rkn", String(r.rank)); rk.dataset.r = String(r.rank);
      nm.append(rk);
      const md = medals(r.aw, info, o.game); if (md) nm.append(md);
      nm.append(whoBtn(r.n)); if (r.id) el.dataset.pid = r.id;
      if (r.tag) nm.append(mk("small", "tag", "#" + r.tag));
      if (r.me) nm.append(mk("small", "me", T("you")));
      el.append(dot, nm, mk("span", "ps", String(r.pts)), detail(r));
      return el;
    }
    function draw() {
      const box = q("players"); if (!box || !o) return;
      const g = o.game, lg = lgNow(), c = cacheB.get(keyNow()), data = c && c.data;
      const lbl = q("boardLbl"); if (lbl) lbl.textContent = G("label");
      const tabs = q("tabs");
      if (tabs) { tabs.hidden = false; tabs.querySelectorAll("button").forEach(b => { b.setAttribute("aria-selected", String(b.dataset.t === tab)); b.textContent = T(b.dataset.t); }); }
      const pc = q("pcount");
      if (pc) {
        pc.textContent = "";
        if (LANGS[g].length) {
          const sw = mk("span", "lgsw");
          LANGS[g].forEach(L => { const b = mk("button", null, L === "ar" ? "عربي" : "EN"); b.type = "button"; b.lang = L; b.setAttribute("aria-pressed", String(L === lg)); b.setAttribute("aria-label", L === "ar" ? "عربي" : "English");
            b.onclick = () => { lgSel = L; draw(); load(); }; sw.append(b); });
          pc.append(sw);
        } else if (data) pc.textContent = T("seasonN", { n: data.se });
      }
      box.textContent = "";
      if (!data) { box.append(mk("p", "note", c && c.err ? T("err") : T("loading"))); return; }
      const left = data.left, bar = mk("div", "seasonbar" + (left <= 3 ? " final" : "")), meter = mk("span", "meter"), fillEl = mk("i");
      fillEl.style.width = Math.round(100 * (data.day - 1) / data.len) + "%"; meter.append(fillEl);
      bar.append(mk("span", null, (LANGS[g].length ? T("seasonN", { n: data.se }) + " · " : "") + T("dayOf", { d: data.day, t: data.len })), meter,
        mk("span", null, left === 1 ? T("tonight") : left <= 3 ? T("final", { n: left }) : T("left", { n: left })));
      box.append(bar);
      if (!data.rows.length) box.append(mk("div", "empty", tab === "today" ? G("tEmpty") : tab === "yday" ? T("yEmpty") : G("sEmpty")));
      data.rows.forEach((r, i) => box.append(row(r, i === 0, data.awards)));
      if (data.me) { box.append(mk("p", "note", T("gap"))); box.append(row(data.me, false, data.awards)); }
      if (tab === "season") box.append(mk("p", "note", G("note", { n: data.se + 1 })));
      if (g === "harf" && tab === "today" && data.rows.length) box.append(mk("p", "note", T("harfToday")));
      if (g === "harf" && tab === "yday" && data.rows.some(r => r.d && r.d.rb == null)) box.append(mk("p", "note", T("pending")));
      if (c.err) box.append(mk("p", "note", T("err")));
    }
    return {
      init(opts) {
        o = Object.assign({ active: () => true }, opts);
        const tabs = q("tabs");
        if (tabs) tabs.addEventListener("click", e => { const b = e.target.closest("button[data-t]"); if (!b || !o.active()) return; tab = b.dataset.t; draw(); load(); });
        // no timer: a fresh copy when the board opens, after you finish a daily (refresh), and when the page comes back into view
        document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && o.active()) load(); });
        new MutationObserver(() => { if (o.active()) draw(); }).observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
      },
      show() { if (!o) return; draw(); load(); },
      refresh() { cacheB.clear(); if (o && o.active()) load(true); },
      reset() { tab = "today"; lgSel = null; },
    };
  }
  const board = makeBoard();

  /* ---------- your own records, and one name and colour for every game ---------- */
  async function mineRecs() {
    await ready;
    const r = await fetch(http("/api/me?uid=" + encodeURIComponent(uid)), { cache: "no-store" });
    if (!r.ok) throw new Error("me " + r.status);
    return r.json();
  }
  let profSent = "";
  async function saveProfile() {
    let me = null; try { me = JSON.parse(localStorage.getItem("hr-me") || "null"); } catch {}
    if (!me) return;
    const n = String(me.nick || "").trim(), key = n + "|" + me.color;
    if (key === profSent || n.length < 2 || n.toLowerCase() === "player") return;
    profSent = key;
    try { await post("/api/profile", { n, c: me.color }); board.refresh(); } catch { profSent = ""; }
  }

  /* ---------- user ---------- */
  const user = { id: async () => uid, isOwner: () => false, canEdit: () => false, can: () => true };

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
          fail: "Sign-in didn't work. Try again in a moment.", relink: "This browser lost track of your Google account. Sign in again to get your progress back.", taken: "This progress is already linked to a different Google account.",
          guest: "Playing as a guest", saved: "Progress saved to Google", priv: "We don't keep your email or name, only your Google account number, so your progress can follow you.",
          save: "Save progress", saveShort: "Save", profile: "Your profile", close: "Close", allGames: "All games", home: "Rush Games home",
          switchT: "Switch to this account?", switchOk: "Switch account", outT: "Sign out?", cancel: "Cancel",
          plusFree: "Free plan", plusSee: "See plans", me: "Your profile" },
    ar: { pitch: "سجّل الدخول بحساب Google لتحتفظ بسلاسلك ونقاطك على أي جهاز.", as: "مسجّل باسم {e}. تقدّمك محفوظ في حساب Google.",
          out: "تسجيل الخروج", outQ: "تسجيل الخروج من هذا الجهاز؟ سيبدأ كضيف جديد، ويبقى تقدّمك محفوظاً في حساب Google.",
          switchQ: "لهذا الحساب تقدّم من جهاز آخر. هل تنتقل إليه؟ ستُضاف نتائجك من هذا الجهاز إليه (إذا لعب الجهازان نفس اليوم تُحتسب النتيجة الأولى).",
          merged: "أُضيفت {e} يوماً من جهازك الآخر.", mergedNone: "لا جديد لإضافته من جهازك الآخر.", mergeSkipped: "سبق أن أُضيفت نتائج جهاز آخر هذا الموسم، فلم تُضف نتائج هذا الجهاز.",
          fail: "تعذّر تسجيل الدخول. حاول بعد لحظات.", relink: "فقد هذا المتصفح ربطه بحسابك في Google. سجّل الدخول من جديد لتستعيد تقدّمك.", taken: "هذا التقدّم مرتبط بحساب Google آخر.",
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
  const SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/></svg>';
  const MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 14.2A8.5 8.5 0 1 1 9.8 3.5a6.8 6.8 0 0 0 10.7 10.7z"/></svg>';
  /* ---------- light / dark ----------
     The page's head has already set <html data-theme> (saved choice, else the device setting). The button flips it and
     saves the choice; with no saved choice the page keeps following the device if its setting changes. */
  const THEME_BG = { dark: "#0B0C10", light: "#F5F3EE" };
  const themeNow = () => (document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark");
  function setTheme(t, save) {
    document.documentElement.setAttribute("data-theme", t);
    if (save) { try { localStorage.setItem("rush-theme", t); } catch {} }
    document.querySelectorAll('meta[name="theme-color"]').forEach(m => m.setAttribute("content", THEME_BG[t]));
    if (themeBtn) {
      const ar = document.documentElement.lang === "ar", toLight = t === "dark";
      themeBtn.textContent = ""; themeBtn.append(svg(toLight ? SUN : MOON));
      const l = toLight ? (ar ? "الوضع الفاتح" : "Light mode") : (ar ? "الوضع الداكن" : "Dark mode");
      themeBtn.setAttribute("aria-label", l); themeBtn.title = l;
    }
  }
  let themeBtn = null;
  try {
    const mq = window.matchMedia && matchMedia("(prefers-color-scheme: light)");
    const saved = () => { try { return localStorage.getItem("rush-theme"); } catch { return null; } };
    if (mq && mq.addEventListener) mq.addEventListener("change", e => { if (saved() !== "light" && saved() !== "dark") setTheme(e.matches ? "light" : "dark", false); });
  } catch {}
  const BACK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>';
  const mkEl = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  // player profiles' words and state (the code is further down, by the medals)
  const PV = {
    en: { loading: "Loading…", none: "This player isn't on any board.", err: "Couldn't load this profile. Try again in a moment.", close: "Close", you: "You",
      privTitle: "Private profile", privOther: "{n} keeps their stats private.", privMine: "Your profile is private: others see only your name and tag.",
      signIn: "Sign in to make your profile private.", week: "This week", season: "Season {s}", days: "Days played", streak: "Streak", best: "best {b}",
      boards: "Leaderboards", shelf: "Trophy shelf", noMedals: "No medals yet. Finish a week in the top 3 of any board to win one.", history: "Medal history",
      none2: "No results this season yet.", lastSeason: "Season {s}: {p} pts", times: "×{n}", privT: "Private profile",
      privS: "Others see only your name and tag. You still appear on the leaderboards.", privErr: "Couldn't change that. Try again.", mine: "View my profile" },
    ar: { loading: "جارٍ التحميل…", none: "هذا اللاعب غير موجود في أي لوحة.", err: "تعذّر تحميل الملف. حاول بعد قليل.", close: "إغلاق", you: "أنت",
      privTitle: "ملف خاص", privOther: "{n} يُبقي إحصاءاته خاصة.", privMine: "ملفك خاص: يرى الآخرون اسمك ورمزك فقط.",
      signIn: "سجّل الدخول لتجعل ملفك خاصاً.", week: "هذا الأسبوع", season: "الموسم {s}", days: "أيام اللعب", streak: "السلسلة", best: "الأفضل {b}",
      boards: "لوحات الترتيب", shelf: "خزانة الجوائز", noMedals: "لا ميداليات بعد. أنهِ أسبوعاً ضمن أول 3 في أي لوحة لتفوز بواحدة.", history: "سجل الميداليات",
      none2: "لا نتائج في هذا الموسم بعد.", lastSeason: "الموسم {s}: {p} نقطة", times: "×{n}", privT: "ملف خاص",
      privS: "يرى الآخرون اسمك ورمزك فقط، وتبقى في لوحات الترتيب.", privErr: "تعذّر التغيير. حاول مرة أخرى.", mine: "عرض ملفي" },
  };
  const pt = (k, v) => { let s = PV[document.documentElement.lang === "ar" ? "ar" : "en"][k]; for (const [a, b] of Object.entries(v || {})) s = s.split("{" + a + "}").join(String(b)); return s; };
  let pv = null, pvBg = null, pvOpen = false, pvBack = null, pvId = null, pvData = null, privOn = null;

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
      acctBox.append(privToggle()); loadPriv();
      const b = mkEl("button", "rush-acct-out", at("out")); b.type = "button"; b.onclick = signOut; acctBox.append(b);
    } else if (authCfg && authCfg.google) {
      const head = mkEl("p", "ah"); head.append(svg(CLOUD), document.createTextNode(at("guest")));
      head.firstChild.style.color = "var(--gold)";
      gsiSlot = mkEl("div", "rush-acct-btn");
      acctBox.append(head, mkEl("p", "pitch", at("pitch")), gsiSlot, mkEl("p", "priv", at("priv")));
      drawGsi();
    }
    if (acctMsg) acctBox.append(mkEl("p", "note warn", at(acctMsg)));
    const mineB = mkEl("button", "rsheet-mine", pt("mine")); mineB.type = "button"; mineB.onclick = () => openPlayer(uid);
    acctBox.prepend(mineB);
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
  // phone sheet: drag the handle or header down to close; a quick flick is enough, and dragging up meets friction
  function dragToClose() {
    const phone = matchMedia("(max-width:759px)");
    let y0 = 0, t0 = 0, dy = 0, id = null;
    const set = d => { sheet.style.transform = "translateY(" + d + "px)"; sheetBg.style.opacity = String(Math.max(0, 1 - d / (sheet.offsetHeight || 400))); };
    sheet.addEventListener("pointerdown", e => {
      if (id !== null || !phone.matches || !sheetOpen || e.button > 0) return;
      if (!e.target.closest || !e.target.closest(".grab,.rsheet-head") || e.target.closest("button,a,input")) return;
      id = e.pointerId; y0 = e.clientY; t0 = performance.now(); dy = 0;
      sheet.classList.add("drag"); sheetBg.classList.add("drag");
      try { sheet.setPointerCapture(id); } catch {}
    });
    sheet.addEventListener("pointermove", e => {
      if (e.pointerId !== id) return;
      const d = e.clientY - y0; dy = d >= 0 ? d : -Math.sqrt(-d) * 2;
      set(dy);
    });
    const end = e => {
      if (e.pointerId !== id) return;
      id = null; sheet.classList.remove("drag"); sheetBg.classList.remove("drag");
      const v = Math.max(0, dy) / Math.max(1, performance.now() - t0);
      if (dy > 120 || (dy > 10 && v > 0.11)) closeSheet();
      else { sheet.style.transform = ""; sheetBg.style.opacity = ""; }
    };
    sheet.addEventListener("pointerup", end); sheet.addEventListener("pointercancel", end);
  }
  function openSheet() {
    if (!sheet || sheetOpen) return;
    sheetOpen = true; sheet.hidden = false; sheetBg.hidden = false;
    requestAnimationFrame(() => requestAnimationFrame(() => { sheet.classList.add("open"); sheetBg.classList.add("open"); drawGsi(); }));
    renderBar();
    barRefs.me.setAttribute("aria-expanded", "true");
  }
  function closeSheet() {
    setTimeout(saveProfile, 0);
    if (!sheetOpen) return;
    sheetOpen = false; sheet.classList.remove("open", "drag"); sheetBg.classList.remove("open", "drag");
    sheet.style.transform = ""; sheetBg.style.opacity = "";
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
    themeBtn = mkEl("button", "rbar-theme"); themeBtn.type = "button"; themeBtn.onclick = () => setTheme(themeNow() === "dark" ? "light" : "dark", true);
    inner.append(themeBtn); setTheme(themeNow(), false);
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
    // a new name or colour goes to every game at once (the page saves it on this device first, hence the wait)
    if (nick) nick.addEventListener("change", () => setTimeout(saveProfile, 0));
    const sw = document.getElementById("sw"); if (sw) sw.addEventListener("click", () => setTimeout(saveProfile, 0));
    ready.then(() => setTimeout(saveProfile, 1500));
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
    dragToClose();
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
    new MutationObserver(() => { renderAcct(); renderBar(); setTheme(themeNow(), false); }).observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
    renderAcct();
    await ready;
    try { authCfg = await get("/api/auth/config?uid=" + encodeURIComponent(uid)); } catch { authCfg = { google: null }; }
    // this browser says "saved in Google", but its player isn't the one linked to an account (an old address could
    // swap it, see adopt()): drop the label and ask for a sign-in, which brings the account's player back
    if (acct && authCfg && authCfg.google && authCfg.linked === false) {
      acct = null; acctMsg = "relink";
      try { localStorage.removeItem("hr-acct"); } catch {}
    }
    renderAcct(); renderBar();
  });

  // one visit count per page load (the admin page's visitor numbers): which game, and this device's player id
  try {
    const pg = (location.pathname.match(/\/(hangman|trivia|harf)(\/|$)/) || [])[1] || "home", b = JSON.stringify({ p: pg, v: uid });
    if (!(navigator.sendBeacon && navigator.sendBeacon(http("/api/hit"), b))) fetch(http("/api/hit"), { method: "POST", body: b, keepalive: true }).catch(() => {});
  } catch {}
  /* ---------- the daily board in the main menu ----------
     Each game page has one board (<aside class="board">) and a #lbSlot in its lobby. While the lobby shows, the board
     moves into the slot, small: the top three and your own row. Tapping it opens the whole board (tabs and all); once
     it's scrolled out of view it goes back to small. When a game starts the board moves back beside the game. */
  function lobbyBoard() {
    const lobby = document.getElementById("lobby"), game = document.getElementById("game"), slot = document.getElementById("lbSlot");
    const board = document.querySelector("aside.board"), grid = board && board.parentElement;
    if (!lobby || !game || !slot || !board || !grid) return;
    const ar = () => document.documentElement.lang === "ar";
    const tog = document.createElement("button"); tog.type = "button"; tog.className = "lbtog";
    board.appendChild(tog);
    const label = () => {
      const mini = board.classList.contains("mini");
      tog.textContent = mini ? (ar() ? "عرض الكل" : "See all") : (ar() ? "تصغير" : "Show less");
      tog.setAttribute("aria-expanded", String(!mini));
    };
    function setMini(on) {
      if (board.classList.contains("mini") === on) return;
      // shrinking a board that's above the screen would pull the page up under the player's thumb: keep their place
      const r = board.getBoundingClientRect(), above = on && r.top < 0, h = r.height;
      board.classList.toggle("mini", on); label();
      if (above) window.scrollBy(0, board.getBoundingClientRect().height - h);
    }
    function place() {
      const inLobby = !lobby.hidden;
      if (inLobby && board.parentElement !== slot) { slot.appendChild(board); board.classList.add("inlobby", "mini"); label(); }
      else if (!inLobby && board.parentElement !== grid) { grid.appendChild(board); board.classList.remove("inlobby", "mini"); }
    }
    // while small, any tap on the board opens it (the tabs and language switch work once it's open)
    board.addEventListener("click", e => {
      if (!board.classList.contains("inlobby")) return;
      if (board.classList.contains("mini")) { e.preventDefault(); e.stopPropagation(); setMini(false); }
      else if (e.target === tog) setMini(true);
    }, true);
    // "scrolled away": less than a strip of it left on screen (an open board can be taller than the rest of the menu,
    // so it may never leave the screen completely)
    let ticking = false;
    window.addEventListener("scroll", () => {
      if (ticking || !board.classList.contains("inlobby") || board.classList.contains("mini")) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        const r = board.getBoundingClientRect(), vh = window.innerHeight, seen = Math.min(r.bottom, vh) - Math.max(r.top, 0);
        if ((r.top < 0 && seen < Math.min(vh / 4, r.height / 3)) || r.top > vh - 60) setMini(true);
      });
    }, { passive: true });
    new MutationObserver(place).observe(lobby, { attributes: true, attributeFilter: ["hidden"] });
    new MutationObserver(label).observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
    place(); label();
  }
  onBody(lobbyBoard);

  /* ---------- room helpers every game uses ----------
     roomCode: a new 4-letter room code (no I or O, which read like 1 and 0); mePeer: this tab's own entry in a room;
     hostOf: the room's host among other players' entries (lowest peer id among those flagged h: 1), or null */
  const ROOM_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const roomCode = () => { let s = ""; for (let i = 0; i < 4; i++) s += ROOM_LETTERS[Math.floor(Math.random() * ROOM_LETTERS.length)]; return s; };
  const mePeer = api => (api ? api.peers().find(p => p.sameTab) : null);
  const hostOf = list => list.filter(p => p.presence.h === 1).sort((a, b) => (a.peer < b.peer ? -1 : 1))[0] || null;

  /* ---------- extras ----------
     The back button steps back one level (a game -> its menu -> all games), and the phone's own back does the same;
     a footer on every page (Report a problem, Privacy); a small Report button beside a game; the "Don't tell me how
     to play again" switch for each daily's rules; a short first-time tour of each game; after a daily, a small
     "next daily" chip; hub cards that open the daily straight away (#daily); room invite links (#room=CODE) that put
     you straight into the room; and an "add to Home Screen" tip on the hub. */
  const uiAr = () => document.documentElement.lang === "ar";
  const L2 = (en, ar) => (uiAr() ? ar : en);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const gameShown = () => { const g = document.getElementById("game"); return !!(g && !g.hidden); };
  const leaveGame = () => { const b = document.getElementById("leaveBtn"); if (!b) return false; b.click(); return true; };
  const arPrefix = () => (/^\/ar(\/|$)/.test(location.pathname) ? "/ar" : "");
  const onLang = f => new MutationObserver(f).observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });

  // ---- back: one level at a time ----
  function backSteps() {
    const back = document.querySelector(".rbar-back");
    if (back) back.addEventListener("click", e => { if (gameShown() && leaveGame()) { e.preventDefault(); window.scrollTo(0, 0); } });
    const g = document.getElementById("game");
    if (!g) return;
    let skipPop = false;
    // entering a game adds a step to the browser's history, so the phone's back gesture returns to the menu
    new MutationObserver(() => {
      const st = history.state || {};
      if (!g.hidden && !st.rg) { try { history.pushState(Object.assign({}, st, { rg: 1 }), ""); } catch {} }
      else if (g.hidden && st.rg) { skipPop = true; history.back(); }
    }).observe(g, { attributes: true, attributeFilter: ["hidden"] });
    window.addEventListener("popstate", () => { if (skipPop) { skipPop = false; return; } if (gameShown()) leaveGame(); });
  }

  // ---- reports ----
  let reportCtx = null;
  const KINDS = [["wrong", "Wrong answer", "الإجابة خاطئة"], ["question", "Bad question or word", "سؤال أو كلمة غير مناسبة"], ["offensive", "Offensive", "محتوى مسيء"],
    ["bug", "Something broke", "خلل في الموقع"], ["other", "Something else", "شيء آخر"]];
  function modal(build) {
    const bg = mkEl("div", "rdlg-bg"), box = mkEl("div", "rdlg rdlg-form");
    box.setAttribute("role", "dialog"); box.setAttribute("aria-modal", "true"); box.dir = uiAr() ? "rtl" : "ltr";
    const prev = document.activeElement;
    const close = () => { document.removeEventListener("keydown", key, true); bg.remove(); try { prev && prev.focus && prev.focus(); } catch {} };
    const key = e => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); } };
    document.addEventListener("keydown", key, true);
    bg.addEventListener("click", e => { if (e.target === bg) close(); });
    build(box, close); bg.append(box); document.body.append(bg);
    const f = box.querySelector("select, textarea, button"); if (f) f.focus();
    return close;
  }
  function openReport(kind) {
    let ctx = {}; try { ctx = (reportCtx && reportCtx()) || {}; } catch {}
    modal((box, close) => {
      const h = mkEl("h2", null, L2("Report a problem", "أبلغ عن مشكلة"));
      const p = mkEl("p", null, L2("Tell us what's wrong. We read every report and fix what we can.", "أخبرنا ما المشكلة. نقرأ كل بلاغ ونصلح ما نستطيع."));
      const sel = mkEl("select", "rinput"); sel.setAttribute("aria-label", L2("What kind of problem?", "نوع المشكلة"));
      KINDS.forEach(([v, en, ar]) => { const o = mkEl("option", null, uiAr() ? ar : en); o.value = v; sel.append(o); });
      sel.value = kind || (ctx.q || ctx.word || ctx.answers ? "wrong" : "bug");
      const ta = mkEl("textarea", "rinput"); ta.rows = 3; ta.maxLength = 600; ta.dir = "auto";
      ta.placeholder = L2("What's wrong? (optional if it's clear from the question)", "ما المشكلة؟ (اختياري إن كانت واضحة من السؤال)");
      ta.setAttribute("aria-label", L2("Details", "التفاصيل"));
      const info = mkEl("div", "rctx");
      const shown = Object.entries(ctx).filter(([k, v]) => v !== "" && v != null && k !== "game" && k !== "lg" && k !== "mode");
      if (shown.length) {
        info.append(mkEl("small", null, L2("We'll include what was on screen:", "سنرفق ما كان على الشاشة:")));
        shown.slice(0, 5).forEach(([k, v]) => { const d = mkEl("div"); d.dir = "auto"; d.textContent = (Array.isArray(v) ? v.join(", ") : String(v)).slice(0, 160); info.append(d); });
      }
      const msg = mkEl("p", "rmsg"); msg.hidden = true;
      const acts = mkEl("div", "acts"), send = mkEl("button", "btn primary", L2("Send report", "أرسل البلاغ")), cancel = mkEl("button", "btn", at("cancel"));
      send.type = cancel.type = "button"; cancel.onclick = close;
      send.onclick = async () => {
        send.disabled = true; msg.hidden = true;
        try {
          const lgNow = ctx.lg || (uiAr() ? "ar" : "en");
          const r = await fetch(http("/api/report"), { method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ uid, game: gameKey === "hub" ? "site" : gameKey, lg: lgNow, kind: sel.value, text: ta.value, ctx: Object.assign({ page: location.pathname }, ctx) }) });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(j.error || "");
          box.textContent = "";
          const ok = mkEl("button", "btn primary", L2("Close", "إغلاق")); ok.type = "button"; ok.onclick = close;
          box.append(mkEl("h2", null, L2("Thanks!", "شكراً!")), mkEl("p", null, L2("Your report is in. We'll take a look.", "وصل بلاغك، وسنطّلع عليه.")), ok); ok.focus();
        } catch (e) {
          msg.textContent = e.message || L2("Couldn't send it. Try again in a moment.", "تعذّر الإرسال. حاول بعد لحظات."); msg.hidden = false; send.disabled = false;
        }
      };
      acts.append(send, cancel);
      box.append(h, p, sel, ta, info, msg, acts);
    });
  }
  function openPrivacy() {
    modal((box, close) => {
      const ok = mkEl("button", "btn primary", L2("Close", "إغلاق")); ok.type = "button"; ok.onclick = close;
      const rep = mkEl("button", "btn", L2("Contact us", "تواصل معنا")); rep.type = "button"; rep.onclick = () => { close(); openReport("other"); };
      const ps = uiAr()
        ? ["نحتفظ فقط بما تحتاجه الألعاب: رقم لاعب عشوائي على جهازك، والاسم واللون اللذين تختارهما، ونتائجك.",
           "عند تسجيل الدخول بحساب Google نحفظ رقم حسابك فقط، لا بريدك ولا اسمك.",
           "نعدّ زيارات الصفحات دون حفظ عناوين IP. وتُرسل إجابات «الحروف» إلى خدمة ذكاء اصطناعي (Claude من Anthropic) للتحقق منها، والإجابات فقط.",
           "لا نبيع بياناتك ولا نشاركها للإعلانات. لحذف بياناتك أو لأي سؤال، راسلنا من زر «تواصل معنا» واذكر رمز لاعبك (#" + tagOf(uid) + ")."]
        : ["We keep only what the games need: a random player id on your device, the name and colour you pick, and your results.",
           "If you sign in with Google we keep your Google account number only, not your email or name.",
           "Page visits are counted without storing IP addresses. Harf answers are checked by an AI service (Anthropic's Claude); only the answers are sent.",
           "Nothing is sold or shared for ads. To have your data removed, or for anything else, use Contact us and mention your player tag (#" + tagOf(uid) + ")."];
      box.append(mkEl("h2", null, L2("Privacy", "الخصوصية")));
      const body = mkEl("div", "rprivacy"); ps.forEach(t => body.append(mkEl("p", null, t))); box.append(body);
      const acts = mkEl("div", "acts"); acts.append(ok, rep); box.append(acts);
    });
  }
  function footerAndReport() {
    const f = mkEl("footer", "rfoot");
    const rep = mkEl("button", "rfoot-l"), priv = mkEl("button", "rfoot-l");
    rep.type = priv.type = "button"; rep.onclick = () => openReport(); priv.onclick = openPrivacy;
    f.append(rep, mkEl("span", "rfoot-dot", "·"), priv);
    document.body.append(f);
    let side = null;
    if (gameKey !== "hub") {
      side = mkEl("button", "rreport"); side.type = "button"; side.onclick = () => openReport();
      side.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 21V4M5 4h11l-2 4 2 4H5"/></svg>';
      document.body.append(side);
      const g = document.getElementById("game");
      const vis = () => { side.hidden = !gameShown(); };
      if (g) new MutationObserver(vis).observe(g, { attributes: true, attributeFilter: ["hidden"] });
      vis();
    }
    const draw = () => {
      f.dir = uiAr() ? "rtl" : "ltr";
      rep.textContent = L2("Report a problem", "أبلغ عن مشكلة"); priv.textContent = L2("Privacy", "الخصوصية");
      if (side) { const l = L2("Report this question or answer", "أبلغ عن هذا السؤال أو الإجابة"); side.setAttribute("aria-label", l); side.title = l; }
    };
    draw(); onLang(draw);
  }

  // ---- the daily's rules: shown until the player says not to ----
  const introKey = g => "rush-nointro-" + g;
  function introText(nodes, redraw) {
    const g = gameKey, hid = store.get(introKey(g)) === "1";
    const b = mkEl("button", "linkbtn rintro"); b.type = "button";
    if (hid) { b.textContent = L2("How do I play?", "كيف ألعب؟"); b.onclick = () => { store.set(introKey(g), ""); redraw && redraw(); }; return [b]; }
    b.textContent = L2("Don't tell me how to play again 🙄", "خلاص فهمت، لا تشرح لي مرة ثانية 🙄");
    b.onclick = () => { store.set(introKey(g), "1"); redraw && redraw(); };
    return [...nodes, b];
  }

  // ---- first-time tour ----
  const TOUR = {
    hangman: { en: ["Hangman Rush", ["Guess the hidden word one letter at a time. Each wrong letter adds to the hangman; too many and you're out.",
      "The daily word is the same for everyone. Solve it fast with few misses to climb today's board. Hints help, but cost points.",
      "Rooms are for friends: make one, share the 4-letter code or link, and race on the same word."]],
      ar: ["سباق المشنقة", ["خمّن الكلمة المخفية حرفاً حرفاً. كل حرف خاطئ يضيف جزءاً للمشنقة، وإذا كثرت الأخطاء تخسر.",
      "كلمة اليوم واحدة للجميع. حلّها بسرعة وبأخطاء قليلة لتتصدر لوحة اليوم. التلميحات تساعد لكنها تخصم نقاطاً.",
      "الغرف للأصحاب: أنشئ غرفة، شارك الرمز أو الرابط، وتسابقوا على نفس الكلمة."]] },
    trivia: { en: ["Trivia Rush", ["Five questions, a few seconds each. Pick the right answer before the bar runs out.",
      "Right answers score, and faster ones score more. 50/50 removes two wrong answers for part of the points.",
      "The daily set is the same for everyone. Get 3 or more right to keep your streak going."]],
      ar: ["سباق المعلومات", ["خمسة أسئلة، ثوانٍ قليلة لكل سؤال. اختر الإجابة الصحيحة قبل أن ينتهي الشريط.",
      "الإجابة الصحيحة تكسب نقاطاً، والأسرع تكسب أكثر. ميزة 50/50 تحذف إجابتين خاطئتين مقابل جزء من النقاط.",
      "أسئلة اليوم واحدة للجميع. أجب 3 إجابات صحيحة أو أكثر لتحافظ على سلسلتك."]] },
    harf: { en: ["Harf Rush", ["You get one letter. Fill in a name, an animal, a plant, an object and a place that start with it.",
      "You have 90 seconds. Every valid answer scores straight away; tomorrow, rare answers earn a bonus.",
      "Animals, plants and objects must be words of the language you play in. Think an answer was wrongly rejected? Appeal it."]],
      ar: ["سباق الحروف", ["لك حرف واحد. اكتب إنساناً وحيواناً ونباتاً وجماداً وبلاداً تبدأ به.",
      "أمامك 90 ثانية. كل إجابة صحيحة تُحتسب فوراً، وفي اليوم التالي تكسب الإجابات النادرة مكافأة.",
      "الحيوان والنبات والجماد يجب أن تكون كلمات من لغة اللعب. ترى أن إجابتك رُفضت خطأً؟ قدّم اعتراضاً."]] },
  };
  const subPage = () => /^\/history(\/|$)/.test(basePath()); // the hub's other pages: no tour or install tip there
  async function maybeTour() {
    const g = gameKey, k = "rush-tour-" + g;
    if (subPage()) return;
    if (!TOUR[g] || store.get(k)) return;
    store.set(k, "1");
    // someone who has played before (they have a name saved on this device) doesn't need it
    if (store.get("hr-me")) return;
    const [name, steps] = TOUR[g][uiAr() ? "ar" : "en"];
    const go = await ask({ title: L2("New to " + name + "?", "أول مرة في " + name + "؟"), body: L2("Want a quick tour? Three short tips.", "تبي جولة سريعة؟ ثلاث نصائح قصيرة."), ok: L2("Show me", "أرني"), cancel: L2("No thanks", "لا، شكراً") });
    if (!go) return;
    for (let i = 0; i < steps.length; i++) {
      const last = i === steps.length - 1;
      const more = await ask({ title: (i + 1) + "/" + steps.length, body: steps[i], ok: last ? L2("Let's play", "يلا نلعب") : L2("Next", "التالي"), cancel: L2("Skip", "تخطَّ") });
      if (!more) break;
    }
  }

  // ---- after a daily: a small chip to the next one not played today ----
  const ORDER = ["hangman", "trivia", "harf"];
  const NAMES = { hangman: ["Hangman", "المشنقة"], trivia: ["Trivia", "المعلومات"], harf: ["Harf", "الحروف"] };
  let chip = null;
  async function dailyDone() {
    if (gameKey === "hub" || chip) return;
    await sleep(1600);
    let m; try { m = await mineRecs(); } catch { return; }
    const R = window.RushRules, today = R && R.todayKey();
    if (!today) return;
    const played = { hangman: [m.hm, m.hmAr], trivia: [m.tri], harf: [m.hfAr, m.hfEn] };
    const start = ORDER.indexOf(gameKey);
    const next = [1, 2].map(i => ORDER[(start + i) % 3]).find(g => !played[g].some(r => r && r.h && r.h[today]));
    if (!next || !gameShown()) return;
    chip = mkEl("div", "rnext"); chip.dir = uiAr() ? "rtl" : "ltr";
    const a = mkEl("a", "rnext-go"); a.href = arPrefix() + "/" + next + "/#daily";
    a.textContent = L2("Next daily: " + NAMES[next][0] + " →", "التحدي التالي: " + NAMES[next][1] + " ←");
    const x = mkEl("button", "rnext-x"); x.type = "button"; x.setAttribute("aria-label", L2("Close", "إغلاق")); x.append(svg(X_ICON));
    const drop = () => { if (chip) { chip.remove(); chip = null; } };
    x.onclick = drop; chip.append(a, x); document.body.append(chip);
    const g = document.getElementById("game"); if (g) new MutationObserver(() => { if (g.hidden) drop(); }).observe(g, { attributes: true, attributeFilter: ["hidden"] });
  }

  // ---- links that do something on arrival: #daily and #room=CODE ----
  const clearHash = () => { try { history.replaceState(history.state, "", location.pathname + location.search); } catch {} };
  async function waitFor(ok, ms = 15000) { for (let t = 0; t < ms; t += 150) { const v = ok(); if (v) return v; await sleep(150); } return null; }
  async function autoDaily() {
    if (location.hash !== "#daily") return;
    clearHash();
    const b = await waitFor(() => { const x = document.getElementById("dailyBtn"), l = document.getElementById("lobby"); return x && !x.disabled && x.textContent.trim() && l && !l.hidden ? x : null; });
    if (b) b.click();
  }
  const goodName = v => { v = String(v || "").trim(); return v.length >= 2 && !(window.RushRules && window.RushRules.badName(v)); };
  async function autoRoom() {
    const m = location.hash.match(/^#room=([A-Za-z]{4})$/);
    if (!m) return;
    clearHash();
    const code = m[1].toUpperCase();
    const ready2 = await waitFor(() => { const c = document.getElementById("codeIn"), j = document.getElementById("joinBtn"), l = document.getElementById("lobby"); return c && j && l && !l.hidden ? { c, j } : null; });
    if (!ready2) return;
    ready2.c.value = code;
    const nick = document.getElementById("nick");
    if (!nick || goodName(nick.value)) { ready2.j.click(); return; }
    // a name first: the profile sheet opens on the name box, and the room opens once it's closed with a name
    const hint = document.getElementById("nameHint");
    openSheet(); setTimeout(() => { try { nick.focus(); } catch {} if (hint) { hint.textContent = L2("Pick a name to join room " + code, "اختر اسماً لتدخل الغرفة " + code); hint.classList.add("warn"); } }, 300);
    await waitFor(() => !sheetOpen, 10 * 60000);
    if (goodName(nick.value)) setTimeout(() => ready2.j.click(), 120);
  }
  const roomLink = c => shareUrl() + "#room=" + String(c || "").toUpperCase();

  // ---- installable app: a tip on the hub, once the player has a name ----
  let installEvt = null;
  window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); installEvt = e; setTimeout(installTip, 300); });
  const standalone = () => { try { return matchMedia("(display-mode: standalone)").matches || navigator.standalone === true; } catch { return false; } };
  let tipShown = false;
  function installTip() {
    if (tipShown || gameKey !== "hub" || subPage() || standalone() || store.get("rush-install-x") === "1" || !store.get("hr-me")) return;
    const ua = navigator.userAgent || "", ios = /iphone|ipad|ipod/i.test(ua) && /safari/i.test(ua) && !/crios|fxios|edgios/i.test(ua);
    if (!installEvt && !ios) return;
    tipShown = true;
    const tip = mkEl("div", "rtip"); tip.dir = uiAr() ? "rtl" : "ltr"; tip.setAttribute("role", "status");
    const txt = mkEl("p");
    const signFirst = !acct && authCfg && authCfg.google;
    if (ios) txt.textContent = L2("Add Rush Games to your Home Screen: tap Share, then “Add to Home Screen”.", "أضف ألعاب رش إلى شاشتك الرئيسية: اضغط مشاركة ثم «إضافة إلى الشاشة الرئيسية».")
      + (signFirst ? " " + L2("Sign in first: Home Screen apps don't share Safari's storage, so your progress comes along only if it's saved.", "سجّل الدخول أولاً: تطبيقات الشاشة الرئيسية لا تشارك بيانات Safari، فلا ينتقل تقدّمك إلا إذا كان محفوظاً.") : "");
    else txt.textContent = L2("Install Rush Games as an app for one-tap dailies.", "ثبّت ألعاب رش كتطبيق لتلعب تحديات اليوم بلمسة.");
    const acts = mkEl("div", "rtip-acts");
    if (!ios) { const go = mkEl("button", "btn primary", L2("Install", "تثبيت")); go.type = "button"; go.onclick = async () => { try { installEvt.prompt(); await installEvt.userChoice; } catch {} tip.remove(); }; acts.append(go); }
    if (signFirst) { const s = mkEl("button", "btn", at("save")); s.type = "button"; s.onclick = () => openSheet(); acts.append(s); }
    const x = mkEl("button", "rnext-x"); x.type = "button"; x.setAttribute("aria-label", L2("Close", "إغلاق")); x.append(svg(X_ICON));
    x.onclick = () => { store.set("rush-install-x", "1"); tip.remove(); };
    tip.append(txt, acts, x); document.body.append(tip);
  }

  onBody(async () => {
    backSteps();
    footerAndReport();
    await sleep(300);
    await maybeTour();
    await autoDaily();
    await autoRoom();
    setTimeout(installTip, 2500);
  });

  /* ---------- weekly medals ----------
     Last week's top 3 on each board, and overall, wear a medal next to their name on every board until the next
     week's are decided (boards.js sends them as "aw": [{k, p}]). Gold, silver, bronze rimmed in the game's colour,
     with ع or E for the board's language; overall medals get a ring in all three games' colours, the champion a crown. */
  const MEDAL_METAL = ["#F2B544", "#C9CDD6", "#D08A5A"], MEDAL_INK = ["#6B4800", "#3E424C", "#5A2E12"];
  const MEDAL_GAME = { hangman: ["#FF6B57", "Hangman", "المشنقة"], trivia: ["#5B9BFF", "Trivia", "المعلومات"], harf: ["#3DD68C", "Harf", "الحروف"] };
  const MEDAL_KEYS = /^(overall|hangman-(en|ar)|trivia|harf-(en|ar))$/;
  function medalSvg(k, p) {
    const m = MEDAL_METAL[p - 1], ink = MEDAL_INK[p - 1];
    if (k === "overall") {
      const arc = (c, off) => `<circle cx="20" cy="20" r="16.5" fill="none" stroke="${c}" stroke-width="3.5" stroke-dasharray="34.56 103.67" stroke-dashoffset="${off}" transform="rotate(-90 20 20)"/>`;
      return arc("#FF6B57", 0) + arc("#5B9BFF", -34.56) + arc("#3DD68C", -69.12) + `<circle cx="20" cy="20" r="12.5" fill="${m}"/>`
        + (p === 1 ? `<path d="M12.5 25 L11.5 15.5 L16 19 L20 12.5 L24 19 L28.5 15.5 L27.5 25 Z" fill="${ink}"/>`
          : `<text x="20" y="25.5" text-anchor="middle" font-family="Saira,sans-serif" font-weight="800" font-size="15" fill="${ink}">${p}</text>`);
    }
    const [g, lg] = k.split("-"), c = MEDAL_GAME[g][0];
    let s = `<circle cx="18" cy="18" r="14" fill="${m}" stroke="${c}" stroke-width="3"/>`;
    if (g === "hangman") s += `<path d="M11 26H24M14 26V11H22V14" fill="none" stroke="${ink}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="22" cy="17" r="2.4" fill="none" stroke="${ink}" stroke-width="1.8"/>`;
    else s += `<text x="18" y="${lg === "ar" ? 22.5 : 23.5}" text-anchor="middle" font-family="${lg === "ar" ? "Cairo" : "Saira"},sans-serif" font-weight="800" font-size="15" fill="${ink}">${g === "trivia" ? "?" : lg === "ar" ? "ح" : "A"}</text>`;
    if (lg) s += `<circle cx="31" cy="31" r="7.5" fill="#0B0C10" stroke="${m}" stroke-width="1.5"/><text x="31" y="${lg === "ar" ? 33.6 : 34.4}" text-anchor="middle" font-family="${lg === "ar" ? "Cairo" : "Saira"},sans-serif" font-weight="800" font-size="${lg === "ar" ? 9 : 9.5}" fill="${m}">${lg === "ar" ? "ع" : "E"}</text>`;
    return s;
  }
  // what a medal is for ("1st place · Hangman Arabic"), and which week ("Week 2 · 16 Oct – 22 Oct")
  const ORD = { en: ["1st", "2nd", "3rd"], ar: ["الأول", "الثاني", "الثالث"] };
  function boardName(k, short) {
    const ar = uiAr(), [g, lg] = k.split("-");
    if (k === "overall") return ar ? "الترتيب العام" : "Overall";
    // each language's own words only, so Arabic and English never mix in one label
    if (!lg) return MEDAL_GAME[g][ar ? 2 : 1]; // Trivia: one board, no language
    const lgName = ar ? (lg === "ar" ? "عربي" : "إنجليزي") : short ? lg.toUpperCase() : lg === "ar" ? "Arabic" : "English";
    return MEDAL_GAME[g][ar ? 2 : 1] + " " + lgName;
  }
  function medalWhat(k, p) {
    const ar = uiAr();
    if (k === "overall") return ar ? ["بطل الأسبوع", "وصيف الترتيب العام", "ثالث الترتيب العام"][p - 1] : ["Champion of the week", "Runner-up overall", "Third overall"][p - 1];
    return (ar ? "المركز " + ORD.ar[p - 1] : ORD.en[p - 1] + " place") + " · " + boardName(k);
  }
  const fmtDay = k => { try { return new Date(k + "T12:00:00Z").toLocaleDateString(uiAr() ? "ar-u-ca-gregory-nu-latn" : "en-GB", { day: "numeric", month: "short", timeZone: "UTC" }); } catch { return k; } };
  function weekText(info) {
    if (!info || !info.wk) return "";
    return (uiAr() ? "الأسبوع " : "Week ") + info.wk + (info.from && info.to ? " · " + fmtDay(info.from) + " – " + fmtDay(info.to) : "");
  }
  // one medal: tap, hover or focus shows what it's for
  function medalEl(k, p, info, when) {
    const what = medalWhat(k, p), wk = when != null ? when : weekText(info), s = document.createElement("span");
    s.className = "medal"; s.tabIndex = 0; s.setAttribute("role", "img"); s.setAttribute("aria-label", what + (wk ? " · " + wk : ""));
    s.dataset.what = what; if (wk) s.dataset.when = wk;
    s.innerHTML = `<svg viewBox="0 0 40 40" aria-hidden="true">${medalSvg(k, p)}</svg>`; // fixed markup only
    return s;
  }
  // -> a span of up to three medals (then "+n"), or null. On one game's board (game set) only the overall medal and
  // that game's show, so the name keeps its room.
  function medals(aw, info, game) {
    const list = (Array.isArray(aw) ? aw : []).filter(a => a && MEDAL_KEYS.test(a.k) && [1, 2, 3].includes(a.p)
      && (!game || a.k === "overall" || a.k.split("-")[0] === game));
    if (!list.length) return null;
    const box = document.createElement("span"); box.className = "medals";
    list.slice(0, 3).forEach(a => box.append(medalEl(a.k, a.p, info)));
    if (list.length > 3) { const more = document.createElement("span"); more.className = "more"; more.textContent = "+" + (list.length - 3); box.append(more); }
    return box;
  }

  /* ---------- medal details: a small bubble on hover, focus or tap ---------- */
  let tipEl = null, tipFor = null;
  function showTip(m) {
    if (!tipEl) { tipEl = document.createElement("div"); tipEl.className = "mtip"; tipEl.id = "rush-mtip"; tipEl.setAttribute("role", "tooltip"); document.body.append(tipEl); }
    if (tipFor && tipFor !== m) tipFor.removeAttribute("aria-describedby");
    tipEl.textContent = "";
    const b = document.createElement("b"); b.textContent = m.dataset.what || ""; tipEl.append(b);
    if (m.dataset.when) { const w = document.createElement("span"); w.textContent = m.dataset.when; tipEl.append(w); }
    tipEl.dir = uiAr() ? "rtl" : "ltr"; tipEl.hidden = false; tipFor = m; m.setAttribute("aria-describedby", "rush-mtip");
    const r = m.getBoundingClientRect(), w = tipEl.offsetWidth, h = tipEl.offsetHeight;
    const x = Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2));
    let y = r.top - h - 8; if (y < 8) y = r.bottom + 8;
    tipEl.style.left = x + "px"; tipEl.style.top = y + "px";
  }
  function hideTip() { if (tipEl) tipEl.hidden = true; if (tipFor) tipFor.removeAttribute("aria-describedby"); tipFor = null; }
  const medalAt = t => (t && t.closest ? t.closest(".medal") : null);
  document.addEventListener("pointerover", e => { if (e.pointerType === "mouse" && medalAt(e.target)) showTip(medalAt(e.target)); });
  document.addEventListener("pointerout", e => { const m = medalAt(e.target); if (e.pointerType === "mouse" && m && !m.contains(e.relatedTarget)) hideTip(); });
  document.addEventListener("focusin", e => { if (medalAt(e.target)) showTip(medalAt(e.target)); });
  document.addEventListener("focusout", e => { if (medalAt(e.target)) hideTip(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && tipFor) hideTip(); });
  addEventListener("scroll", hideTip, { passive: true, capture: true });
  addEventListener("resize", hideTip);
  // a tap on a medal shows what it's for; a tap on a leaderboard row (but not the small lobby board, which opens the
  // whole board) opens that player's profile
  document.addEventListener("click", e => {
    const m = medalAt(e.target);
    if (m) { e.preventDefault(); e.stopPropagation(); showTip(m); return; } // a tap anywhere else hides it
    hideTip();
    const row = e.target.closest && e.target.closest("[data-pid]");
    if (!row || row.closest(".board.mini") || e.target.closest("a, input, select, button:not(.who)")) return;
    e.preventDefault(); openPlayer(row.dataset.pid);
  }, true);
  // the player's name on a row: a real button, so keyboards reach it (the click above does the opening)
  function whoBtn(name) { const b = document.createElement("button"); b.type = "button"; b.className = "who"; b.textContent = name; return b; }

  /* ---------- player profiles ----------
     Opened from any leaderboard: the player's name, this week's and this season's points and rank on each board they
     play, and their trophy shelf of weekly medals. A signed-in player can make theirs private (others then see only
     the name); they still show on the leaderboards. */
  const BOARD_ORDER = ["overall", "hangman-en", "hangman-ar", "trivia", "harf-ar", "harf-en"];
  function pvBuild() {
    if (pv) return;
    pvBg = mkEl("div", "rsheet-bg pv-bg"); pvBg.hidden = true; pvBg.onclick = closePlayer;
    pv = mkEl("section", "rsheet pview"); pv.hidden = true; pv.setAttribute("role", "dialog"); pv.setAttribute("aria-modal", "true"); pv.setAttribute("aria-labelledby", "pv-t");
    document.addEventListener("keydown", e => { if (e.key === "Escape" && pvOpen && !tipFor) { e.stopPropagation(); closePlayer(); } });
    // Tab stays inside the open profile
    pv.addEventListener("keydown", e => {
      if (e.key !== "Tab") return;
      const f = [...pv.querySelectorAll("button, input, [tabindex='0']")].filter(n => !n.disabled && n.offsetParent !== null);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
    document.body.append(pvBg, pv);
    new MutationObserver(() => { if (pvOpen) drawPlayer(); }).observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
  }
  function closePlayer() {
    if (!pvOpen) return;
    pvOpen = false; hideTip(); pv.classList.remove("open"); pvBg.classList.remove("open");
    setTimeout(() => { if (!pvOpen) { pv.hidden = true; pvBg.hidden = true; } }, 260);
    try { if (pvBack && pvBack.isConnected) pvBack.focus({ preventScroll: true }); } catch {}
  }
  async function openPlayer(id) {
    if (!id) return;
    pvBuild(); if (sheetOpen) closeSheet();
    pvBack = document.activeElement; pvId = id; pvData = { loading: true }; pvOpen = true; pv.hidden = false; pvBg.hidden = false;
    drawPlayer();
    requestAnimationFrame(() => requestAnimationFrame(() => { pv.classList.add("open"); pvBg.classList.add("open"); }));
    let d;
    try { d = id === uid ? await post("/api/player", { id }) : await get("/api/player?id=" + encodeURIComponent(id)); }
    catch (e) { d = { err: e.status === 404 ? "none" : "err" }; }
    if (id === uid && d && !d.err) { privOn = !!d.private; renderAcct(); }
    if (pvOpen && pvId === id) { pvData = d; drawPlayer(); }
  }
  function drawPlayer() {
    if (!pv) return;
    const d = pvData || {}, mine = pvId === uid, ar = uiAr();
    pv.textContent = ""; pv.dir = ar ? "rtl" : "ltr";
    const head = mkEl("div", "rsheet-head"), av = mkEl("span", "av"), hd = mkEl("div"), h = mkEl("h2", null, d.n || (d.loading ? pt("loading") : "")), x = mkEl("button", "rsheet-x");
    h.id = "pv-t"; av.style.background = d.c || "var(--key)"; av.textContent = d.n ? Array.from(d.n.trim())[0] || "" : "";
    if (mine) h.append(mkEl("span", "pv-you", pt("you")));
    hd.append(h); if (d.tag) hd.append(mkEl("span", "tagl", "#" + d.tag));
    x.type = "button"; x.setAttribute("aria-label", pt("close")); x.append(svg(X_ICON)); x.onclick = closePlayer;
    head.append(av, hd, x); pv.append(mkEl("span", "grab"), head);
    // keep keyboard focus inside the profile (each redraw replaces its buttons)
    const keep = () => { if (!pv.contains(document.activeElement)) setTimeout(() => { try { x.focus({ preventScroll: true }); } catch {} }, 30); };
    if (d.loading) { pv.append(mkEl("p", "note", pt("loading"))); keep(); return; }
    if (d.err) { pv.append(mkEl("p", "pv-note", pt(d.err))); keep(); return; }
    if (d.private) pv.append(mkEl("p", "pv-note", mine ? pt("privMine") : pt("privOther", { n: d.n })));
    else if (mine && d.signedIn === false) pv.append(mkEl("p", "pv-note", pt("signIn")));
    // each part is drawn on its own, so a fault in one never leaves the profile blank
    const part = f => { try { f(); } catch (e) { console.error("profile", e); } };
    if (Array.isArray(d.boards)) part(() => {
      // trophy shelf: each kind of medal once, with how many times it was won
      const shelf = mkEl("section", "pv-sec"), won = Array.isArray(d.medals) ? d.medals : [], kinds = new Map();
      shelf.append(mkEl("h3", null, pt("shelf")));
      for (const m of won) { if (!MEDAL_KEYS.test(m.k)) continue; const key = m.k + "|" + m.p; kinds.set(key, (kinds.get(key) || 0) + 1); }
      const sorted = [...kinds.entries()].map(([key, n]) => { const [k, p] = key.split("|"); return { k, p: +p, n }; })
        .sort((a, b) => (a.k === "overall" ? 0 : 1) - (b.k === "overall" ? 0 : 1) || a.p - b.p || BOARD_ORDER.indexOf(a.k) - BOARD_ORDER.indexOf(b.k));
      if (!sorted.length) shelf.append(mkEl("p", "note", pt("noMedals")));
      else {
        const g = mkEl("div", "pv-shelf");
        sorted.forEach(m => { const it = mkEl("div", "pv-m"); it.append(medalEl(m.k, m.p, null, pt("times", { n: m.n })), mkEl("b", null, pt("times", { n: m.n })), mkEl("span", null, boardName(m.k, true) + " · " + (ar ? ORD.ar : ORD.en)[m.p - 1])); g.append(it); });
        shelf.append(g);
      }
      pv.append(shelf);
    });
    if (Array.isArray(d.boards)) part(() => {
      // each board they play
      const sec = mkEl("section", "pv-sec"); sec.append(mkEl("h3", null, pt("boards")));
      if (!d.boards.length) sec.append(mkEl("p", "note", pt("none2")));
      d.boards.forEach(b => {
        const card = mkEl("div", "pv-g"), gh = mkEl("div", "pv-gh"), tile = mkEl("span", "gtile " + b.game);
        tile.setAttribute("aria-hidden", "true"); tile.append(mkEl("span", "rmark"));
        gh.append(tile, mkEl("b", null, MEDAL_GAME[b.game][ar ? 2 : 1]));
        if (b.lg) gh.append(mkEl("small", null, ar ? (b.lg === "ar" ? "عربي" : "إنجليزي") : b.lg === "ar" ? "Arabic" : "English"));
        const st = mkEl("div", "pv-st"), cell = (v, label, extra) => { const c = mkEl("div"); c.append(mkEl("b", null, String(v)), mkEl("span", null, label)); if (extra) c.append(mkEl("small", null, extra)); st.append(c); };
        cell(b.week.pts, pt("week"), b.week.rank ? "#" + b.week.rank : "");
        cell(b.season.pts, pt("season", { s: d.se }), b.season.rank ? "#" + b.season.rank : "");
        cell(b.season.days, pt("days"));
        cell(b.streak, pt("streak"), b.best ? pt("best", { b: b.best }) : "");
        card.append(gh, st);
        if (b.prev && b.prev.se) card.append(mkEl("p", "note", pt("lastSeason", { s: b.prev.se, p: b.prev.pts })));
        sec.append(card);
      });
      pv.append(sec);
    });
    // every week they won something, newest first
    const won = Array.isArray(d.medals) ? d.medals : [];
    if (Array.isArray(d.boards) && won.length) part(() => {
      {
        const hs = mkEl("section", "pv-sec"), byWk = new Map();
        hs.append(mkEl("h3", null, pt("history")));
        for (const m of won) { const k = m.from || String(m.wk); if (!byWk.has(k)) byWk.set(k, { info: { wk: m.wk, from: m.from, to: m.to }, list: [] }); byWk.get(k).list.push({ k: m.k, p: m.p }); }
        [...byWk.values()].forEach(w => {
          const row = mkEl("div", "pv-h"); row.append(mkEl("span", null, weekText(w.info)));
          w.list.sort((a, b) => BOARD_ORDER.indexOf(a.k) - BOARD_ORDER.indexOf(b.k) || a.p - b.p);
          const ms = mkEl("span", "medals"); w.list.forEach(m => ms.append(medalEl(m.k, m.p, w.info))); row.append(ms); hs.append(row);
        });
        pv.append(hs);
      }
    });
    if (mine && acct) part(() => pv.append(privToggle()));
    keep();
  }
  // the switch, in the profile sheet and on your own profile
  function privToggle() {
    const l = mkEl("label", "rush-priv"), i = document.createElement("input"), t = mkEl("span"), msg = mkEl("small", "warn");
    i.type = "checkbox"; i.checked = !!privOn; i.disabled = privOn === null;
    t.append(mkEl("b", null, pt("privT")), mkEl("small", null, pt("privS"))); l.append(i, t);
    i.onchange = async () => {
      const want = i.checked; i.disabled = true; msg.textContent = "";
      try { await post("/api/privacy", { private: want }); privOn = want; }
      catch { i.checked = !want; msg.textContent = pt("privErr"); t.append(msg); }
      i.disabled = false; renderAcct();
      if (pvOpen && pvId === uid && pvData && !pvData.err) { pvData.private = privOn; drawPlayer(); }
    };
    return l;
  }
  function loadPriv() { if (!acct || privOn !== null) return; post("/api/player", { id: uid }).then(d => { privOn = !!(d && d.private); renderAcct(); }).catch(() => {}); }

  // the message shown when a name is turned down by the shared name filter (rules.js badName)
  const badNameMsg = () => (document.documentElement.lang === "ar" ? "اختر اسماً آخر، هذا الاسم غير مسموح." : "Please pick another name. That one isn't allowed.");
  window.Rush = { medals, medalSvg, medalEl, whoBtn, openPlayer, badNameMsg, introText, dailyDone, roomLink, openReport, setReportCtx: f => { reportCtx = f; }, api: API, http, uid, token, store, room, roomCode, mePeer, hostOf, trivia, harf, ready, board, mine: mineRecs, saveProfile, moveLink, shareUrl, ask, openProfile: () => openSheet(),
    server: () => serverState, onServer(f) { serverListeners.add(f); queueMicrotask(() => f(serverState)); return () => serverListeners.delete(f); } };
  const caps = { room, user, hangman };
  window.claude = { use: name => Promise.resolve(caps[name] || null) };
})();
