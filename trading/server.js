// Quant Nexus — Zinerge Quant Nexus v1.2 sci-fi trading terminal.
// Fully self-contained client-side engine (index.html does its own Binance
// fetch/WebSocket + technical-indicator scoring in the browser). This server
// serves that one HTML file, proxies small read-only data calls that
// index.html prefers to fetch same-origin (so macro/news data stays reliable
// even if a browser's own cross-origin fetch to alternative.me/coingecko/
// cryptocompare is ever blocked or rate-limited), and exposes one on-demand
// AI endpoint: POST /api/predict, which calls the real Anthropic Messages
// API (ANTHROPIC_API_KEY / ANTHROPIC_MODEL env vars) for a short written
// read on one coin's technical snapshot. That call only happens when a user
// clicks "Ask Claude" in the drawer — it is not in any polling loop.
//
// Every other signal on this page — the 8 original agent votes plus the
// new Technical Rating Engine (Stoch RSI, ADX, Ichimoku, VWAP, OBV, pivots)
// and the default "statistical prediction" panel — stays deterministic
// technical-indicator scoring computed client-side, not LLM-generated.
// See the project doc for the full architecture history.

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

async function getJSON(url, ms = 10000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'quant-nexus/1.2' } });
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

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';

function readBody(req, maxBytes = 200000) {
  return new Promise((resolve, reject) => {
    let data = '';
    let len = 0;
    req.on('data', (chunk) => {
      len += chunk.length;
      if (len > maxBytes) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function apiPredict(req, res) {
  if (!ANTHROPIC_API_KEY) {
    sendJSON(res, 200, { error: 'ANTHROPIC_API_KEY is not configured on this server.' });
    return;
  }
  try {
    const bodyText = await readBody(req);
    const snapshot = JSON.parse(bodyText || '{}');
    if (!snapshot.symbol) {
      sendJSON(res, 400, { error: 'missing symbol in request body' });
      return;
    }
    const sys =
      'You are a crypto futures technical-analysis assistant embedded in a live trading dashboard. ' +
      'You are given a structured JSON snapshot of real technical indicators and agent scores for one ' +
      'perpetual futures contract. Write a short (3-5 sentence), plain-English read of the situation and ' +
      'a probable near-term direction. This is informational decision-support only, never an instruction ' +
      'to trade, and you must never claim certainty. Respond with ONLY a JSON object of the exact shape ' +
      '{"prediction": string, "direction": "LONG"|"SHORT"|"HOLD", "confidence": number between 0 and 100}.';
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 25000);
    let resp;
    try {
      resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: ctl.signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: ANTHROPIC_MODEL,
          max_tokens: 400,
          system: sys,
          messages: [{ role: 'user', content: 'Snapshot:\n' + JSON.stringify(snapshot, null, 2) }],
        }),
      });
    } finally {
      clearTimeout(t);
    }
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      sendJSON(res, 200, { error: 'Anthropic API HTTP ' + resp.status + (errText ? ': ' + errText.slice(0, 200) : '') });
      return;
    }
    const data = await resp.json();
    const text = (data.content || []).map((b) => b.text || '').join('');
    let parsed;
    try {
      const m = text.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(m ? m[0] : text);
    } catch (e) {
      parsed = { prediction: text.slice(0, 800), direction: 'HOLD', confidence: null };
    }
    sendJSON(res, 200, parsed);
  } catch (err) {
    sendJSON(res, 200, { error: err.message });
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
    if (req.url === '/api/predict' && req.method === 'POST') return apiPredict(req, res);

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
