// Quant Nexus — Zinerge Quant Nexus v1.3 sci-fi trading terminal.
// Fully self-contained client-side engine (index.html does its own Binance
// fetch/WebSocket + technical-indicator scoring in the browser). This server
// serves that one HTML file, proxies small read-only data calls that
// index.html prefers to fetch same-origin (so macro/news/ETF data stays
// reliable even if a browser's own cross-origin fetch is ever blocked or
// rate-limited), and exposes one on-demand AI endpoint: POST /api/predict,
// which calls the real Anthropic Messages API (ANTHROPIC_API_KEY /
// ANTHROPIC_MODEL env vars) for a short written read on one coin's
// technical snapshot. That call only happens when a user clicks "Ask
// Claude" in the drawer — it is not in any polling loop.
//
// GET /api/etf scrapes Farside Investors' public BTC/ETH/SOL spot-ETF daily
// flow tables (farside.co.uk — no API key, no auth) server-side with a
// zero-dependency regex HTML parser, and caches the result for a few hours
// since Farside only republishes once per US trading day, not intraday.
//
// Every other signal on this page — the 8 original agent votes, the
// Technical Rating Engine (Stoch RSI, ADX, Ichimoku, VWAP, OBV, pivots),
// the default "statistical prediction" panel, the volume/liquidity-gap
// profile, and the whale-trade table — stays deterministic, computed
// client-side from real Binance data, not LLM-generated.
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

// ---------------------------------------------------------------------
// GET /api/etf — Farside spot-ETF daily flow scraper (BTC / ETH / SOL)
// ---------------------------------------------------------------------
const FARSIDE_URLS = {
  BTC: 'https://farside.co.uk/btc/',
  ETH: 'https://farside.co.uk/eth/',
  SOL: 'https://farside.co.uk/sol/',
};
const ETF_CACHE_MS = 3 * 60 * 60 * 1000; // Farside republishes once per US trading day; no need to hammer it.
let etfCache = { data: null, fetchedAt: 0 };

// Farside's table markup (confirmed by hand 2026-11-08): a single
// <table class="etf">. Row 0 is a mostly-blank header with "Total" in the
// last cell; row 1 holds the fund tickers (e.g. IBIT, FBTC, ... BTC); a
// "Fee" row (and, on the ETH page, a "Staking fee" + "Seed" row) follow;
// then one <tr> per trading day whose first cell is a "DD Mon YYYY" date;
// the table ends with Total/Average/Maximum/Minimum summary rows. Values
// are US$ millions, formatted like "123.4" (positive), "(123.4)"
// (negative/outflow), "0.0", or "-" (no data that day); summary rows may
// use thousands separators. This is a plain regex parser (no cheerio —
// zero npm dependencies, same convention as the rest of this file).
function parseFarsideTable(html) {
  const tableMatch = html.match(/<table[^>]*class="etf"[^>]*>([\s\S]*?)<\/table>/i);
  if (!tableMatch) throw new Error('etf table not found in page');
  const rowMatches = [...tableMatch[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
  const rows = rowMatches
    .map((m) => [...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) =>
      c[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').trim()
    ))
    .filter((r) => r.length > 0);

  const tickerRow = rows.find((r) => r.filter((t) => /^[A-Z]{2,6}$/.test(t)).length >= 3);
  if (!tickerRow) throw new Error('fund ticker row not found');
  const funds = tickerRow.slice(1, -1).filter(Boolean);

  const parseFlow = (text) => {
    if (text == null || text === '' || text === '-') return null;
    let t = text.replace(/,/g, '');
    const neg = /^\(.*\)$/.test(t);
    t = t.replace(/[()]/g, '');
    const num = parseFloat(t);
    return isFinite(num) ? (neg ? -num : num) : null;
  };

  const dateRows = rows.filter((r) => /^\d{2} \w{3} \d{4}$/.test(r[0]));
  const history = dateRows.map((r) => ({
    date: r[0],
    perFund: r.slice(1, -1).map(parseFlow),
    total: parseFlow(r[r.length - 1]),
  }));
  if (!history.length) throw new Error('no dated flow rows found');
  const latest = history[history.length - 1];

  return {
    date: latest.date,
    net: latest.total,
    funds,
    perFund: latest.perFund,
    history: history.slice(-20).map((h) => ({ date: h.date, total: h.total })),
  };
}

async function fetchFarside(coin, url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(url, {
      signal: ctl.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
      },
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const html = await r.text();
    return parseFarsideTable(html);
  } finally {
    clearTimeout(t);
  }
}

async function refreshEtfCache() {
  const entries = await Promise.allSettled(
    Object.entries(FARSIDE_URLS).map(async ([coin, url]) => [coin, await fetchFarside(coin, url)])
  );
  const data = {};
  const errors = {};
  entries.forEach((r, i) => {
    const coin = Object.keys(FARSIDE_URLS)[i];
    if (r.status === 'fulfilled') data[coin] = r.value[1];
    else errors[coin] = r.reason && r.reason.message;
  });
  if (Object.keys(data).length) {
    etfCache = { data: { ...data, errors }, fetchedAt: Date.now() };
  }
  return etfCache.data;
}

async function apiEtf(req, res) {
  try {
    const stale = !etfCache.data || Date.now() - etfCache.fetchedAt > ETF_CACHE_MS;
    if (stale) await refreshEtfCache().catch(() => {});
    if (!etfCache.data) {
      sendJSON(res, 200, { error: 'ETF data unavailable (Farside fetch failed and no cache yet).', source: 'https://farside.co.uk' });
      return;
    }
    sendJSON(res, 200, { ...etfCache.data, source: 'https://farside.co.uk', fetchedAt: etfCache.fetchedAt });
  } catch (err) {
    sendJSON(res, 200, { error: err.message });
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
    if (req.url === '/api/etf') return apiEtf(req, res);
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
