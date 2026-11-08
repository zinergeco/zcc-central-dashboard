// Quant Nexus — Zinerge Quant Nexus v1.1 sci-fi trading terminal.
// Fully self-contained client-side engine (index.html does its own Binance
// fetch/WebSocket + technical-indicator scoring in the browser). This server
// does exactly two things: serve that one HTML file, and proxy three small
// read-only data calls that index.html prefers to fetch same-origin (so
// macro/news data stays reliable even if a browser's own cross-origin fetch
// to alternative.me/coingecko/cryptocompare is ever blocked or rate-limited).
//
// Nothing here calls the Anthropic API or Supabase — this engine's "agents"
// are deterministic technical-indicator scoring (EMA/RSI/MACD/ATR, funding,
// OI, long/short ratio, taker ratio, Fear & Greed, news-keyword sentiment),
// not LLM-generated analysis. That's a deliberate trade for the full
// sci-fi/animated experience this page delivers; see the project doc for
// the earlier Anthropic-backed version this replaced.

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

async function getJSON(url, ms = 10000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'quant-nexus/1.1' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

function sendJSON(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

async function apiHealth(req, res) {
  sendJSON(res, 200, { ok: true });
}

async function apiMacro(req, res) {
  try {
    const [fng, cg] = await Promise.all([
      getJSON('https://api.alternative.me/fng/?limit=2'),
      getJSON('https://api.coingecko.com/api/v3/global'),
    ]);
    const d = cg.data;
    sendJSON(res, 200, {
      fng: {
        now: +fng.data[0].value,
        prev: +fng.data[1].value,
        label: fng.data[0].value_classification,
      },
      global: {
        mcap: d.total_market_cap.usd,
        mchg: d.market_cap_change_percentage_24h_usd,
        dom: d.market_cap_percentage.btc,
        ethDom: d.market_cap_percentage.eth,
        vol: d.total_volume.usd,
      },
    });
  } catch (err) {
    sendJSON(res, 200, { fng: null, global: null, error: err.message });
  }
}

async function apiNews(req, res) {
  try {
    const n = await getJSON('https://min-api.cryptocompare.com/data/v2/news/?lang=EN', 12000);
    if (!Array.isArray(n.Data)) throw new Error(n.Message || 'no data');
    const items = n.Data.slice(0, 60).map((x) => ({
      title: x.title,
      url: x.url,
      src: (x.source_info && x.source_info.name) || x.source,
      t: x.published_on * 1000,
      body: x.body || '',
    }));
    sendJSON(res, 200, { items, status: { cryptocompare: 'ok' } });
  } catch (err) {
    sendJSON(res, 200, { items: [], status: { cryptocompare: 'error: ' + err.message } });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === '/healthz') {
      res.writeHead(200);
      res.end('ok');
      return;
    }
    if (req.url === '/api/health') return apiHealth(req, res);
    if (req.url === '/api/macro') return apiMacro(req, res);
    if (req.url === '/api/news') return apiNews(req, res);

    // Everything else serves the single-page app.
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(INDEX_HTML);
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('Server error: ' + err.message);
  }
});

server.listen(PORT, () => {
  console.log(`Quant Nexus (sci-fi engine) running on port ${PORT}`);
});
