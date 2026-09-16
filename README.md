# Solana-boost-alert

Checks DexScreener every 5 minutes for Solana tokens whose boost total just
crossed 50+, looks up market cap, and pushes an instant phone notification
via ntfy.sh with the contract address in its own copyable section (tap the
notification's "Copy CA" button to copy it straight to your clipboard).

## Architecture

- **`.github/workflows/check-boosts.yml` + `scripts/check-boosts.mjs`** —
  this is where the actual boost-checking happens, on a GitHub Actions
  runner.
- **Cloudflare Workers KV** — stores each token's last-seen boost total, so
  a repeat poll doesn't re-alert on a token that's just sitting above the
  threshold (see "How it decides what's a new boost" below). Accessed by the
  Action directly via the Cloudflare REST API — no Cloudflare Worker
  involved in checking.
- **The `solana-boost-alerts` Cloudflare Worker** (`src/index.js`) has two
  jobs, neither of which is checking boosts — **DexScreener's Cloudflare WAF
  blocks the shared Workers egress IP range**, confirmed by getting a clean
  200 from a GitHub Actions runner at the exact moment the Worker got a
  persistent `429` / `error code: 1015` from the same endpoints:
  1. Sends/verifies ntfy pushes (`/test-ntfy`).
  2. Runs a **Cloudflare Cron Trigger every 5 minutes** that pings GitHub's
     `workflow_dispatch` API to kick off `check-boosts.yml` (`/test-dispatch`
     to trigger this manually). This exists because GitHub's own `schedule:`
     cron on that workflow turned out to be unreliable by itself — observed
     real gaps of **2 to 12 hours** between automatic runs instead of the
     configured 5 minutes, which is GitHub deprioritizing high-frequency
     cron on a lower-traffic repo. Cloudflare Cron Triggers run reliably to
     the minute, and this ping never touches DexScreener, so the Workers-IP
     block doesn't apply to it. GitHub's own `schedule:` trigger is left in
     place too as a harmless redundant backup — the check script is safe to
     run concurrently/repeatedly (see "How it decides what's a new boost").

Every push to `main` still auto-deploys the Worker via
`.github/workflows/deploy.yml`.

**This repo is public.** It was private originally, but a 5-minute check
cadence burns through GitHub's free 2,000 Actions-minutes/month quota for
private repos in about a week (each run costs a minimum of 1 billed minute
regardless of how short it actually runs) — every run then starts failing
instantly with no logs, which is exactly what happened between Sep 7 and
Sep 16. Public repos get unlimited free Actions minutes, so the repo was
made public to keep the 5-minute cadence without paying for extra minutes.
Nothing in the code or committed config is a credential — every actual
secret (`NTFY_TOPIC` included, see below) lives only in GitHub/Cloudflare
secrets, never in a tracked file.

## One-time setup

### 1. Get the alert on your phone

1. Install the **ntfy** app: [iOS](https://apps.apple.com/us/app/ntfy/id1625396347) / [Android](https://play.google.com/store/apps/details?id=io.heckel.ntfy)
2. Pick a random, hard-to-guess topic name (e.g. `sol-boost-<32 random hex
   chars>`) and subscribe to it in the app on every device you want alerts
   on.
3. GitHub repo → **Settings → Environments → Scope → Add secret**, named
   `NTFY_TOPIC`, value = that topic name.

   **This is deliberately not committed anywhere** — this repo is public,
   and ntfy.sh has no access control on a topic beyond knowing its name:
   whoever knows the topic can read your alerts or publish fake ones to
   your phone. GitHub secrets can't be read back once saved, so keep your
   own copy (password manager, notes) if you'll need it again. It's
   uploaded to the Worker as a Cloudflare secret by `deploy.yml` and read
   directly from the GitHub secret by `check-boosts.yml`, same pattern as
   `NTFY_TOKEN` and `GH_DISPATCH_TOKEN` below. If you ever suspect the
   topic has leaked, just pick a new one and repeat this step — nothing
   else needs to change.

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

### 4. GitHub dispatch token (keeps checks actually running every 5 minutes)

The Worker's Cron Trigger needs its own GitHub token to call the
`workflow_dispatch` API — this is separate from `CLOUDFLARE_API_TOKEN_SCOPE`
(that one lets GitHub Actions talk to Cloudflare; this one lets the
Cloudflare Worker talk to GitHub).

1. GitHub → **Settings → Developer settings → Personal access tokens →
   Fine-grained tokens → Generate new token**.
2. **Repository access**: only this repository (`Solana-boost-alert`).
3. **Permissions**: Repository permissions → **Actions** → **Read and
   write**. Nothing else is needed.
4. GitHub repo → **Settings → Environments → Scope → Add secret**, named
   `GH_DISPATCH_TOKEN`.

It's uploaded to the Worker as a Cloudflare secret by `deploy.yml`, same
pattern as `NTFY_TOKEN`. Without it, `/test-dispatch` returns
`"GH_DISPATCH_TOKEN not configured"` and the Worker falls back to relying
solely on GitHub's own (unreliable) `schedule:` trigger.

## Verify it works

- **Test the push path**: `https://solana-boost-alerts.markusknudtsen.workers.dev/test-ntfy`
  sends a synthetic test alert immediately, so you can confirm the phone
  popup and "Copy CA" button work without waiting for a real 50+ boost.
- **Test the dispatch path**: `https://solana-boost-alerts.markusknudtsen.workers.dev/test-dispatch`
  fires `check-boosts.yml` on GitHub right now via the same path the Cron
  Trigger uses every 5 minutes.
- **Test the check path directly**: GitHub repo → **Actions → Check Solana
  boosts → Run workflow** runs a check cycle right now; open the run's log
  for JSON showing what it found/alerted/skipped.

## Config

Edit the `env:` block in `.github/workflows/check-boosts.yml` to change
`BOOST_THRESHOLD` (default `50`). To change which ntfy topic gets the
alerts, update the `NTFY_TOPIC` secret (step 1 above) — don't put a topic
name directly in this file, it's committed and this repo is public.

## How it decides what's a "new" boost

DexScreener's boost endpoints are leaderboard snapshots — they report each
token's *current* total boost, not when it got there. To avoid alerting on
boosts that happened hours ago (before a check ever noticed them), each run
tracks every token's last-seen boost total in Cloudflare KV and only alerts
on the actual transition from below the threshold to at/above it.

- A token first ever seen already above the threshold is normally recorded
  silently as a baseline and **not** alerted — there's no way to know if
  that boost is brand new or ten hours old. **Exception:** if it showed up
  in DexScreener's `token-boosts/latest/v1` feed specifically (a
  recent-purchase-event feed, not a size leaderboard — as opposed to only
  appearing in `token-boosts/top/v1`), that itself is a real recency
  signal, so it's treated as a genuine crossing and alerted even on first
  sight. This matters for very new tokens that get boosted straight past
  the threshold before any earlier check had a chance to record a baseline.
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
