---
target: hub
total_score: 26
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
target_identity: "file:/home/claude/hangman-rush/site/index.html"
target_fingerprint: "sha256:d25e1d50930a73196dbd3c5d484d016231a1458d1876d2adfd5423c486380b8a"
target_path: /home/claude/hangman-rush/site/index.html
timestamp: 2026-10-20T21-40-51Z
slug: site-index-html
---
Method: dual-agent (A: design review · B: detector + browser)

## Design Health Score: hub (/ and /ar/), 26/40 Acceptable
| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of status | 3 | Countdown and per-game status good; Trivia "no questions today" still shows a bright Play; board has no loading state |
| 2 | Match real world | 3 | "Next dailies in" jargon; Arabic "#7" renders as "7#" |
| 3 | User control | 3 | Nothing traps; language/theme always present |
| 4 | Consistency | 2 | Play and Play daily go to the same place; language order differs between Hangman and Harf statuses |
| 5 | Error prevention | 3 | Active Play on days without content |
| 6 | Recognition | 2 | Profile hides behind a blue "?" that reads as help; desktop shows "— #7989" |
| 7 | Flexibility | 3 | Direct #daily links; no "next unplayed" first |
| 8 | Minimalist | 2 | Each game shown twice (Your day + cards) then again in boards; hero eats the phone's first screen |
| 9 | Error recovery | 3 | Good script-failure banner; failed board silently disappears |
| 10 | Help | 2 | "Overall" explainer is a ~100-word stats paragraph |

## Priority issues
1. [P1] Game list shown twice (Your day rows + 3 game cards = 6 Play buttons), pushes boards to ~1300px. Fix: merge into one card per game; explainer cards only before first daily. /impeccable distill
2. [P1] Phone first screen is the hero, Your day starts ~410/664px. Fix: compact hero for returning players, Your day first. /impeccable layout
3. [P2] Light theme gold text 1.65:1 (season line, rules labels; detector agrees). Fix: use --gold-hi for text in light. /impeccable colorize
4. [P2] Profile behind "?" button; "— #7989" on desktop. Fix: avatar initial/person icon, "Set name" when empty. /impeccable onboard
5. [P2] Arabic number/order: "7#", English-first language order on /ar/. Fix: bdi/LTR isolate, order by page language. /impeccable harden

## Detector
CLI: 15 findings (low-contrast x5 incl. aria-hidden Harf band chips 3.6:1 and placeholder 4.1:1; cramped-padding x10 on decorative bands = false positives). Browser light theme: gold on cream 1.7:1 x4, cream-palette (intentional token), repeated-container-text (empty local boards). Tap targets: .ldq "?" 22x22, language and board toggles 32px tall, footer links 32px tall.

## Personas
Casey: 22px help buttons, 32px toggles, Play hidden under 380px. Jordan: "?" looks like help, unexplained jargon. Sam: gold contrast, colour-coded status. Noura (Arabic-first): "7#", English-first status, unclear separate AR/EN boards.
