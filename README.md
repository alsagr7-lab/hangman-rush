# Hangman Rush

Multiplayer hangman you play on your phone. Everyone gets the same word at the same moment; fastest solve with the fewest misses wins.

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

### Keeping the leaderboard and streaks

With no database the leaderboard is saved to a file. Render's free plan wipes that file on every deploy or restart, so streaks reset.
To keep them, create a Postgres database (Render, Neon or Supabase all work), then add its connection string to the web service as the
environment variable `DATABASE_URL`. The table is created automatically on start.

The free plan also sleeps after about 15 minutes idle, so the first visit afterwards takes 30–60 seconds to load.

## How it fits together

- `public/index.html`: the game.
- `public/claude-shim.js`: talks to this server for live rooms (WebSocket) and the leaderboard (HTTP).
- `server.js`: serves the page, runs rooms at `/ws`, and the API at `/api/players`.
- `store.js`: Postgres when `DATABASE_URL` is set, otherwise a JSON file.

Each device gets a random player id and a secret token in browser storage. Only that device can update its own leaderboard entry.
