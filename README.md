# Hangman Rush

Multiplayer hangman you play on your phone, in English or Arabic (the words themselves stay English). Everyone gets the same word at the same moment; fastest solve with the fewest misses wins.

- **Rooms:** create a room, share the 4-letter code, and race. Free-for-all or Blue vs Red teams (team score is the members' average, so uneven teams stay fair).
- **Words and category votes:** 1,000 room and practice words, 100 in each of 10 categories. Before each round every player can tap the categories they want; each player's vote is split across their picks and the next word's category is drawn by vote share.
- **Daily word:** one word a day for everyone (changes at midnight UTC), one attempt, a shared leaderboard and streaks. Daily words come from a separate list of 160 that never appears in rooms or practice.
- **Solo practice:** no server features needed.
- **Difficulty:** the host (or solo player) picks Easy (short words, 8 misses, 90 s), Normal, or Hard (long words, no help). The daily word is always Normal.
- **Adaptive handicap:** every player has a level that rises with each solved word and falls with each miss (rooms and the daily word only). A clue costs 50% of the round score, plus 5 points per level (25–90%). Players two or more levels below the start get extra letter reveals.
- **Help:** the first letter is free on Easy and Normal and a vowel count is shown. Two hints cost points: reveal a letter (−30; 3 for words of 7+ letters, 2 for 6, 1 for 5 or fewer) or show a clue written in the player's language. After each round the clue is shown, and Arabic players also see the word's Arabic meaning.

## Run locally

```bash
npm install
npm start
# open http://localhost:3000
```

## Deploy on Render

1. Push this repo to GitHub.
2. On render.com: **New → Blueprint**, pick the repo. `render.yaml` sets up a free web service.
   (Or **New → Web Service**: build `npm install`, start `npm start`.)
3. Open the `.onrender.com` URL and share it with friends.

### Seasons and the database

The daily leaderboard runs in **30-day seasons**. Season 1 started on 14 Oct 2026; standings, streaks and points reset at the start of
each season, and every player keeps a one-line summary of their last season.

`render.yaml` creates a free Render Postgres database and connects it automatically (`DATABASE_URL`). Render deletes free databases
after 30 days, which lines up with the season length. When Render says the database has expired:

1. Delete `hangman-rush-db` in the Render dashboard.
2. Open the Blueprint and click **Manual sync**. Render creates a fresh database and redeploys.

If the database is ever missing or unreachable, the server keeps running and falls back to a local file (which resets on restart).
Want permanent storage instead? Point `DATABASE_URL` at a Neon or Supabase database.

The free web service sleeps after about 15 minutes idle, so the first visit afterwards takes 30–60 seconds to load.

### The daily word list

The 160 daily words live only in `daily-words.enc`, encrypted, so neither the page nor this repo reveals upcoming words. The server unlocks
the file with the `DAILY_KEY` environment variable (64 hex characters) and sends players today's word only, via `/api/daily`.
Without the key, the daily word shows as unavailable. Keep the key private; anyone with it can read the list.

To change or extend the list (it repeats after 160 days, around 22 March 2027):

```bash
DAILY_KEY=... node scripts/daily-words.js decrypt > words.json   # edit, keeping words.json out of git
DAILY_KEY=... node scripts/daily-words.js encrypt words.json
```

## How it fits together

- `public/index.html`: the game.
- `public/claude-shim.js`: talks to this server for live rooms (WebSocket) and the leaderboard (HTTP).
- `server.js`: serves the page, runs rooms at `/ws`, today's word at `/api/daily` and the leaderboard at `/api/players`.
- `store.js`: Postgres when `DATABASE_URL` is set, otherwise a JSON file.

Each device gets a random player id and a secret token in browser storage. Only that device can update its own leaderboard entry.
