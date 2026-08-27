# Solana-boost-alert

Checks DexScreener every 5 minutes for Solana tokens whose boost total just
crossed 50+, looks up market cap, and pushes an instant phone notification
via ntfy.sh with the contract address in its own copyable section (tap the
notification's "Copy CA" button to copy it straight to your clipboard).

## Architecture

- **`.github/workflows/check-boosts.yml` + `scripts/check-boosts.mjs`** —
  runs on a GitHub Actions schedule (every 5 minutes, GitHub's minimum
  interval). This is where the actual boost-checking happens.
- **Cloudflare Workers KV** — stores each token's last-seen boost total, so
  a repeat poll doesn't re-alert on a token that's just sitting above the
  threshold (see "How it decides what's a new boost" below). Accessed by the
  Action directly via the Cloudflare REST API — no Cloudflare Worker
  involved in checking.
- **The `solana-boost-alerts` Cloudflare Worker** (`src/index.js`) only
  sends/verifies ntfy pushes now (`/test-ntfy`). It used to also run the
  1-minute boost check on a Cron Trigger, but **DexScreener's Cloudflare WAF
  blocks the shared Workers egress IP range** — confirmed by getting a clean
  200 from a GitHub Actions runner at the exact moment the Worker got a
  persistent `429` / `error code: 1015` from the same endpoints. That's why
  checking moved to GitHub Actions and checks run every 5 minutes instead of
  every 1 minute: it's the fastest interval GitHub's scheduler supports, and
  in practice a busy queue can delay a run by a few extra minutes on top of
  that.

Every push to `main` still auto-deploys the Worker via
`.github/workflows/deploy.yml`.

## One-time setup

### 1. Get the alert on your phone

1. Install the **ntfy** app: [iOS](https://apps.apple.com/us/app/ntfy/id1625396347) / [Android](https://play.google.com/store/apps/details?id=io.heckel.ntfy)
2. Subscribe to topic `sol-boost-bea2d303a1f27eaa` (already installed/subscribed if you're reading this after setup).

   This topic is a random private channel — don't share it publicly.

### 2. Cloudflare API token (used by both workflows)

Stored as an **Environment secret** named `CLOUDFLARE_API_TOKEN_SCOPE` under
the environment `Scope` — both `deploy.yml` and `check-boosts.yml` declare
`environment: Scope` to see it. It needs Workers Scripts + Workers KV Storage
edit access (the **"Edit Cloudflare Workers"** dashboard template covers
both): Cloudflare dashboard → **My Profile → API Tokens → Create Token** →
GitHub repo → **Settings → Environments → Scope → Add secret**, named
`CLOUDFLARE_API_TOKEN_SCOPE`.

### 3. Add an ntfy access token (important for reliable delivery)

ntfy.sh enforces its **250 messages/day limit per visitor IP**, and requests
sharing an IP pool (like GitHub Actions runners, or previously Cloudflare
Workers) can have that quota exhausted by unrelated traffic — producing
`429 daily message quota reached` even when you personally sent nothing.

Authenticating bills the quota to your account instead:

1. Create a free account at [ntfy.sh](https://ntfy.sh/app) → **Account**.
2. Generate an **access token** (starts with `tk_`).
3. GitHub repo → **Settings → Environments → Scope → Add secret**, named
   `NTFY_TOKEN`.

`/test-ntfy` on the Worker reports `"authenticated": true` once the token is
picked up (it's also uploaded to the Worker as a Cloudflare secret by
`deploy.yml`, and read directly from the GitHub secret by
`check-boosts.yml`). Without a token the bot still works, but delivery
depends on a shared quota.

## Verify it works

- **Test the push path**: `https://solana-boost-alerts.markusknudtsen.workers.dev/test-ntfy`
  sends a synthetic test alert immediately, so you can confirm the phone
  popup and "Copy CA" button work without waiting for a real 50+ boost.
- **Test the check path**: GitHub repo → **Actions → Check Solana boosts →
  Run workflow** runs a check cycle right now; open the run's log for JSON
  showing what it found/alerted/skipped.

## Config

Edit the `env:` block in `.github/workflows/check-boosts.yml` to change
`BOOST_THRESHOLD` (default `50`) or `NTFY_TOPIC`.

## How it decides what's a "new" boost

DexScreener's boost endpoints are leaderboard snapshots — they report each
token's *current* total boost, not when it got there. To avoid alerting on
boosts that happened hours ago (before a check ever noticed them), each run
tracks every token's last-seen boost total in Cloudflare KV and only alerts
on the actual transition from below the threshold to at/above it.

- A token first ever seen already above the threshold is recorded silently
  as a baseline and **not** alerted — there's no way to know if that boost
  is brand new or ten hours old.
- A token that goes from, say, 20 to 75 between checks **is** alerted —
  that's a genuine new crossing.
- A token that stays above the threshold across checks never re-alerts.
- If a token's boosts expire and it later gets boosted again past the
  threshold, that's a fresh crossing and alerts again.

## Note on field names

DexScreener's boosts API isn't formally documented; the parsing here follows
its known public shape (`chainId`, `tokenAddress`, `amount`, `totalAmount`).
If a run comes back with 0 checked and no `endpointErrors`, and DexScreener
is reachable from elsewhere, check the raw response shape against
`scripts/check-boosts.mjs`.
