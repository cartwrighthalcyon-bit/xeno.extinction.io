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
| `STRIPE_SECRET_KEY` | your Stripe secret key (`sk_test_...` to test, `sk_live_...` for real money); turns on real checkout |
| `STRIPE_WEBHOOK_SECRET` | optional: the `whsec_...` signing secret of a Stripe webhook pointing at `/api/stripe/webhook` |
| `ADSENSE_CLIENT` | optional: your AdSense publisher id (`ca-pub-...`) to show an ad after a player is defeated |
| `ADSENSE_TEST` | optional: `1` shows Google test ads while your AdSense account is being approved |
| `ANDROID_PACKAGE` | the Google Play app's package name (for example `io.onrender.xeno_extinction_io.twa`) |
| `ANDROID_SHA256` | the app signing certificate SHA-256 fingerprint(s) from Play Console, comma-separated; served at `/.well-known/assetlinks.json` |
| `ADMIN_KEY` | any long random text; lets you read player and bug reports at `/api/reports?key=YOUR_KEY` |

Also check **Settings → Build Command** is `npm install`. Save. Render redeploys automatically.

## Payments (Stripe)
With `STRIPE_SECRET_KEY` set, the store's packs, premium aliens and gifts open Stripe Checkout. Prices come from
`catalog.json` on the server, never from the browser. Paid items are delivered to the buyer's Google account (or a
friend's, for gifts) and premium aliens can only be kept by accounts that paid for them. Without the key the store
stays a free demo.

Webhook (recommended, so purchases arrive even if the player closes the tab): Stripe Dashboard → Developers →
Webhooks → Add endpoint `https://YOUR-APP.onrender.com/api/stripe/webhook`, events `checkout.session.completed`
and `checkout.session.async_payment_succeeded`. Put its signing secret in `STRIPE_WEBHOOK_SECRET`.

Test with a `sk_test_` key and card 4242 4242 4242 4242 before switching to `sk_live_`.

## Google Play
The site is an installable web app (manifest, icons, offline service worker). Package it at pwabuilder.com → Android,
upload the `.aab` to Play Console, then set `ANDROID_PACKAGE` and `ANDROID_SHA256` so Android trusts the site and hides the browser bar.
Inside the Play app, real-money purchases are switched off: Google Play requires its own billing for digital items.

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

## Payments: Lemon Squeezy (preferred) or Stripe

Lemon Squeezy is used when all four of these are set on the server (it is the seller of record and handles sales tax):

- `LEMONSQUEEZY_API_KEY`: Settings → API in Lemon Squeezy
- `LEMONSQUEEZY_STORE_ID`: the number in Settings → Stores
- `LEMONSQUEEZY_VARIANT_ID`: the variant ID of one product (any price; each checkout sets its own name and price)
- `LEMONSQUEEZY_WEBHOOK_SECRET`: the signing secret of a webhook pointing at `https://<your-site>/api/lemonsqueezy/webhook` with the `order_created` event
- optional `LEMONSQUEEZY_TEST=1` while the store is in test mode

Without them, `STRIPE_SECRET_KEY` (Stripe) is used if set; with neither, the store shows "opening soon".
