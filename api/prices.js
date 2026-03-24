// /api/prices.js — Vercel Serverless Function
// Proxies stock price requests to Yahoo Finance (free, no API key needed)
// Called by WealthOS frontend: POST /api/prices { tickers: ["AAPL","MSFT"] }

const cache = {};
const CACHE_TTL = 20000; // 20-second server-side cache per ticker

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { tickers } = req.body || {};

    if (!tickers || !Array.isArray(tickers) || tickers.length === 0) {
      return res.status(400).json({ error: 'Missing tickers array' });
    }

    // Limit to 50 tickers per request
    const tickerList = tickers.slice(0, 50).map(t => t.trim().toUpperCase());

    const prices = {};
    const errors = [];
    const now = Date.now();

    // Check cache first
    const uncached = [];
    for (const ticker of tickerList) {
      if (cache[ticker] && (now - cache[ticker].ts) < CACHE_TTL) {
        prices[ticker] = cache[ticker].price;
      } else {
        uncached.push(ticker);
      }
    }

    // Fetch uncached tickers from Yahoo Finance
    if (uncached.length > 0) {
      const symbols = uncached.join(',');
      const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols)}&fields=regularMarketPrice,symbol`;

      try {
        const response = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; WealthOS/1.0)',
          },
          signal: AbortSignal.timeout(10000),
        });

        if (!response.ok) {
          // Fallback: try v8 endpoint
          const fallbackUrl = `https://query2.finance.yahoo.com/v8/finance/chart/${uncached[0]}?interval=1d&range=1d`;
          if (uncached.length === 1) {
            try {
              const fb = await fetch(fallbackUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0' },
                signal: AbortSignal.timeout(8000),
              });
              if (fb.ok) {
                const fbData = await fb.json();
                const meta = fbData?.chart?.result?.[0]?.meta;
                if (meta?.regularMarketPrice) {
                  const t = uncached[0];
                  prices[t] = meta.regularMarketPrice;
                  cache[t] = { price: meta.regularMarketPrice, ts: Date.now() };
                }
              }
            } catch (e) {
              errors.push(`${uncached[0]}: fallback failed`);
            }
          } else {
            errors.push(`Yahoo Finance returned HTTP ${response.status}`);
          }
        } else {
          const data = await response.json();
          const results = data?.quoteResponse?.result || [];

          for (const quote of results) {
            const sym = quote.symbol;
            const price = quote.regularMarketPrice;
            if (sym && price && price > 0) {
              prices[sym] = price;
              cache[sym] = { price, ts: Date.now() };
            }
          }

          // Check for tickers not found
          for (const t of uncached) {
            if (!prices[t]) {
              errors.push(`${t}: not found`);
            }
          }
        }
      } catch (fetchErr) {
        errors.push('Yahoo Finance fetch error: ' + fetchErr.message);

        // Fall back to individual chart API for each ticker
        for (const t of uncached) {
          try {
            const chartUrl = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(t)}?interval=1d&range=1d`;
            const chartRes = await fetch(chartUrl, {
              headers: { 'User-Agent': 'Mozilla/5.0' },
              signal: AbortSignal.timeout(5000),
            });
            if (chartRes.ok) {
              const chartData = await chartRes.json();
              const meta = chartData?.chart?.result?.[0]?.meta;
              if (meta?.regularMarketPrice) {
                prices[t] = meta.regularMarketPrice;
                cache[t] = { price: meta.regularMarketPrice, ts: Date.now() };
              }
            }
          } catch (e) {
            // skip individual failures silently
          }
        }
      }
    }

    return res.status(200).json({
      prices,
      errors: errors.length > 0 ? errors : undefined,
      cached: tickerList.length - uncached.length,
      fetched: uncached.length,
    });

  } catch (err) {
    console.error('prices.js error:', err);
    return res.status(500).json({ error: 'Internal server error', message: err.message });
  }
}