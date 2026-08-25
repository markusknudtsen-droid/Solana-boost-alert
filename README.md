# Solana-boost-alert

Polls DexScreener every minute for Solana tokens whose boost total hits 50+,
looks up market cap, and pushes an instant phone notification via ntfy.sh
with the contract address in its own copyable section (tap the notification's
"Copy CA" button to copy it straight to your clipboard).

Deploys as a Cloudflare Worker. Every push to `main` auto-deploys via
GitHub Actions (`.github/workflows/deploy.yml`).

## One-time setup

### 1. Get the alert on your phone

1. Install the **ntfy** app: [iOS](https://apps.apple.com/us/app/ntfy/id1625396347) / [Android](https://play.google.com/store/apps/details?id=io.heckel.ntfy)
2. Subscribe to topic `sol-boost-bea2d303a1f27eaa` (already installed/subscribed if you're reading this after setup).

   This topic is a random private channel — don't share it publicly.

### 2. Let GitHub Actions deploy for you

The workflow needs a Cloudflare API token as a repo secret:

1. Go to the Cloudflare dashboard → **My Profile → API Tokens → Create Token**.
   Use the **"Edit Cloudflare Workers"** template (grants Workers Scripts + KV
   edit access), scoped to your account.
2. Copy the generated token.
3. In this GitHub repo: **Settings → Secrets and variables → Actions → New
   repository secret**.
   - Name: `CLOUDFLARE_API_TOKEN`
   - Value: the token you copied
4. Push any change to `main` (or re-run the workflow from the **Actions** tab)
   to trigger a deploy.

That's it — no local `wrangler` commands needed. Every future push to `main`
redeploys automatically.

## Verify it works

After the first successful deploy (check the **Actions** tab for a green
run), open in a browser:

- `https://solana-boost-alert.<your-subdomain>.workers.dev/test-ntfy` — sends
  a synthetic test alert immediately, so you can confirm the phone popup and
  "Copy CA" button work without waiting for a real 50+ boost.
- `https://solana-boost-alert.<your-subdomain>.workers.dev/run` — manually
  runs one check cycle now and returns JSON of what it found/alerted/skipped.

## Config

Edit the `vars` block in `wrangler.toml`, commit, and push to change:

- `BOOST_THRESHOLD` — minimum total boost to alert on (default `50`)
- `NTFY_TOPIC` — your ntfy topic name

## How it dedupes

Each alerted token address is written to the `SEEN` KV namespace for 12 hours,
so a token that stays boosted doesn't re-alert every minute. If it drops off
and gets freshly boosted again after that window, you'll get a new alert.

## Note on field names

DexScreener's boosts API isn't formally documented; the parsing here follows
its known public shape (`chainId`, `tokenAddress`, `amount`, `totalAmount`).
If `/run` comes back with 0 checked despite boosts existing on the site, check
the Cloudflare dashboard's Worker logs during a cron run and compare the raw
response shape against the code in `src/index.js`.
