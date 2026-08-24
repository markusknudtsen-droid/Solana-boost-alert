const BOOSTS_ENDPOINTS = [
  'https://api.dexscreener.com/token-boosts/latest/v1',
  'https://api.dexscreener.com/token-boosts/top/v1',
];

const ALERT_TTL_SECONDS = 60 * 60 * 12; // don't re-alert the same token for 12h

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
      await sendNtfy(env, {
        symbol: 'TEST',
        name: 'Test Token',
        boost: 999,
        marketCap: 1234567,
        priceUsd: '0.00001234',
        address: 'TestCA1111111111111111111111111111111111',
        dexUrl: 'https://dexscreener.com',
      });
      return new Response('Test notification sent. Check your phone.');
    }

    return new Response(
      'memescopebot is running.\nGET /run to check boosts right now.\nGET /test-ntfy to verify push notifications.',
    );
  },
};

async function checkBoosts(env) {
  const threshold = Number(env.BOOST_THRESHOLD || 50);
  const candidates = new Map();

  for (const endpoint of BOOSTS_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, { headers: { accept: 'application/json' } });
      if (!res.ok) continue;
      const data = await res.json();
      const list = Array.isArray(data) ? data : (data.tokens || []);
      for (const item of list) {
        if (item.chainId !== 'solana') continue;
        const total = Number(item.totalAmount ?? item.amount ?? 0);
        if (total < threshold) continue;
        const address = item.tokenAddress;
        if (!address || candidates.has(address)) continue;
        candidates.set(address, { address, totalAmount: total, url: item.url });
      }
    } catch (err) {
      console.error('boost fetch failed', endpoint, err);
    }
  }

  const alerted = [];
  const skipped = [];

  for (const candidate of candidates.values()) {
    const kvKey = `alerted:${candidate.address}`;
    const already = await env.SEEN.get(kvKey);
    if (already) {
      skipped.push(candidate.address);
      continue;
    }

    const pair = await fetchBestPair(candidate.address);

    await sendNtfy(env, {
      symbol: pair?.baseToken?.symbol || 'UNKNOWN',
      name: pair?.baseToken?.name || pair?.baseToken?.symbol || 'Unknown token',
      boost: candidate.totalAmount,
      marketCap: pair?.marketCap ?? pair?.fdv ?? null,
      priceUsd: pair?.priceUsd ?? null,
      address: candidate.address,
      dexUrl: pair?.url || candidate.url || `https://dexscreener.com/solana/${candidate.address}`,
    });

    await env.SEEN.put(kvKey, '1', { expirationTtl: ALERT_TTL_SECONDS });
    alerted.push(candidate.address);
  }

  return { checked: candidates.size, alerted, skipped };
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
    '',
    'Contract Address:',
    token.address,
  ]
    .filter(Boolean)
    .join('\n');

  const payload = {
    topic: env.NTFY_TOPIC,
    title,
    message,
    priority: 5,
    tags: ['rocket', 'warning'],
    actions: [
      { action: 'view', label: 'Open Chart', url: token.dexUrl, clear: true },
      { action: 'clipboard', label: 'Copy CA', text: token.address },
    ],
  };

  const res = await fetch('https://ntfy.sh', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    console.error('ntfy publish failed', res.status, await res.text());
  }
}
