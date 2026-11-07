# XENO.IO: Extinction Event

A 2D .io survival game: 700 aliens (100 per planet) that grow through 5 life stages, 7 planets with natural disasters, Story / Online / Offline modes,
Google sign-in with cloud saves, and leaderboards.

## Files
- `index.html`: the whole game (works on its own for Offline, Story and bot matches)
- `server.js`: multiplayer server + serves the game
- `accounts.js`: Google sign-in, cloud saves, leaderboards
- `package.json`: start command; installs `pg` for the database

## Run locally
    npm install
    node server.js        # http://localhost:8080
To test sign-in without Google: `DEV_LOGIN=1 node server.js` (never enable this online).

## Turn on Google sign-in + leaderboards (online)

### 1. Free permanent database (Neon)
1. Sign up at neon.com and create a project.
2. Copy the **connection string** (starts with `postgresql://`).

(Render's own free database is deleted after 30 days. Neon's free plan has no time limit.)

### 2. Google sign-in client
1. Go to console.cloud.google.com, create a project (e.g. "Xeno io").
2. **APIs & Services → OAuth consent screen**: choose External, app name "XENO.IO", your email. Save.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**.
   - Application type: **Web application**
   - Authorized JavaScript origins: `https://YOUR-APP.onrender.com` (and `http://localhost:8080` for testing)
4. Copy the **Client ID** (ends in `.apps.googleusercontent.com`). No client secret is needed.

### 3. Render settings (your service → Environment)
| Key | Value |
|---|---|
| `GOOGLE_CLIENT_ID` | the Client ID from step 2 |
| `DATABASE_URL` | the Neon connection string |
| `SESSION_SECRET` | any long random text (keeps players signed in) |
| `ADMIN_KEY` | any long random text; lets you read player and bug reports at `/api/reports?key=YOUR_KEY` |

Also check **Settings → Build Command** is `npm install`. Save. Render redeploys automatically.

## Reports
Players can report a player or a bug from the main menu or the pause menu. Reports are stored in the database
(or `data/reports.json` without one), rate limited to 6 per hour per player, and readable only with `ADMIN_KEY`.

## Notes
- Progress is merged the first time a guest signs in on a device; after that the cloud save is the master copy.
- The server validates saves and scores (limits, rate limiting), but the game is client-side, so a determined
  cheater could still fake numbers. Before selling premium aliens for real money, move DNA/purchases to
  server-side checks.
- Leaderboards show the in-game name players type on the main menu (their Google first name by default),
  never their email.
