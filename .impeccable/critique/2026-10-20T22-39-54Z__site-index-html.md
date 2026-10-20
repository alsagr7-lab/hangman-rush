---
target: hub
total_score: 25
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
target_identity: "file:/home/claude/hangman-rush/site/index.html"
target_fingerprint: "sha256:0baf639fbfcb8e3b543a83a4be80b5393b2faf2f887f778e7ffe41fa597aa1cf"
target_path: /home/claude/hangman-rush/site/index.html
timestamp: 2026-10-20T22-39-54Z
slug: site-index-html
---
Method: dual-agent (A: design review · B: detector + browser)

## Hub, 25/40 Acceptable (was 26)
| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Status | 3 | Empty boards give no loading/empty/failed distinction |
| 2 | Real world | 3 | Arabic plurals: "باقي 24 أيام", "0 لاعب" |
| 3 | Control | 3 | Fine |
| 4 | Consistency | 2 | Same R tile for all games; Play vs Play daily; off Trivia row still a link |
| 5 | Error prevention | 3 | Fine |
| 6 | Recognition | 2 | Games distinguished by colour only |
| 7 | Flexibility | 3 | Returning players skip explainers |
| 8 | Minimalist | 2 | First-time phone fold is all hero; first Play ~520px down |
| 9 | Error recovery | 2 | Failed leaderboard fetch swallowed silently |
| 10 | Help | 2 | Overall scoring still formula-heavy |

## Priority issues
1. [P1] First-time phone hero pushes games below fold; countdown box before Your day for returners. /impeccable layout
2. [P1] Game tiles identical except colour. /impeccable colorize + delight
3. [P2] Empty leaderboard dominates (4x "No results yet"). /impeccable harden
4. [P2] Arabic number/noun agreement (أيام/يوماً, لاعب/لاعبين). /impeccable clarify
5. [P3] Unavailable Trivia row still looks tappable. /impeccable polish

## Detector
CLI: cramped-padding x10 (decorative bands, false positive), repeated-container-text x1. In-page: straggler (font fallback), empty-board repetition, cream-palette (intentional). No contrast failures. Hub tap targets: .ldq 30x30 (hit area 44), lang toggles 38 tall, theme 40x40.
