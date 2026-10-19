# Draws site/og-ar.png, the Arabic link preview (1200x630), in the same layout as og.png:
# the three game colours on top, the Arabic wordmark (ألعاب رش), and the island-and-palm mark on a tile per game.
#   pip install cairosvg && python3 scripts/make-og-ar.py
import os, re
import cairosvg

ROOT = os.path.join(os.path.dirname(__file__), "..", "site")

def shape(name):
    t = open(os.path.join(ROOT, "shared", name)).read()
    w, h = (float(v) for v in re.search(r'viewBox="0 0 ([\d.]+) ([\d.]+)"', t).groups())
    return w, h, re.search(r' d="([^"]+)"', t).group(1)

INK, BG = "#F4F1EA", "#0B0C10"
GAMES = ["#FF6B57", "#5B9BFF", "#3DD68C"]  # hangman, trivia, harf

def place(sh, cx, cy, width, fill):
    w, h, d = sh
    s = width / w
    return f'<g transform="translate({cx - w * s / 2:.1f},{cy - h * s / 2:.1f}) scale({s:.5f})"><path fill="{fill}" fill-rule="evenodd" d="{d}"/></g>'

word, mark = shape("logo-wordmark-ar.svg"), shape("logo-mark-ar.svg")
parts = [f'<rect width="1200" height="630" fill="{BG}"/>']
for i, c in enumerate(GAMES):  # the three slanted dashes
    x = 536 + i * 44
    parts.append(f'<path d="M{x + 6} 100h34l-6 10h-34z" fill="{c}"/>')
parts.append(place(word, 600, 232, 640, INK))
for i, c in enumerate(GAMES):
    cx = 462 + i * 138
    parts.append(f'<rect x="{cx - 55}" y="401" width="110" height="110" rx="26" fill="{c}"/>')
    parts.append(place(mark, cx, 456, 66, BG))
svg = f'<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">{"".join(parts)}</svg>'
cairosvg.svg2png(bytestring=svg.encode(), write_to=os.path.join(ROOT, "og-ar.png"))
print("wrote site/og-ar.png")
