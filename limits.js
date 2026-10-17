// Request limits shared by every route: the visitor's real address, simple rate limits, and a cap on how many new
// player ids one address may start a day. Everything is kept in memory; a restart clears it, which is fine for
// limits measured in minutes and hours.
const NEW_IDS_PER_DAY = Math.max(1, Number(process.env.NEW_IDS_PER_IP_DAY) || 40);

/* ---------- the visitor's address ----------
   Requests reach the server through Render's proxies. The first entry of X-Forwarded-For is whatever the visitor
   sent, so it can't be trusted. Cloudflare (in front of Render) sets CF-Connecting-IP itself, overwriting any value
   the visitor sends; without it, the last X-Forwarded-For entry is the one the nearest proxy added. */
function clientIp(req) {
  const h = req.headers || {};
  const cf = String(h["cf-connecting-ip"] || h["true-client-ip"] || "").trim();
  if (cf) return cf;
  const xff = String(h["x-forwarded-for"] || "").split(",").map(s => s.trim()).filter(Boolean);
  if (xff.length) return xff[xff.length - 1];
  return (req.socket && req.socket.remoteAddress) || "";
}

/* ---------- rate limits ----------
   A token bucket per key: `burst` requests at once, refilled at `perMin` a minute. take() -> true when allowed. */
const buckets = new Map();
function take(key, perMin, burst = perMin) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b) { b = { t: burst, at: now }; buckets.set(key, b); }
  b.t = Math.min(burst, b.t + ((now - b.at) / 60000) * perMin);
  b.at = now;
  if (b.t < 1) return false;
  b.t -= 1;
  return true;
}

/* ---------- daily counts per address ----------
   count(kind, ip, max) -> true and counts one, or false once the address has used `max` today (UTC). */
const daily = new Map();
const today = () => new Date().toISOString().slice(0, 10);
function count(kind, ip, max) {
  const k = `${today()}|${kind}|${ip}`, n = daily.get(k) || 0;
  if (n >= max) return false;
  daily.set(k, n + 1);
  return true;
}

// new player ids an address has started today: the same id counts once, however many requests it makes
const newIds = new Map(); // "day|ip" -> Set(uid)
function allowNewId(ip, uid) {
  if (!ip) return true;
  const k = today() + "|" + ip;
  let s = newIds.get(k);
  if (!s) { s = new Set(); newIds.set(k, s); }
  if (s.has(uid)) return true;
  if (s.size >= NEW_IDS_PER_DAY) return false;
  s.add(uid);
  return true;
}

// forget old entries now and then
setInterval(() => {
  const now = Date.now(), d = today();
  for (const [k, b] of buckets) if (now - b.at > 10 * 60000) buckets.delete(k);
  for (const k of daily.keys()) if (!k.startsWith(d)) daily.delete(k);
  for (const k of newIds.keys()) if (!k.startsWith(d)) newIds.delete(k);
}, 5 * 60000).unref();

module.exports = { clientIp, take, count, allowNewId, NEW_IDS_PER_DAY };
