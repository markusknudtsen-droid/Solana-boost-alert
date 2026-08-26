const BOOSTS_ENDPOINTS = [
  'https://api.dexscreener.com/token-boosts/latest/v1',
  'https://api.dexscreener.com/token-boosts/top/v1',
];

const TRACK_TTL_SECONDS = 60 * 60 * 24 * 30; // remember each token's boost level for 30 days

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkBoosts(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/run') {
      const result = await checkBoosts(env);
      return new Response(JSON.stringify(result, null, 2), {
        headers: { 'content-type': 'application/json' },
      });
    }

    if (url.pathname === '/test-ntfy') {
      const result = await sendNtfy(env, {
        symbol: 'TEST',
        name: 'Test Token',
        boost: 999,
        marketCap: 1234567,
        priceUsd: '0.00001234',
        address: 'TestCA1111111111111111111111111111111111',
        dexUrl: 'https://dexscreener.com',
      });
      return new Response(JSON.stringify({
        topic: env.NTFY_TOPIC,
        authenticated: Boolean(env.NTFY_TOKEN),
        ntfy: result,
      }, null, 2), {
        status: result.ok ? 200 : 502,
        headers: { 'content-type': 'application/json' },
      });
    }

    return new Response(
      'solana-boost-alerts is running.\nGET /run to check boosts right now.\nGET /test-ntfy to verify push notifications.',
    );
  },
};

async function checkBoosts(env) {
  const threshold = Number(env.BOOST_THRESHOLD || 50);

  // DexScreener's boost endpoints are leaderboard snapshots with no
  // timestamp -- they don't say *when* a token crossed the threshold, only
  // its current total. Collect every Solana token's current total here
  // (regardless of level) so it can be compared against its previously
  // recorded total below.
  const latest = new Map();

  for (const endpoint of BOOSTS_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, { headers: { accept: 'application/json' } });
      if (!res.ok) continue;
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
    }
  }

  const alerted = [];
  const belowThreshold = [];
  const alreadyKnownAbove = [];
  const firstSightBaseline = [];
  const failed = [];

  for (const candidate of latest.values()) {
    const kvKey = `lastAmount:${candidate.address}`;
    const prevRaw = await env.SEEN.get(kvKey);
    const prev = prevRaw === null ? null : Number(prevRaw);
    const isFirstSight = prev === null;

    // Only a genuine crossing -- previously below, now at/above -- counts as
    // a fresh boost. A token first seen already above threshold gets its
    // level recorded silently: we have no way to know if that happened just
    // now or hours ago, so (per the "don't alert on stale boosts" requirement)
    // it is never alerted on its first sighting, only on a later real jump.
    const justCrossed = !isFirstSight && prev < threshold && candidate.totalAmount >= threshold;

    if (!justCrossed) {
      if (candidate.totalAmount < threshold) belowThreshold.push(candidate.address);
      else if (isFirstSight) firstSightBaseline.push(candidate.address);
      else alreadyKnownAbove.push(candidate.address);
      await env.SEEN.put(kvKey, String(candidate.totalAmount), { expirationTtl: TRACK_TTL_SECONDS });
      continue;
    }

    const pair = await fetchBestPair(candidate.address);

    const result = await sendNtfy(env, {
      symbol: pair?.baseToken?.symbol || 'UNKNOWN',
      name: pair?.baseToken?.name || pair?.baseToken?.symbol || 'Unknown token',
      boost: candidate.totalAmount,
      marketCap: pair?.marketCap ?? pair?.fdv ?? null,
      priceUsd: pair?.priceUsd ?? null,
      address: candidate.address,
      dexUrl: pair?.url || candidate.url || `https://dexscreener.com/solana/${candidate.address}`,
    });

    // Only record the new level once the push actually went out. Leaving the
    // old (below-threshold) value in place on failure means this crossing is
    // retried on the next poll instead of being silently swallowed.
    if (!result.ok) {
      failed.push({ address: candidate.address, status: result.status });
      continue;
    }

    await env.SEEN.put(kvKey, String(candidate.totalAmount), { expirationTtl: TRACK_TTL_SECONDS });
    alerted.push(candidate.address);
  }

  return { checked: latest.size, alerted, belowThreshold, alreadyKnownAbove, firstSightBaseline, failed };
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

function fmtUsd(n) {
  const num = Number(n);
  if (!n || Number.isNaN(num)) return 'unknown';
  if (num >= 1_000_000) return `$${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 1_000) return `$${(num / 1_000).toFixed(1)}K`;
  return `$${num.toFixed(0)}`;
}

async function sendNtfy(env, token) {
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
    topic: env.NTFY_TOPIC,
    title,
    message,
    priority: 5,
    tags: ['rocket', 'warning'],
    actions: [
      { action: 'view', label: 'Open Chart', url: token.dexUrl, clear: true },
      { action: 'copy', label: 'Copy CA', value: token.address },
    ],
  };

  // ntfy.sh applies its daily quota per visitor, and unauthenticated requests
  // from a Worker are identified by Cloudflare's shared egress IP -- a pool
  // other tenants can exhaust. An access token bills the quota to the account
  // instead, so set NTFY_TOKEN to keep delivery independent of that pool.
  const headers = { 'content-type': 'application/json' };
  if (env.NTFY_TOKEN) {
    headers.authorization = `Bearer ${env.NTFY_TOKEN}`;
  }

  try {
    const res = await fetch('https://ntfy.sh', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    const body = await res.text();
    if (!res.ok) {
      console.error('ntfy publish failed', res.status, body);
    }
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    console.error('ntfy publish threw', err);
    return { ok: false, status: 0, body: String(err) };
  }
}
