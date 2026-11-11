// The picture card under the Discord channel messages (discord.js): one tile per player with their avatar and a small
// grid of how their dailies went, in the site's own fonts and colours. Like the Wordle app's card, it shows the shape
// of a result and never an answer:
//   Hangman (one row per language)  six squares, one per allowed miss: misses first, the rest in coral when solved
//   Trivia                          five squares, one per question, in order: blue for right
//   Harf (one row per language)     five squares, one per category: green for each answer that counted
// A daily the player hasn't played is a row of empty squares.
//
// Drawing needs the optional package @napi-rs/canvas. Without it render() gives null and the messages go out as text.
const path = require("path");

const W = { bg: "#0B0C10", tile: "#14161D", line: "#23262F", ink: "#F4F1EA", muted: "#9EA3B0", empty: "#262A35", miss: "#7A3B40", gold: "#F2B544",
  hangman: "#FF6B57", trivia: "#5B9BFF", harf: "#3DD68C" };
// the rows of a player's grid, top to bottom: [board key, game, cells, row label]
const ROWS = [["hangman-en", "hangman", 6, "E"], ["hangman-ar", "hangman", 6, "ع"], ["trivia", "trivia", 5, ""], ["harf-ar", "harf", 5, "ع"], ["harf-en", "harf", 5, "E"]];
const MAX_PLAYERS = 12;

let lib; // undefined: not tried yet; null: not installed
function canvas() {
  if (lib !== undefined) return lib;
  try {
    lib = require("@napi-rs/canvas");
    const dir = path.join(__dirname, "site", "fonts");
    for (const [file, family] of [["saira-latin-standard-normal.woff2", "Saira"], ["figtree-latin-wght-normal.woff2", "Figtree"], ["cairo-arabic-wght-normal.woff2", "Cairo"]])
      lib.GlobalFonts.registerFromPath(path.join(dir, file), family);
  } catch (e) { lib = null; console.log("Discord picture cards are off (@napi-rs/canvas isn't installed)"); }
  return lib;
}
const available = () => !!canvas();

// one row's squares as colours, from what the leaderboard keeps for that daily (boards.js dayDetail)
function cells(game, n, d) {
  const out = new Array(n).fill(W.empty);
  if (!d) return out;
  if (game === "hangman") { const m = Math.max(0, Math.min(n, d.m | 0)); return out.map((_, i) => (!d.ok ? W.miss : i < m ? W.miss : W.hangman)); }
  if (game === "trivia") { const s = String(d.s || ""); return out.map((_, i) => (s[i] === "1" ? W.trivia : s[i] === "0" ? W.miss : W.empty)); }
  const c = Math.max(0, Math.min(n, d.c | 0)); return out.map((_, i) => (i < c ? W.harf : W.empty));
}

function rrect(x, a, b, w, h, r) { x.beginPath(); x.roundRect(a, b, w, h, r); }
// text that fits a width: cut with an ellipsis
function fit(x, s, max) { s = String(s || ""); if (x.measureText(s).width <= max) return s; while (s.length > 1 && x.measureText(s + "…").width > max) s = s.slice(0, -1); return s + "…"; }

// players: [{name, color, pts, avatar: Buffer | null, g: {"hangman-en": d, ...}}], best first. -> PNG Buffer, or null
async function render({ title, players }) {
  const C = canvas(); if (!C || !players || !players.length) return null;
  try {
    const list = players.slice(0, MAX_PLAYERS), more = players.length - list.length;
    const S = 2, cols = Math.min(3, list.length), rows = Math.ceil(list.length / cols);
    const TW = 232, TH = 172, GAP = 12, PAD = 20, HEAD = 46, FOOT = 34;
    const width = PAD * 2 + cols * TW + (cols - 1) * GAP, height = PAD + HEAD + rows * TH + (rows - 1) * GAP + FOOT + PAD - 8;
    const cv = C.createCanvas(width * S, height * S), x = cv.getContext("2d"); x.scale(S, S);
    x.fillStyle = W.bg; rrect(x, 0, 0, width, height, 18); x.fill();
    x.textBaseline = "middle"; x.textAlign = "center";
    x.fillStyle = W.ink; x.font = "800 21px Saira, Cairo"; x.fillText(fit(x, title, width - PAD * 2), width / 2, PAD + 14);
    for (let i = 0; i < list.length; i++) {
      const p = list[i], r = Math.floor(i / cols), inRow = r === rows - 1 ? list.length - r * cols : cols;
      // a last row that isn't full sits in the middle, as on the Wordle card
      const x0 = (width - (inRow * TW + (inRow - 1) * GAP)) / 2 + (i - r * cols) * (TW + GAP), y0 = PAD + HEAD + r * (TH + GAP);
      x.fillStyle = W.tile; rrect(x, x0, y0, TW, TH, 18); x.fill(); x.strokeStyle = W.line; x.lineWidth = 1.5; x.stroke();
      // the avatar (or the player's colour and initial)
      const ax = x0 + 16, ay = y0 + 18, AS = 64;
      x.save(); x.beginPath(); x.arc(ax + AS / 2, ay + AS / 2, AS / 2, 0, Math.PI * 2); x.clip();
      let drawn = false;
      if (p.avatar) try { x.drawImage(await C.loadImage(p.avatar), ax, ay, AS, AS); drawn = true; } catch (e) {}
      if (!drawn) { x.fillStyle = /^#[0-9a-f]{6}$/i.test(p.color || "") ? p.color : W.gold; x.fillRect(ax, ay, AS, AS); x.fillStyle = "#fff"; x.font = "800 30px Saira, Cairo"; x.fillText([...String(p.name || "?")][0].toUpperCase(), ax + AS / 2, ay + AS / 2 + 1); }
      x.restore();
      // the day's best wears a gold ring
      if (i === 0 && p.pts > 0) { x.strokeStyle = W.gold; x.lineWidth = 3; x.beginPath(); x.arc(ax + AS / 2, ay + AS / 2, AS / 2 + 4, 0, Math.PI * 2); x.stroke(); }
      // the grid
      const CS = 17, CG = 4, gx = x0 + 110, gy = y0 + 16, GW = 5 * CS + 4 * CG;
      ROWS.forEach(([key, game, n, label], k) => {
        const cy = gy + k * (CS + CG), cw = (GW - (n - 1) * CG) / n;
        if (label) { x.fillStyle = W.muted; x.font = "700 11px Saira, Cairo"; x.fillText(label, gx - 11, cy + CS / 2 + 1); }
        cells(game, n, p.g && p.g[key]).forEach((c, j) => { x.fillStyle = c; rrect(x, gx + j * (cw + CG), cy, cw, CS, 4); x.fill(); });
      });
      // name and points
      x.textAlign = "start"; x.fillStyle = W.ink; x.font = "700 16px Figtree, Cairo";
      const pts = String(p.pts | 0); x.font = "800 17px Saira"; const pw = x.measureText(pts).width;
      x.font = "700 16px Figtree, Cairo"; x.fillText(fit(x, p.name, TW - 32 - pw - 10), x0 + 16, y0 + TH - 26);
      x.textAlign = "end"; x.fillStyle = W.gold; x.font = "800 17px Saira"; x.fillText(pts, x0 + TW - 16, y0 + TH - 26);
      x.textAlign = "center";
    }
    // what the colours mean
    const fy = height - PAD - 4, items = [[W.hangman, "Hangman"], [W.trivia, "Trivia"], [W.harf, "Harf"]].concat(more > 0 ? [[null, "+" + more + " more"]] : []);
    x.font = "600 12px Figtree"; x.textAlign = "start";
    const widths = items.map(([c, t]) => (c ? 18 : 0) + x.measureText(t).width), total = widths.reduce((a, b) => a + b, 0) + (items.length - 1) * 18;
    let fx = (width - total) / 2;
    items.forEach(([c, t], k) => { if (c) { x.fillStyle = c; rrect(x, fx, fy - 6, 12, 12, 3); x.fill(); } x.fillStyle = W.muted; x.fillText(t, fx + (c ? 18 : 0), fy + 1); fx += widths[k] + 18; });
    return cv.toBuffer("image/png");
  } catch (e) { console.log("Discord card", e.message); return null; }
}

module.exports = { render, available, cells, ROWS, MAX_PLAYERS };
