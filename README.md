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

The workflow needs a Cloudflare API token. It is stored as an **Environment
secret** named `CLOUDFLARE_API_TOKEN_SCOPE` under the environment `Scope`,
which is why the job declares `environment: Scope` — an environment secret is
invisible to a job that doesn't.

1. Cloudflare dashboard → **My Profile → API Tokens → Create Token**, using the
   **"Edit Cloudflare Workers"** template (Workers Scripts + KV edit access).
2. GitHub repo → **Settings → Environments → Scope → Add secret**
   - Name: `CLOUDFLARE_API_TOKEN_SCOPE`
3. Push to `main` (or re-run from the **Actions** tab) to deploy.

Every future push to `main` redeploys automatically — no local `wrangler`
commands needed.

### 3. Add an ntfy access token (important for reliable delivery)

ntfy.sh enforces its **250 messages/day limit per visitor IP**. Cloudflare
Workers publish from shared egress IPs, so the anonymous quota can be
exhausted by unrelated Cloudflare tenants — producing
`429 daily message quota reached` even when you personally sent nothing.

Authenticating bills the quota to your account instead:

1. Create a free account at [ntfy.sh](https://ntfy.sh/app) → **Account**.
2. Generate an **access token** (starts with `tk_`).
3. Store it as a Cloudflare secret (not in `wrangler.toml` — it must not be
   committed):

   ```bash
   npx wrangler secret put NTFY_TOKEN
   ```

   Or via the Cloudflare dashboard: **Workers & Pages → solana-boost-alerts →
   Settings → Variables and Secrets → Add → Secret**, named `NTFY_TOKEN`.

`/test-ntfy` reports `"authenticated": true` once the token is picked up.
Without a token the bot still works, but delivery depends on a shared quota.

## Verify it works

After the first successful deploy (check the **Actions** tab for a green
run), open in a browser:

- `https://solana-boost-alerts.markusknudtsen.workers.dev/test-ntfy` — sends
  a synthetic test alert immediately, so you can confirm the phone popup and
  "Copy CA" button work without waiting for a real 50+ boost.
- `https://solana-boost-alerts.markusknudtsen.workers.dev/run` — manually
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
