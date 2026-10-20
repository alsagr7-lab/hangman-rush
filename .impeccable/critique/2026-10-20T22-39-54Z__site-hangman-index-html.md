---
target: hangman
total_score: 25
max_score: 40
na_heuristics: 
p0_count: 1
p1_count: 3
target_identity: "file:/home/claude/hangman-rush/site/hangman/index.html"
target_fingerprint: "sha256:4df1dd43381f33431b9e895387994c42b5693e98b5e2714538f0338c69829bb2"
target_path: /home/claude/hangman-rush/site/hangman/index.html
timestamp: 2026-10-20T22-39-54Z
slug: site-hangman-index-html
---
Method: dual-agent (A: design review · B: detector + browser)

## Hangman, 25/40 Acceptable (was 27)
| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Status | 3 | Game bar truncates "Round 1 · No…" |
| 2 | Real world | 3 | "No votes yet" shown in solo |
| 3 | Control | 2 | Setup Start clipped inside the panel's inner scroll |
| 4 | Consistency | 2 | Daily error styled as the hero card |
| 5 | Error prevention | 2 | Room code box opens Arabic keyboard, strips letters silently |
| 6 | Recognition | 3 | Fine |
| 7 | Flexibility | 3 | Fine |
| 8 | Minimalist | 2 | Setup panel 16 controls; lobby card stack |
| 9 | Error recovery | 2 | Error not styled as error |
| 10 | Help | 3 | Inline How to play |

## Priority issues
1. [P0] Words of ~10 letters wrap the last slot onto a second line on phones. /impeccable adapt
2. [P1] Sticky keyboard covers "Show a clue" on English phones (regression from the pinned keyboard). /impeccable layout
3. [P1] Setup/settings panel scrolls inside the card; Start clipped (regression: play card lost its min-height). /impeccable layout + distill
4. [P1] Room code input: Arabic keyboard, placeholder "الرمز", silent stripping. /impeccable harden
5. [P2] Two stacked headers (~125px) clip labels during play. /impeccable distill

## Detector
CLI clean. In-page: straggler only (font fallback), cream-palette light. Contrast: light .key.hit 4.43:1. Timer and keyboard both inside the viewport at scroll 0 in EN and AR.
