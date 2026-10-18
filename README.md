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
- At most `HARF_API_PER_HOUR` calls an hour (default 60), of which rooms and practice may use half, so the dailies always have room. Set a monthly spend limit in the Claude Console too.
- **Rooms and practice:** each network (IP address) gets `HARF_ROOM_AI_PER_IP_DAY` AI calls a day (default 40); past that, or when the hourly share is used, rooms check the first letter and the word lists only.
- **Unchecked answers:** in the daily, an answer that couldn't be checked (no key, API down, ceiling reached) scores 0 and shows "being checked". It's tried again when the player next opens the daily (at most once a minute) and in the overnight pass; points are added when it's confirmed. A day with answers still unchecked waits up to two days before its rarity bonuses are counted. Answers of more than three words are turned down without asking.
- **Untrusted text:** answers go to the referee as JSON data with an instruction never to follow what they say, and the overnight pass checks one player's answers per request.
- **Singular and plural:** for rare and shared answers, singular and plural count as the same answer in the animal, plant and object categories: Arabic ة/ات endings (تمرة, تمرات, تمر) and English s/es/ies plus common irregulars (mice, mouse) by rule (`harfGroup` in rules.js), and irregular plurals (قطط for قطة) through the singular form the referee returns with each verdict (`base`, saved with it). Names and places are compared as written.
- **Misspellings:** a misspelt answer counts when it's clear what was meant ("catapilar" → caterpillar). The player sees "Counted as “Caterpillar”", and the corrected spelling is what's compared for rare and shared answers. The correction is saved with the verdict.
- **Appeals:** a player can appeal an answer turned down for its category (not one with the wrong first letter). A stronger model (`HARF_APPEAL_MODEL`, default `claude-sonnet-5-5`) takes a second look, allowing rare, classical, regional and dialect words. A win counts at once (in the daily it can complete a perfect day and its streak bonus) and the word is accepted for everyone from then on. Up to `HARF_APPEALS_PER_DAY` per player (default 5); daily appeals work on today's answers and on yesterday's until midnight UTC (a won appeal on yesterday adds the answer's 10 points and its rarity bonus; other players' bonuses aren't recounted).
- The hourly ceiling is counted per clock hour and saved, so restarts and wake-ups don't reset it.
- **Admin page:** set `ADMIN_KEY` (a password you choose) on `hangman-rush`, then open `/admin` on the game server's address (`/admin/harf` still works). Overview: visitors per page (today, 7 and 30 days; devices, never IPs) and players per game. A tab per game lists its players and can hide one from that game's leaderboards (reversible). The Harf tab also has API usage and the saved verdicts, where a wrong verdict can be switched. A switch also re-scores answers with that word from today and the last two days: today's are counted again at once, perfect streak included; an earlier finished day is opened again for everyone so its points and rarity bonuses are counted afresh.
- Optional: `HARF_MODEL` (default `claude-haiku-5-5`). The daily letter order is shuffled with `HARF_KEY` (falls back to `DAILY_KEY`), so the public code can't reveal tomorrow's letter.

## Sign in with Google (optional)

Players stay anonymous by default. Signing in with Google links a player's progress to their Google account, so signing in on another device brings the same streaks and leaderboard entries. A device that already has its own progress is asked before switching. Only Google's account number is stored (`auth_accounts`), never an email address; the player's token is kept encrypted with `ACCOUNT_KEY` (falls back to `DAILY_KEY`, so changing that key signs everyone out of their saved progress).

Signed-in players get their own daily AI allowance in Harf rooms instead of sharing their network's.

When a device with guest progress of its own switches to an account that already has progress, its results are merged into the account (`merges.js`): days only that device played come across; where both played the same day, the result played first counts (daily results record when they were played); days from before play times were recorded keep the higher score. Once per account per season. The left-behind guest player is hidden from the leaderboards.

To turn it on, set `GOOGLE_CLIENT_ID` on `hangman-rush`: in Google Cloud Console, create an OAuth client ID of type "Web application" with these Authorized JavaScript origins: `https://rushgames.cc` and `https://api.rushgames.cc`. No client secret is needed. Without `GOOGLE_CLIENT_ID` the sign-in box doesn't appear.

## Limits against abuse

All in `limits.js`, kept in memory (a restart clears them):

- **Real address:** taken from `CF-Connecting-IP` (set by Cloudflare in front of Render), else the last `X-Forwarded-For` entry; never the first, which the visitor controls. `GET /api/whoami` shows what the server sees for you.
- **Proxy secret (optional, recommended):** the onrender.com address can be reached without Cloudflare, where anyone can send their own `CF-Connecting-IP`. To close that, set it up in this order: (1) in Cloudflare, add a Transform Rule (Modify request header) on `api.rushgames.cc` that sets `x-proxy-secret` to a long random value; (2) check `https://api.rushgames.cc/api/whoami` still shows your own address; (3) set the same value as `PROXY_SECRET` on `hangman-rush` and redeploy. Setting `PROXY_SECRET` without the Cloudflare rule makes every player look like one of Cloudflare's few addresses, so the per-address limits would hit everyone.
- **Admin key:** besides 20 tries a minute per address, wrong keys share one bucket for everyone: after 10 wrong keys the admin pages answer "Too many wrong keys" for a few minutes (one more try every 2 minutes), even with the right key.
- **Hangman daily:** played on the server (`hangman.js`), like Trivia and Harf. The word stays on the server until the player has finished: the page sends one letter at a time and gets back where it appears, and the server keeps the clock, misses and hints, scores the word and writes the result into the same `players` records as before. Saves from the page can't remove or change a result the server wrote. Until older open pages are gone, the server still accepts their saves (at most 340 points a day, 0 for a miss, no days past tomorrow, a finished day can't be changed) and still answers `/api/daily` for them.
- **Writes:** 120 a minute per address across the API; Hangman saves 30 a minute; Harf checks 20 a minute; trivia room picks 12 a minute; visit counts 20 a minute (extra ones are ignored); admin requests 20 a minute.
- **New players:** an address may start `NEW_IDS_PER_IP_DAY` new player ids a day (default 40).
- **One owner per id:** a player's records in all three games must share one token, so nobody can claim an unused game slot and lock a player out (`ident.js`).
- **Live rooms:** 12 connections per address, 4 rooms per connection, 20 players per room, 10 messages a second per connection.
- **Trivia level:** room results can lower a player's level by at most 3 steps a day.
- **Names** that pass for staff (Admin, Moderator, مشرف…) show as "Player".

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
   - On `hangman-rush`: `DAILY_KEY` (Hangman words), `DAILY_AR_KEY` (Arabic Hangman words), `TRIVIA_KEY` (trivia questions), `SITE_URL` = the static site's address (e.g. `https://rushgames.cc`).
     Optional: `ANTHROPIC_API_KEY` so Harf Rush checks categories (see above).
   - On `rush-games`: `API_URL` = the game server's address (e.g. `https://api.rushgames.cc`), then redeploy it.
     Its build command is `node scripts/build-site.js` and its publish directory is `dist`.
   - Optional on `hangman-rush`: `TRIVIA_START` (`YYYY-MM-DD`, the first day of trivia set 1; set it to your launch day), `TRIVIA_COOLDOWN_DAYS` (default 60).
3. Share the static site's address. The old server address keeps working too; its home page offers players a one-tap move to the static site that keeps their identity and leaderboard place.

Only one free web service runs, so the free plan's 750 shared instance hours a month are enough to keep it up all month.

### Seasons and the database

When Render says the free database has expired: delete `hangman-rush-db`, then **Manual sync** the blueprint for a fresh one. Leaderboards reset with the season anyway, but **the seen-question history also resets**, so the 60-day "no repeats" window can only stretch as far back as the database. For permanent storage, point `DATABASE_URL` at a free Neon or Supabase database instead.

If the database doesn't answer at start-up, the server tries again three times (after 2, 5 and 10 seconds). If it's still missing or unreachable, the server keeps running on a local file that resets on restart.

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

## Tests

```bash
npm test
```

Starts the server on a temporary file and checks the pages, the game APIs, Hangman save limits, the proxy secret and the admin lock.

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
- `hangman.js`: the Hangman daily, played on the server (`/api/hangman/...`), and the encrypted word lists.
- `trivia.js`: the Trivia daily, past dailies, leaderboard, question picks and levels (`/api/trivia/...`).
- `harf.js`: the Harf daily, answer checks, the overnight rarity pass and its leaderboard (`/api/harf/...`).
- `store.js`: Postgres when `DATABASE_URL` is set, otherwise a JSON file.

Each device gets a random player id and a secret token in browser storage. Only that device can update its own records.
