---
target: hangman
total_score: 27
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
target_identity: "file:/home/claude/hangman-rush/site/hangman/index.html"
target_fingerprint: "sha256:51e321064d944bd786d2aff35e1064de70c1675ee038e8669ed6070af171a738"
target_path: /home/claude/hangman-rush/site/hangman/index.html
timestamp: 2026-10-20T21-40-51Z
slug: site-hangman-index-html
---
Method: dual-agent (A: design review · B: detector + browser)

## Design Health Score: Hangman (/hangman/ and /ar/hangman/), 27/40 Acceptable
| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of status | 2 | On phone, timer, gallows and keyboard never on screen together |
| 2 | Match real world | 3 | Clue cost "25-90% depending on how you've been playing" opaque; Arabic status mixes "English:" |
| 3 | User control | 3 | Leave/back/skip present; first-visit tour is a blocking modal |
| 4 | Consistency | 2 | Daily bilingual but practice/rooms English-only; hint shows -50% vs rules 25-90% |
| 5 | Error prevention | 3 | Used keys disable, code field limited, name required online |
| 6 | Recognition | 3 | Used letters, vowels, category visible |
| 7 | Flexibility | 3 | Physical keyboard, phone keyboard, difficulty, room links |
| 8 | Minimalist | 2 | Friends card 5 equal controls; end panel 14 options |
| 9 | Error recovery | 3 | Plain messages; daily-load error has no Retry |
| 10 | Help | 3 | Optional Gulf-dialect tour + rules |

## Priority issues
1. [P1] Keyboard below the fold on phones (keys at 656-871px of 664). Fix: 100dvh game column, keyboard pinned bottom, smaller gallows, timer in bar, Leave as icon. /impeccable adapt
2. [P1] Practice and rooms English-only on Arabic pages (MUFFIN + QWERTY on /ar/hangman/). Fix: Arabic room/practice word lists + Arabic keyboard, default to page language. /impeccable harden + content
3. [P1] End-of-round panel is a setup form; score not shown, covers the drawing. Fix: lead with +points/time/rank, Next round below, settings collapsed. /impeccable delight + distill
4. [P2] First-visit tour is a blocking modal. Fix: inline tip or teach in first practice. /impeccable onboard
5. [P2] Play-with-friends card has no primary action (Create, code+Join, 1v1, Practise solo equal). Fix: Create primary, join row, practice separate. /impeccable distill

## Detector
CLI: 2 placeholder low-contrast (CODE / e.g. Yousef, 4.1:1 dark, 3.4:1 light). Browser light: coral "Rush" in top bar 2.53:1 on cream. Tap targets: back 40x40, language 32px tall, report tab 34x44 fixed beside keyboard edge.

## Personas
Casey: keys out of reach, report tab next to P/Q. Jordan: modal first, 340-pt formula, practice inside "friends". Sam: gallows label has no state, misses not announced. Noura: English practice/rooms, "English: لم تلعب", "7#".
