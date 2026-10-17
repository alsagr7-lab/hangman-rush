# Rush Games

Three daily multiplayer games you play on your phone, in English or Arabic, sharing one profile:

- **Hangman Rush** (`/hangman/`): everyone gets the same word at the same moment; fastest solve with the fewest misses wins. There's an English daily word and a different Arabic one (Arabic keyboard), each with its own streak and leaderboard; play one or both.
- **Trivia Rush** (`/trivia/`): five multiple-choice questions, fifteen seconds each; fast and right wins.
- **Harf Rush** (`/harf/`), حيوان جماد إنسان: one letter, then a name, an animal, a plant, an object and a place that start with it.

The home page (`/`) links all three, with today's status for each.

## What the games share

- **Profile:** name, colour, a permanent 4-character player tag and language, stored once in the browser.
- **Daily numbering and 30-day seasons:** daily #1 was 14 Oct 2026; both leaderboards reset together. Each game keeps its own record and streak.
- **Scoring scale:** every word or question is worth 100 for getting it, plus up to 240 for speed.
- **Levels:** +1 for each correct result and −1 for each miss, in rooms and the daily (not solo practice). The paid hint costs 50% of the item's points, +5 per level (25–90%). Players two or more levels below the start get extra help.
- **Rooms:** 4-letter codes, free-for-all or Blue vs Red teams (team score is the members' average), Easy/Normal/Hard, and category votes where each player's vote is split across their picks and the category is drawn by vote share.

## Trivia Rush

- **Daily:** five questions for everyone, one attempt, 15 seconds each. The server sends one question at a time and scores each answer by its own clock, so looking answers up or reading them from the network doesn't help. Get 3 or more right to keep your streak. Leaderboard: Today, Yesterday, Season.
- **50/50:** removes two wrong answers for a share of the question's points, set by your level. Low-level players get their first 50/50 of the day free.
- **Past dailies:** replay any earlier day. Replays don't count on the leaderboard.
- **Rooms:** each round offers 5 of the 12 categories to vote on, then plays 5 questions from the winner. Easy uses easier questions with 20 seconds; Hard uses harder ones with 10 seconds and no 50/50.
- **No repeats:** when a round starts, the server picks questions that nobody in the room has seen in the last 60 days, in any room or in practice, and marks them as seen for everyone there. If a category runs low, it tops up with the ones the group saw longest ago.
- **Separate pools:** daily questions never appear in rooms or practice.

## Harf Rush

- **Daily:** an Arabic letter and an English letter each day, the same for everyone; play one or both, one attempt each, 90 seconds timed by the server. Each language has its own record (`<id>_ar`, `<id>_en`), streak, perfect streak and leaderboard. Drafts are saved as you type, so closing the page scores what you'd written.
- **Points, straight away:** 10 for each valid answer. A day with all five valid adds a **perfect-streak bonus**: +1 per day in a row, up to +5. A missed or imperfect day resets it.
- **Points, the next day:** after midnight (UTC) the server counts how many players gave each valid answer, per language: **+5** if nobody else wrote it, **+2** if under 20% of players did. Needs at least two players that day. Players see it on the lobby and the Yesterday board. Arabic and English each have their own leaderboard (a switch on the board).
- **Matching:** a leading "ال" or "the" doesn't count for the letter; أ/إ/آ/ا, ة/ه, ى/ي and diacritics count as the same, so "الأسد" and "اسد" are the same answer.
- **Rooms:** the host picks Arabic or English letters and 60/90/120 seconds. Anyone who fills all five can press **STOP**; everyone else then has 5 seconds. Scoring: 10 for a valid answer nobody else in the round wrote, 5 if someone did.
- **Practise solo:** any letter, 10 per valid answer.
- Letters left out as too hard: ث ذ ض ظ غ and Q U X Z.

### Checking answers

Answers are checked cheapest first:

1. **First letter**, by the server.
2. **Built-in word lists** in `content/harf/ar.json` and `en.json`: about 1,450 Arabic and 960 English names, animals, plants, objects and places. No AI needed. Add words to the right category and run `node scripts/check-harf.js`, which reports repeats and letters with few words.
3. **Saved verdicts** from earlier checks.
4. **The Claude API**, only for words not found above, when `ANTHROPIC_API_KEY` is set:

- Every verdict is saved (`harf_words`), so each word is asked about once, ever. A day with five players is usually one small request.
- At most `HARF_API_PER_HOUR` calls an hour (default 60). Set a monthly spend limit in the Claude Console too.
- Without a key, or if the API is down, answers with the right first letter count and show "not checked"; the overnight pass asks again.
- **Misspellings:** a misspelt answer counts when it's clear what was meant ("catapilar" → caterpillar). The player sees "Counted as “Caterpillar”", and the corrected spelling is what's compared for rare and shared answers. The correction is saved with the verdict.
- **Appeals:** a player can appeal an answer turned down for its category (not one with the wrong first letter). A stronger model (`HARF_APPEAL_MODEL`, default `claude-sonnet-5-5`) takes a second look, allowing rare, classical, regional and dialect words. A win counts at once (in the daily it can complete a perfect day and its streak bonus) and the word is accepted for everyone from then on. Up to `HARF_APPEALS_PER_DAY` per player (default 5); daily appeals close at midnight UTC.
- Optional: `HARF_MODEL` (default `claude-haiku-5-5`). The daily letter order is shuffled with `HARF_KEY` (falls back to `DAILY_KEY`), so the public code can't reveal tomorrow's letter.

## Run locally

```bash
npm install
npm start
# open http://localhost:3000
```

Without `DAILY_KEY` and `TRIVIA_KEY` the two dailies show as unavailable; everything else works.

## Deploy on Render (free)

`render.yaml` sets up three things:

| Service | What it is |
|---|---|
| `hangman-rush` (free web service) | The game server: rooms, dailies, leaderboards. Sleeps after 15 idle minutes. |
| `rush-games` (free static site) | The pages. Never sleeps and uses no free instance hours. Shows "waking up the game server" while the server starts. |
| `hangman-rush-db` (free Postgres) | Leaderboards and seen-question history. Render deletes it after 30 days. |

1. On render.com: **Blueprints → your blueprint → Manual sync** (or **New → Blueprint** the first time).
2. Set these environment variables:
   - On `hangman-rush`: `DAILY_KEY` (Hangman words), `DAILY_AR_KEY` (Arabic Hangman words), `TRIVIA_KEY` (trivia questions), `SITE_URL` = the static site's address (e.g. `https://rush-games.onrender.com`).
     Optional: `ANTHROPIC_API_KEY` so Harf Rush checks categories (see above).
   - On `rush-games`: `API_URL` = the game server's address (e.g. `https://hangman-rush.onrender.com`), then redeploy it.
     Its build command is `node scripts/build-site.js` and its publish directory is `dist`.
   - Optional on `hangman-rush`: `TRIVIA_START` (`YYYY-MM-DD`, the first day of trivia set 1; set it to your launch day), `TRIVIA_COOLDOWN_DAYS` (default 60).
3. Share the static site's address. The old server address keeps working too; its home page offers players a one-tap move to the static site that keeps their identity and leaderboard place.

Only one free web service runs, so the free plan's 750 shared instance hours a month are enough to keep it up all month.

### Seasons and the database

When Render says the free database has expired: delete `hangman-rush-db`, then **Manual sync** the blueprint for a fresh one. Leaderboards reset with the season anyway, but **the seen-question history also resets**, so the 60-day "no repeats" window can only stretch as far back as the database. For permanent storage, point `DATABASE_URL` at a free Neon or Supabase database instead.

If the database is missing or unreachable, the server keeps running on a local file that resets on restart.

## Questions

### Rooms and practice

One file per category in `content/trivia/` (geography, history, science, space, animals, sports, football, food, saudi, tech, gaming, cars). Each question:

```json
["geo-01", 1, "Question in English?", "السؤال بالعربية؟", ["Right answer", "Wrong", "Wrong", "Wrong"], ["الإجابة الصحيحة", "خطأ", "خطأ", "خطأ"]]
```

The right answer goes first (players see them shuffled). Difficulty 1–3: Easy rooms use 1–2, Hard rooms use 2–3, Normal uses all. After editing, check and rebuild:

```bash
node scripts/build-trivia.js
```

It checks ids, answer counts, repeats and pool sizes, then writes `site/trivia/questions.json`. Commit both.

### Daily questions

They live only in `trivia-daily.enc`, encrypted with `TRIVIA_KEY`, so neither the pages nor this repo reveal upcoming questions. The current file holds **30 days** (five questions a day, mixed categories). Trivia day N uses set N counted from `TRIVIA_START`; when the sets run out, the daily shows as unavailable until more are added.

```bash
TRIVIA_KEY=... node scripts/trivia-daily.js decrypt > trivia-daily.json      # keep this file out of git
# edit: {"start": "YYYY-MM-DD", "days": [[five questions], ...]}, each like a room question but with the category first:
#   ["geography", 1, "Question?", "السؤال؟", [4 answers, right first], [4 Arabic answers]]
node scripts/build-trivia.js --daily trivia-daily.json                      # checks it shares nothing with the room pool
TRIVIA_KEY=... node scripts/trivia-daily.js encrypt trivia-daily.json
```

### Hangman daily words

There are two lists: English words in `daily-words.enc` (`DAILY_KEY`) and Arabic words in `daily-words-ar.enc` (`DAILY_AR_KEY`, 167 words, repeating after that). Arabic words use Arabic letters only; on the keyboard أ/إ/آ count as ا, ة as ه, ى/ئ as ي and ؤ as و. Hangman's level (and so the hint cost) is shared by both words.

```bash
DAILY_AR_KEY=... node scripts/daily-words.js decrypt --ar > words-ar.json   # [category, word, English clue, Arabic clue, English meaning]
DAILY_AR_KEY=... node scripts/daily-words.js encrypt words-ar.json --ar
```


The 160 daily words live only in `daily-words.enc`, unlocked with `DAILY_KEY`. To change or extend them (they repeat after 160 days, around 22 March 2027):

```bash
DAILY_KEY=... node scripts/daily-words.js decrypt > words.json   # edit, keeping words.json out of git
DAILY_KEY=... node scripts/daily-words.js encrypt words.json
```

## How it fits together

Pages are delivered as single files: `scripts/build-site.js` writes the shared stylesheet and scripts into each page
(the static site builds `dist/`; the game server does the same in memory at start-up). Some phones and networks were
dropping the separate files, which left pages unstyled or offline.

- `site/`: the pages, served by the static site and by the game server.
  - `index.html` home, `hangman/index.html`, `trivia/index.html`, `trivia/questions.json` (built), `harf/index.html`.
  - `shared/rules.js`: days, seasons, streaks, levels, scoring and tags, used by both games and the server.
  - `shared/rush.js`: player identity, rooms (WebSocket), leaderboards, the trivia API and the wake-up notice.
  - `shared/rush.css`: the shared look. `shared/config.js`: where the game server is (rewritten by the static site's build).
- `server.js`: serves `site/`, rooms at `/ws`, the Hangman daily word and leaderboard, and CORS so the static site can call it.
- `trivia.js`: the Trivia daily, past dailies, leaderboard, question picks and levels (`/api/trivia/...`).
- `harf.js`: the Harf daily, answer checks, the overnight rarity pass and its leaderboard (`/api/harf/...`).
- `store.js`: Postgres when `DATABASE_URL` is set, otherwise a JSON file.

Each device gets a random player id and a secret token in browser storage. Only that device can update its own records.
