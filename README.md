# Hangman Rush

Multiplayer hangman you play on your phone, in English or Arabic (the words themselves stay English). Everyone gets the same word at the same moment; fastest solve with the fewest misses wins.

- **Rooms:** create a room, share the 4-letter code, and race. Free-for-all or Blue vs Red teams (team score is the members' average, so uneven teams stay fair).
- **Daily word:** one word a day for everyone (changes at midnight UTC), one attempt, a shared leaderboard and streaks.
- **Solo practice:** no server features needed.

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

## How it fits together

- `public/index.html`: the game.
- `public/claude-shim.js`: talks to this server for live rooms (WebSocket) and the leaderboard (HTTP).
- `server.js`: serves the page, runs rooms at `/ws`, and the API at `/api/players`.
- `store.js`: Postgres when `DATABASE_URL` is set, otherwise a JSON file.

Each device gets a random player id and a secret token in browser storage. Only that device can update its own leaderboard entry.
