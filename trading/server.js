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
// GET /api/stocks feeds the STOCKS tab: ~18 global index quotes with no
// paid API key anywhere. Each index tries, in order, whichever of these
// apply to it: (1) Yahoo Finance's unofficial chart endpoint — current
// price plus ~1 month of daily closes in one call, known to be fragile
// and unannounced-rate-limited, never trusted blindly; (2) Stooq's public
// CSV quote endpoint — a second independent keyless source, price only;
// (3) for Colombo only, CSE's own undocumented-but-real json API
// (cse.lk/api/aspiData, /api/snpData — publicly reverse-engineered, POST,
// no key), parsed defensively since its response shape was never
// published. Whichever source answers is reported honestly per index
// (source: 'yahoo'|'stooq'|'cse'|'unavailable') — nothing is ever
// synthesized. Indices whose live source gives no history (Stooq
// fallback, CSE) grow their own small in-memory rolling history over the
// life of the running process instead.
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

// ---------------------------------------------------------------------
// GET /api/stocks — global index snapshot for the STOCKS tab
// ---------------------------------------------------------------------
const STOCK_INDICES = [
  { id: 'spx',   name: 'S&P 500',            region: 'Americas',    yahoo: '^GSPC',      stooq: '^spx'   },
  { id: 'ndq',   name: 'Nasdaq Composite',   region: 'Americas',    yahoo: '^IXIC',      stooq: '^ndq'   },
  { id: 'dji',   name: 'Dow Jones (NYSE)',   region: 'Americas',    yahoo: '^DJI',       stooq: '^dji'   },
  { id: 'tsx',   name: 'TSX Composite',      region: 'Americas',    yahoo: '^GSPTSE',    stooq: '^tsx'   },
  { id: 'bvsp',  name: 'Bovespa',            region: 'Americas',    yahoo: '^BVSP',      stooq: '^bvsp'  },
  { id: 'ftse',  name: 'FTSE 100',           region: 'Europe',      yahoo: '^FTSE',      stooq: '^ftse'  },
  { id: 'dax',   name: 'DAX',                region: 'Europe',      yahoo: '^GDAXI',     stooq: '^dax'   },
  { id: 'cac',   name: 'CAC 40',             region: 'Europe',      yahoo: '^FCHI',      stooq: '^cac'   },
  { id: 'stoxx', name: 'Euro Stoxx 50',      region: 'Europe',      yahoo: '^STOXX50E',  stooq: '^sx5e'  },
  { id: 'nse',   name: 'Nifty 50 (NSE)',     region: 'South Asia',  yahoo: '^NSEI',      stooq: '^nsei'  },
  { id: 'bse',   name: 'Sensex (BSE)',       region: 'South Asia',  yahoo: '^BSESN',     stooq: '^bsesn' },
  { id: 'cse',   name: 'ASPI (Colombo)',     region: 'South Asia',  cse: 'aspiData' },
  { id: 'cse20', name: 'S&P SL20 (Colombo)', region: 'South Asia',  cse: 'snpData' },
  { id: 'n225',  name: 'Nikkei 225',         region: 'Asia-Pacific',yahoo: '^N225',      stooq: '^nkx'   },
  { id: 'hsi',   name: 'Hang Seng',          region: 'Asia-Pacific',yahoo: '^HSI',       stooq: '^hsi'   },
  { id: 'sse',   name: 'Shanghai Composite', region: 'Asia-Pacific',yahoo: '000001.SS',  stooq: '^shc'   },
  { id: 'kospi', name: 'KOSPI',              region: 'Asia-Pacific',yahoo: '^KS11',      stooq: '^kospi' },
  { id: 'asx',   name: 'ASX 200',            region: 'Asia-Pacific',yahoo: '^AXJO',      stooq: '^asx'   },
];
const STOCK_CACHE_MS = 3 * 60 * 1000;
let stockCache = { data: null, fetchedAt: 0 };
const stockHistory = {};

function pushHistory(id, t, c) {
  if (c == null || !isFinite(c)) return;
  const h = (stockHistory[id] = stockHistory[id] || []);
  const last = h[h.length - 1];
  if (last && t - last.t < 60 * 1000) return;
  h.push({ t, c });
  if (h.length > 300) h.shift();
}

async function fetchYahoo(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1mo&interval=1d`;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 9000);
  try {
    const r = await fetch(url, {
      signal: ctl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        Accept: 'application/json',
      },
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const chartRes = j.chart && j.chart.result && j.chart.result[0];
    if (!chartRes) throw new Error((j.chart && j.chart.error && j.chart.error.description) || 'no chart result');
    const meta = chartRes.meta || {};
    const price = meta.regularMarketPrice;
    const prevClose = meta.chartPreviousClose != null ? meta.chartPreviousClose : meta.previousClose;
    if (price == null) throw new Error('no regularMarketPrice in response');
    const closes = (chartRes.indicators && chartRes.indicators.quote && chartRes.indicators.quote[0] && chartRes.indicators.quote[0].close) || [];
    const stamps = chartRes.timestamp || [];
    const history = stamps.map((ts, i) => ({ t: ts * 1000, c: closes[i] })).filter((p) => p.c != null);
    const change = prevClose != null ? price - prevClose : null;
    const changePct = prevClose ? (change / prevClose) * 100 : null;
    return { price, change, changePct, history, source: 'yahoo' };
  } finally {
    clearTimeout(t);
  }
}

async function fetchStooq(symbol) {
  const url = `https://stooq.com/q/l/?s=${encodeURIComponent(symbol)}&f=sd2t2ohlc&h&e=csv`;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 9000);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const text = await r.text();
    const lines = text.trim().split('\n');
    if (lines.length < 2) throw new Error('no data row');
    const cols = lines[1].split(',');
    const close = parseFloat(cols[6]);
    const open = parseFloat(cols[3]);
    if (!isFinite(close) || close <= 0) throw new Error('bad/empty quote: ' + text.slice(0, 80));
    const change = isFinite(open) ? close - open : null;
    const changePct = isFinite(open) && open ? (change / open) * 100 : null;
    return { price: close, change, changePct, history: [], source: 'stooq' };
  } finally {
    clearTimeout(t);
  }
}

// CSE's aspiData/snpData response shape was never published anywhere found
// during research, so this walks the JSON tree looking for plausible
// value/change fields by key name rather than assuming a fixed schema.
function extractCse(json) {
  let value = null, change = null, changePct = null;
  const seen = new Set();
  (function walk(o) {
    if (!o || typeof o !== 'object' || seen.has(o)) return;
    seen.add(o);
    for (const [k, v] of Object.entries(o)) {
      const key = k.toLowerCase();
      if (typeof v === 'number') {
        if (value == null && /(value|index|close|point|aspi|snp)/.test(key) && !/percent|pct/.test(key)) value = v;
        if (change == null && /change/.test(key) && !/percent|pct/.test(key)) change = v;
        if (changePct == null && /(percent|pct)/.test(key)) changePct = v;
      } else if (typeof v === 'object') {
        walk(v);
      }
    }
  })(json);
  return { value, change, changePct };
}

async function fetchCse(endpoint) {
  const url = `https://www.cse.lk/api/${endpoint}`;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 9000);
  try {
    const r = await fetch(url, {
      method: 'POST',
      signal: ctl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: 'https://www.cse.lk',
        Referer: 'https://www.cse.lk/',
      },
      body: '',
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const json = await r.json();
    const { value, change, changePct } = extractCse(json);
    if (value == null) throw new Error('could not locate an index value in the CSE response');
    return { price: value, change, changePct, history: [], source: 'cse' };
  } finally {
    clearTimeout(t);
  }
}

async function fetchOneIndex(def) {
  const attempts = [];
  if (def.cse) attempts.push(() => fetchCse(def.cse));
  if (def.yahoo) attempts.push(() => fetchYahoo(def.yahoo));
  if (def.stooq) attempts.push(() => fetchStooq(def.stooq));
  let lastErr = null;
  for (const attempt of attempts) {
    try {
      const r = await attempt();
      pushHistory(def.id, Date.now(), r.price);
      if (!r.history || !r.history.length) r.history = stockHistory[def.id] || [];
      return { id: def.id, name: def.name, region: def.region, ...r, error: null };
    } catch (e) {
      lastErr = e;
    }
  }
  return {
    id: def.id, name: def.name, region: def.region, price: null, change: null, changePct: null,
    history: stockHistory[def.id] || [], source: 'unavailable', error: lastErr ? lastErr.message : 'no source configured',
  };
}

async function refreshStockCache() {
  const results = await Promise.allSettled(STOCK_INDICES.map(fetchOneIndex));
  const indices = {};
  results.forEach((r, i) => {
    const def = STOCK_INDICES[i];
    indices[def.id] = r.status === 'fulfilled'
      ? r.value
      : { id: def.id, name: def.name, region: def.region, price: null, source: 'unavailable', error: r.reason && r.reason.message };
  });
  stockCache = { data: indices, fetchedAt: Date.now() };
  return indices;
}

async function apiStocks(req, res) {
  try {
    const stale = !stockCache.data || Date.now() - stockCache.fetchedAt > STOCK_CACHE_MS;
    if (stale) await refreshStockCache().catch(() => {});
    if (!stockCache.data) {
      sendJSON(res, 200, { indices: {}, error: 'stock data unavailable' });
      return;
    }
    sendJSON(res, 200, { indices: stockCache.data, fetchedAt: stockCache.fetchedAt });
  } catch (err) {
    sendJSON(res, 200, { indices: {}, error: err.message });
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
    if (req.url === '/api/stocks') return apiStocks(req, res);
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
