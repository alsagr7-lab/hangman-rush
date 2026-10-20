# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Mostly Arabic speakers in Saudi Arabia and the Gulf, playing on their phones, with English as the second language. They come back daily for a few minutes to play the day's challenge and see where they rank, and get together with friends or family in live rooms.

## Product Purpose

Rush Games (Arabic name: ألعاب رش) is three free browser games sharing one profile: Hangman Rush, Trivia Rush and Harf Rush (حيوان جماد إنسان). Each has a daily challenge in Arabic and in English with its own streak and leaderboard, live rooms with 4-letter codes, and solo practice. Success is players returning every day, climbing the boards, and pulling friends into rooms.

## Positioning

- Arabic is first-class: real Arabic daily words, letters, questions and an Arabic keyboard, not a translation of an English game.
- A race against everyone: the same puzzle at the same moment, and speed counts in the score.
- Three games, one profile: one name, colour and player tag across all games, with streaks and boards in each.
- Rooms with friends: live rooms with codes, Blue vs Red teams, difficulty levels and category votes.

## Operating Context

- Played mostly on phones, often in short sessions; installable as a web app.
- Daily numbering started 13–14 Oct 2026; days change at midnight UTC; 30-day seasons reset all boards together.
- Leaderboards load when opened (no live updating); "refresh the page" is how a friend shows they passed you.
- Harf answers are checked by word lists, then saved verdicts, then Claude; players can appeal.

## Capabilities and Constraints

- Plain HTML/CSS/JS pages in `site/`, with shared `site/shared/rush.css`, `rush.js` and `rules.js` inlined into each page by `scripts/build-site.js`. No framework.
- Every page exists in English and Arabic (`/ar/...`); Arabic pages run right-to-left.
- Static site on Render (rushgames.cc); game server and Postgres on Render (api.rushgames.cc).
- Optional Google sign-in keeps progress across devices.
- Rush+ subscription links exist but are hidden. Monetisation is undecided: currently leaning to a small, guilt-free "Buy me a coffee" (Ko-fi) footer link rather than subscriptions or prompts after games.
- Never reveal today's daily word, letter or questions anywhere in the UI or code.

## Brand Commitments

- Names: Rush Games / ألعاب رش; Hangman Rush, Trivia Rush, Harf Rush (سباق المشنقة، سباق المعلومات، سباق الحروف).
- Own Arabic logo (ألعاب رش wordmark beside an island-and-palm mark) for Arabic pages; English wordmark and mark in `site/shared/`.
- Voice: quick and competitive. Fast, a bit of pressure, leaderboard energy.
- Support links stay quiet and guilt-free: no "Support" wording, no conditions like "like the game?", no popups after a game.

## Evidence on Hand

- Live product with real daily leaderboards and seasons; no testimonials, press or player counts to quote. Don't invent any.

## Product Principles

1. Arabic first: every change works and reads naturally in Arabic and right-to-left before it ships.
2. Speed is the game: nothing should slow a player between opening the page and playing today's challenge.
3. Fair races: everyone gets the same challenge at the same moment, and the UI never leaks answers.
4. Social pull: boards, streaks and rooms give players a reason to bring friends.
5. Free without guilt: money asks stay small, optional and out of the way.

## Accessibility & Inclusion

- Respect reduced motion (movement removed, short fades kept).
- Touch-first: large tap targets and on-screen keyboards for both languages.
- An accessibility pass is planned before promoting the site.
