// Boost checking runs on a schedule via GitHub Actions
// (.github/workflows/check-boosts.yml + scripts/check-boosts.mjs), not from
// this Worker. DexScreener's Cloudflare WAF blocks the shared Workers
// egress IP range with a persistent 429/1015 -- confirmed by getting a
// clean 200 from a GitHub-hosted runner at the same moment this Worker got
// blocked. This Worker now only exists to send/verify ntfy pushes.

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

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
      'solana-boost-alerts: ntfy sender only.\n' +
      'Boost checking runs via GitHub Actions (check-boosts.yml), not this Worker.\n' +
      'GET /test-ntfy to verify push notifications.',
    );
  },
};

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
