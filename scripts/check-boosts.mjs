// Runs on GitHub Actions (not Cloudflare Workers) because DexScreener's
// Cloudflare WAF blocks the shared Workers egress IP range -- confirmed by
// getting a clean 200 from a GitHub-hosted runner at the same moment the
// Worker got 429/1015 from the same endpoints. Dedupe state still lives in
// the same Cloudflare KV namespace the Worker uses, accessed here via the
// Cloudflare REST API instead of a Workers binding.

const BOOSTS_ENDPOINTS = [
  'https://api.dexscreener.com/token-boosts/latest/v1',
  'https://api.dexscreener.com/token-boosts/top/v1',
];

const THRESHOLD = Number(process.env.BOOST_THRESHOLD || 50);
const TRACK_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

const ACCOUNT_ID = requireEnv('CLOUDFLARE_ACCOUNT_ID');
const NAMESPACE_ID = requireEnv('CLOUDFLARE_KV_NAMESPACE_ID');
const CF_API_TOKEN = requireEnv('CLOUDFLARE_API_TOKEN');
const NTFY_TOPIC = requireEnv('NTFY_TOPIC');
const NTFY_TOKEN = process.env.NTFY_TOKEN || '';

const KV_BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${NAMESPACE_ID}`;

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

async function kvGet(key) {
  const res = await fetch(`${KV_BASE}/values/${encodeURIComponent(key)}`, {
    headers: { authorization: `Bearer ${CF_API_TOKEN}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`KV GET ${key} failed: ${res.status} ${await res.text()}`);
  return await res.text();
}

async function kvPut(key, value, ttlSeconds) {
  const form = new FormData();
  form.append('value', value);
  if (ttlSeconds) form.append('expiration_ttl', String(ttlSeconds));
  const res = await fetch(`${KV_BASE}/values/${encodeURIComponent(key)}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${CF_API_TOKEN}` },
    body: form,
  });
  if (!res.ok) throw new Error(`KV PUT ${key} failed: ${res.status} ${await res.text()}`);
}

function fmtUsd(n) {
  const num = Number(n);
  if (!n || Number.isNaN(num)) return 'unknown';
  if (num >= 1_000_000) return `$${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 1_000) return `$${(num / 1_000).toFixed(1)}K`;
  return `$${num.toFixed(0)}`;
}

async function fetchBestPair(address) {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`);
    if (!res.ok) return null;
    const data = await res.json();
    const pairs = (data.pairs || []).filter((p) => p.chainId === 'solana');
    if (!pairs.length) return null;
    return pairs.reduce((best, p) =>
      Number(p.liquidity?.usd || 0) > Number(best.liquidity?.usd || 0) ? p : best, pairs[0]);
  } catch (err) {
    console.error('pair fetch failed', address, err);
    return null;
  }
}

async function sendNtfy(token) {
  const title = `${token.symbol} boosted x${token.boost} on Solana`;
  const message = [
    `${token.name} (${token.symbol})`,
    `Boost: ${token.boost}`,
    `Market Cap: ${fmtUsd(token.marketCap)}`,
    token.priceUsd ? `Price: $${token.priceUsd}` : null,
  ]
    .filter(Boolean)
    .concat(['', 'Contract Address:', token.address])
    .join('\n');

  const payload = {
    topic: NTFY_TOPIC,
    title,
    message,
    priority: 5,
    tags: ['rocket', 'warning'],
    actions: [
      { action: 'view', label: 'Open Chart', url: token.dexUrl, clear: true },
      { action: 'copy', label: 'Copy CA', value: token.address },
    ],
  };

  const headers = { 'content-type': 'application/json' };
  if (NTFY_TOKEN) headers.authorization = `Bearer ${NTFY_TOKEN}`;

  try {
    const res = await fetch('https://ntfy.sh', { method: 'POST', headers, body: JSON.stringify(payload) });
    const body = await res.text();
    if (!res.ok) console.error('ntfy publish failed', res.status, body);
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    console.error('ntfy publish threw', err);
    return { ok: false, status: 0, body: String(err) };
  }
}

async function checkBoosts() {
  const latest = new Map();
  const endpointErrors = [];

  for (const endpoint of BOOSTS_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, { headers: { accept: 'application/json' } });
      if (!res.ok) {
        endpointErrors.push({ endpoint, status: res.status, body: (await res.text()).slice(0, 300) });
        continue;
      }
      const data = await res.json();
      const list = Array.isArray(data) ? data : (data.tokens || []);
      for (const item of list) {
        if (item.chainId !== 'solana') continue;
        const address = item.tokenAddress;
        if (!address) continue;
        const total = Number(item.totalAmount ?? item.amount ?? 0);
        const existing = latest.get(address);
        if (!existing || total > existing.totalAmount) {
          latest.set(address, { address, totalAmount: total, url: item.url });
        }
      }
    } catch (err) {
      console.error('boost fetch failed', endpoint, err);
      endpointErrors.push({ endpoint, error: String(err && err.stack ? err.stack : err) });
    }
  }

  const alerted = [];
  const belowThreshold = [];
  const alreadyKnownAbove = [];
  const firstSightBaseline = [];
  const failed = [];

  for (const candidate of latest.values()) {
    const kvKey = `lastAmount:${candidate.address}`;
    const prevRaw = await kvGet(kvKey);
    const prev = prevRaw === null ? null : Number(prevRaw);
    const isFirstSight = prev === null;

    const justCrossed = !isFirstSight && prev < THRESHOLD && candidate.totalAmount >= THRESHOLD;

    if (!justCrossed) {
      if (candidate.totalAmount < THRESHOLD) belowThreshold.push(candidate.address);
      else if (isFirstSight) firstSightBaseline.push(candidate.address);
      else alreadyKnownAbove.push(candidate.address);
      // KV's free tier caps writes at 1,000/day account-wide. Only spend one
      // when the value actually changed -- re-writing an unchanged total on
      // every poll would blow through that fast with dozens of tokens
      // tracked every 5 minutes, most of which don't move between polls.
      if (isFirstSight || prev !== candidate.totalAmount) {
        await kvPut(kvKey, String(candidate.totalAmount), TRACK_TTL_SECONDS);
      }
      continue;
    }

    const pair = await fetchBestPair(candidate.address);
    const result = await sendNtfy({
      symbol: pair?.baseToken?.symbol || 'UNKNOWN',
      name: pair?.baseToken?.name || pair?.baseToken?.symbol || 'Unknown token',
      boost: candidate.totalAmount,
      marketCap: pair?.marketCap ?? pair?.fdv ?? null,
      priceUsd: pair?.priceUsd ?? null,
      address: candidate.address,
      dexUrl: pair?.url || candidate.url || `https://dexscreener.com/solana/${candidate.address}`,
    });

    if (!result.ok) {
      failed.push({ address: candidate.address, status: result.status });
      continue;
    }

    await kvPut(kvKey, String(candidate.totalAmount), TRACK_TTL_SECONDS);
    alerted.push(candidate.address);
  }

  return { checked: latest.size, alerted, belowThreshold, alreadyKnownAbove, firstSightBaseline, failed, endpointErrors };
}

const result = await checkBoosts();
console.log(JSON.stringify(result, null, 2));
