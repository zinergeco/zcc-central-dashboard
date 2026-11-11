// Quant Nexus — Zinerge Quant Nexus v1.6 sci-fi trading terminal.
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
// GET /api/news aggregates a handful of public, keyless crypto-media RSS
// feeds (CoinDesk, Cointelegraph, Decrypt, The Block, CryptoSlate) plus a
// best-effort CryptoCompare/CCData call, merges and de-dupes the results,
// and reshapes them into the same {items, status} JSON the frontend has
// always consumed. CryptoCompare/CCData locked free access behind a
// required API key around May 2026 (see project doc), so it is kept only
// as a bonus source that silently contributes nothing until a key is
// configured — the RSS feeds are the real data path now and need no key.
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
//
// v1.6 adds the signal journal the model-improvement review asked for —
// "the biggest gap" was that every call vanished with no record of what
// happened next. POST /api/journal takes a batch of co.sig snapshots from
// the browser and inserts them into Supabase (qnx_signal_journal); a
// background loop resolves each row ~24h later by replaying real Binance
// 15m candles since signal time to find which of TP1/TP2/TP3/SL was hit
// first (a plain triple-barrier walk) plus MFE/MAE and price snapshots at
// +1h/+4h/+24h. GET /api/journal/stats aggregates the resolved rows into
// a per-agent directional-accuracy scorecard (did each agent's vote sign
// match the coin's actual 24h return, independent of what the Chief
// decided) plus an overall win rate and Brier score against each
// signal's own stated confidence — all sample-size-gated so the Model
// Lab tab says "collecting data" honestly instead of overclaiming on a
// handful of rows. This is observation, not the learned meta-model the
// review describes next — reweighting agents needs months of this data
// first, so that stays out of scope for v1.6.
//
// GET /api/intel adds the free/keyless macro + options + stablecoin
// reads the review flagged as high-value: Coinbase-vs-Binance mark
// premium, Deribit DVOL and put/call open-interest ratio (BTC/ETH), total
// stablecoin supply (DefiLlama), a USD-strength proxy (Frankfurter FX,
// since Stooq has no reachable DXY/10Y ticker from here), and the real
// US Treasury 2Y/10Y par yield curve. GET /api/calendar best-effort
// proxies ForexFactory's weekly high-impact economic calendar the same
// way /api/etf proxies Farside — if it fails, the UI just shows
// "unavailable", same graceful-degradation convention as everything else
// in this file. Deliberately deferred to a later version: Coinglass /
// Glassnode / CryptoQuant / Santiment (all paid), and moving the agent
// scoring itself server-side (the review's own suggestion, but a much
// larger rearchitecture than the data the journal needs to be useful).
// See the project doc for the full architecture history.

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const FAPI = 'https://fapi.binance.com';
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function clampN(v, a, b) { return Math.max(a, Math.min(b, v)); }

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

// ---------------------------------------------------------------------
// GET /api/news — keyless multi-source RSS newswire (+ bonus CryptoCompare)
// ---------------------------------------------------------------------
// CryptoCompare/CCData closed free, unauthenticated access to its news API
// around May 2026 (confirmed: HTTP 401 "rate limit exceeded" with no key
// configured). Rather than depend on any single source — keyed or not —
// this pulls from several independent, keyless, public crypto-media RSS
// feeds in parallel, merges + de-dupes by URL, sorts newest-first, and
// reports per-source status so the UI can show exactly what's live. Zero
// npm dependencies: a small regex/CDATA RSS parser, same convention as
// the rest of this file (see parseFarsideTable above for the same style
// applied to HTML instead of XML).
const NEWS_RSS_FEEDS = [
  { id: 'coindesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' },
  { id: 'cointelegraph', url: 'https://cointelegraph.com/rss' },
  { id: 'decrypt', url: 'https://decrypt.co/feed' },
  { id: 'theblock', url: 'https://www.theblock.co/rss.xml' },
  { id: 'cryptoslate', url: 'https://cryptoslate.com/feed/' },
];
const NEWS_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

function decodeXmlEntities(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function stripHtmlTags(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function xmlTag(block, tag) {
  const m = block.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>', 'i'));
  return m ? decodeXmlEntities(m[1]).trim() : '';
}

function parseRssItems(xml, srcName) {
  const blocks = [...xml.matchAll(/<item[^>]*>([\s\S]*?)<\/item>/gi)].map((m) => m[1]);
  return blocks
    .map((block) => {
      const title = xmlTag(block, 'title');
      const link = xmlTag(block, 'link') || xmlTag(block, 'guid');
      const pubDate = xmlTag(block, 'pubDate');
      const descRaw = xmlTag(block, 'description') || xmlTag(block, 'content:encoded');
      const parsed = pubDate ? Date.parse(pubDate) : NaN;
      return {
        title,
        url: link,
        src: srcName,
        t: isFinite(parsed) ? parsed : Date.now(),
        body: stripHtmlTags(descRaw).slice(0, 500),
      };
    })
    .filter((it) => it.title && it.url);
}

async function fetchRssFeed(feed) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 12000);
  try {
    const r = await fetch(feed.url, {
      signal: ctl.signal,
      headers: { 'User-Agent': NEWS_UA, Accept: 'application/rss+xml, application/xml, text/xml, */*' },
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const xml = await r.text();
    const items = parseRssItems(xml, feed.id);
    if (!items.length) throw new Error('no items parsed');
    return items;
  } finally {
    clearTimeout(t);
  }
}

async function fetchCryptoCompareNews() {
  const n = await getJSON('https://min-api.cryptocompare.com/data/v2/news/?lang=EN', 10000);
  if (!Array.isArray(n.Data)) throw new Error(n.Message || 'no data');
  return n.Data.slice(0, 40).map((x) => ({
    title: x.title,
    url: x.url,
    src: 'cryptocompare',
    t: x.published_on * 1000,
    body: x.body || '',
  }));
}

async function apiNews(req, res) {
  const sources = [
    ...NEWS_RSS_FEEDS.map((feed) => ({ id: feed.id, run: () => fetchRssFeed(feed) })),
    { id: 'cryptocompare', run: fetchCryptoCompareNews },
  ];
  const results = await Promise.allSettled(sources.map((s) => s.run()));

  const status = {};
  let items = [];
  results.forEach((r, i) => {
    const id = sources[i].id;
    if (r.status === 'fulfilled') {
      status[id] = 'ok (' + r.value.length + ')';
      items = items.concat(r.value);
    } else {
      status[id] = 'error: ' + (r.reason && r.reason.message);
    }
  });

  const seen = new Set();
  items = items
    .sort((a, b) => b.t - a.t)
    .filter((it) => {
      const key = it.url || it.title;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 80);

  sendJSON(res, 200, { items, status });
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
  { id: 'spx', name: 'S&P 500', region: 'Americas', yahoo: '^GSPC', stooq: '^spx' },
  { id: 'ndq', name: 'Nasdaq Composite', region: 'Americas', yahoo: '^IXIC', stooq: '^ndq' },
  { id: 'dji', name: 'Dow Jones (NYSE)', region: 'Americas', yahoo: '^DJI', stooq: '^dji' },
  { id: 'tsx', name: 'TSX Composite', region: 'Americas', yahoo: '^GSPTSE', stooq: '^tsx' },
  { id: 'bvsp', name: 'Bovespa', region: 'Americas', yahoo: '^BVSP', stooq: '^bvsp' },
  { id: 'ftse', name: 'FTSE 100', region: 'Europe', yahoo: '^FTSE', stooq: '^ftse' },
  { id: 'dax', name: 'DAX', region: 'Europe', yahoo: '^GDAXI', stooq: '^dax' },
  { id: 'cac', name: 'CAC 40', region: 'Europe', yahoo: '^FCHI', stooq: '^cac' },
  { id: 'stoxx', name: 'Euro Stoxx 50', region: 'Europe', yahoo: '^STOXX50E', stooq: '^sx5e' },
  { id: 'nse', name: 'Nifty 50 (NSE)', region: 'South Asia', yahoo: '^NSEI', stooq: '^nsei' },
  { id: 'bse', name: 'Sensex (BSE)', region: 'South Asia', yahoo: '^BSESN', stooq: '^bsesn' },
  { id: 'cse', name: 'ASPI (Colombo)', region: 'South Asia', cse: 'aspiData' },
  { id: 'cse20', name: 'S&P SL20 (Colombo)', region: 'South Asia', cse: 'snpData' },
  { id: 'n225', name: 'Nikkei 225', region: 'Asia-Pacific', yahoo: '^N225', stooq: '^nkx' },
  { id: 'hsi', name: 'Hang Seng', region: 'Asia-Pacific', yahoo: '^HSI', stooq: '^hsi' },
  { id: 'sse', name: 'Shanghai Composite', region: 'Asia-Pacific', yahoo: '000001.SS', stooq: '^shc' },
  { id: 'kospi', name: 'KOSPI', region: 'Asia-Pacific', yahoo: '^KS11', stooq: '^kospi' },
  { id: 'asx', name: 'ASX 200', region: 'Asia-Pacific', yahoo: '^AXJO', stooq: '^asx' },
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

// ---------------------------------------------------------------------
// Supabase REST helpers — used only by the signal journal below. Reuses
// whatever SUPABASE_URL / SUPABASE_SECRET_KEY are already configured on
// this Coolify app (the service-role key never reaches the browser; all
// journal writes/reads happen server-side).
// ---------------------------------------------------------------------
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || '';
function supabaseConfigured() {
  return !!(SUPABASE_URL && SUPABASE_SECRET_KEY);
}
async function supabaseRequest(method, pathAndQuery, body, extraHeaders) {
  if (!supabaseConfigured()) throw new Error('Supabase is not configured on this server');
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
      method,
      signal: ctl.signal,
      headers: {
        apikey: SUPABASE_SECRET_KEY,
        Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
        'Content-Type': 'application/json',
        ...(extraHeaders || {}),
      },
      body: body != null ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (e) {
      /* non-JSON response body (e.g. empty 204) — leave json null */
    }
    if (!r.ok) {
      const detail = (json && (json.message || json.hint)) || text.slice(0, 200);
      throw new Error(`Supabase HTTP ${r.status}${detail ? ': ' + detail : ''}`);
    }
    return json;
  } finally {
    clearTimeout(t);
  }
}
const supabaseInsert = (table, rows) =>
  supabaseRequest('POST', table, rows, { Prefer: 'return=minimal' });
const supabaseSelect = (table, qs) => supabaseRequest('GET', `${table}?${qs}`);
const supabasePatch = (table, qs, patch) =>
  supabaseRequest('PATCH', `${table}?${qs}`, patch, { Prefer: 'return=minimal' });

// ---------------------------------------------------------------------
// POST /api/journal — signal journal ingest
// ---------------------------------------------------------------------
// The browser already computes everything in co.sig every cycle (side,
// score, conf, per-agent votes, the full trade plan) — this just persists
// a sanitised snapshot of it so outcomes can be checked later. Nothing is
// recomputed server-side.
const JOURNAL_SIDES = new Set(['LONG', 'SHORT', 'HOLD']);
function sanitizeJournalRow(s) {
  if (!s || typeof s !== 'object') return null;
  const symbol = typeof s.symbol === 'string' ? s.symbol.slice(0, 20) : null;
  const side = JOURNAL_SIDES.has(s.side) ? s.side : null;
  if (!symbol || !side) return null;
  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
  return {
    symbol,
    side,
    score: num(s.score),
    conf: num(s.conf),
    votes: s.votes && typeof s.votes === 'object' ? s.votes : null,
    entry: num(s.entry),
    sl: num(s.sl),
    tp1: num(s.tp1),
    tp2: num(s.tp2),
    tp3: num(s.tp3),
    leverage: num(s.leverage),
    tier: Number.isInteger(s.tier) ? s.tier : null,
    margin: num(s.margin),
    risk_amt: num(s.riskAmt),
  };
}
async function apiJournalPost(req, res) {
  if (!supabaseConfigured()) {
    sendJSON(res, 200, { error: 'journal not configured on this server (no Supabase env vars)', inserted: 0 });
    return;
  }
  try {
    const bodyText = await readBody(req, 500000);
    const body = JSON.parse(bodyText || '{}');
    const list = Array.isArray(body.signals) ? body.signals : [];
    const rows = list.map(sanitizeJournalRow).filter(Boolean);
    if (!rows.length) {
      sendJSON(res, 200, { inserted: 0 });
      return;
    }
    await supabaseInsert('qnx_signal_journal', rows);
    sendJSON(res, 200, { inserted: rows.length });
  } catch (err) {
    sendJSON(res, 200, { error: err.message, inserted: 0 });
  }
}

// ---------------------------------------------------------------------
// GET /api/journal/stats — per-agent scorecard + calibration
// ---------------------------------------------------------------------
// Per-agent accuracy is deliberately independent of the Chief's final
// LONG/SHORT/HOLD call: for each resolved trade it checks whether that
// one agent's vote sign matched the coin's actual 24h directional return.
// That isolates which specialist agents are actually adding signal from
// which ones the Chief currently out-votes. Calibration is a Brier score
// of each signal's own stated confidence against whether it won (TP hit)
// or lost (SL hit) — 0 is perfect, 0.25 is what a coin flip at 50/50
// scores. Everything is sample-size-gated in the response so the Model
// Lab tab can say "collecting data" honestly below a useful threshold.
const AGENT_VOTE_KEYS = ['market', 'deriv', 'macro', 'quant', 'news', 'tech'];
async function computeJournalStats() {
  const rows = await supabaseSelect(
    'qnx_signal_journal',
    'resolved=eq.true&order=ts.desc&limit=2000&select=symbol,side,score,conf,votes,entry,price_24h,outcome,pnl_pct,ts'
  );
  const resolved = Array.isArray(rows) ? rows : [];
  const tradeRows = resolved.filter((r) => r.side !== 'HOLD' && r.entry != null);

  const agentAcc = {};
  AGENT_VOTE_KEYS.forEach((k) => (agentAcc[k] = { correct: 0, total: 0 }));
  let brierSum = 0,
    brierN = 0,
    wins = 0,
    outcomesSeen = 0,
    pnlSum = 0,
    pnlN = 0;
  const bySide = { LONG: { count: 0, wins: 0 }, SHORT: { count: 0, wins: 0 } };

  tradeRows.forEach((r) => {
    const ret = r.price_24h != null && r.entry ? (r.price_24h - r.entry) / r.entry : null;
    if (ret != null && r.votes && typeof r.votes === 'object') {
      AGENT_VOTE_KEYS.forEach((k) => {
        const v = r.votes[k];
        if (typeof v === 'number' && Math.abs(v) > 0.05) {
          agentAcc[k].total++;
          if (Math.sign(v) === Math.sign(ret)) agentAcc[k].correct++;
        }
      });
    }
    if (r.outcome) {
      outcomesSeen++;
      const isWin = typeof r.outcome === 'string' && r.outcome.indexOf('TP') === 0;
      if (isWin) wins++;
      if (r.conf != null) {
        const p = clampN(r.conf / 100, 0, 1);
        brierSum += (p - (isWin ? 1 : 0)) ** 2;
        brierN++;
      }
      if (bySide[r.side]) {
        bySide[r.side].count++;
        if (isWin) bySide[r.side].wins++;
      }
    }
    if (typeof r.pnl_pct === 'number' && isFinite(r.pnl_pct)) {
      pnlSum += r.pnl_pct;
      pnlN++;
    }
  });

  const agents = {};
  AGENT_VOTE_KEYS.forEach((k) => {
    const a = agentAcc[k];
    agents[k] = { accuracy: a.total ? a.correct / a.total : null, sample: a.total };
  });

  return {
    totalResolved: resolved.length,
    resolvedTrades: tradeRows.length,
    overall: {
      winRate: outcomesSeen ? wins / outcomesSeen : null,
      avgPnlPct: pnlN ? pnlSum / pnlN : null,
      brier: brierN ? brierSum / brierN : null,
      sample: outcomesSeen,
    },
    agents,
    bySide: {
      LONG: { count: bySide.LONG.count, winRate: bySide.LONG.count ? bySide.LONG.wins / bySide.LONG.count : null },
      SHORT: { count: bySide.SHORT.count, winRate: bySide.SHORT.count ? bySide.SHORT.wins / bySide.SHORT.count : null },
    },
    recent: tradeRows.slice(0, 20).map((r) => ({ symbol: r.symbol, side: r.side, outcome: r.outcome, pnlPct: r.pnl_pct, ts: r.ts })),
  };
}
const STATS_CACHE_MS = 5 * 60 * 1000;
let statsCache = { data: null, fetchedAt: 0 };
async function apiJournalStats(req, res) {
  if (!supabaseConfigured()) {
    sendJSON(res, 200, { error: 'journal not configured on this server (no Supabase env vars)' });
    return;
  }
  try {
    const stale = !statsCache.data || Date.now() - statsCache.fetchedAt > STATS_CACHE_MS;
    if (stale) statsCache = { data: await computeJournalStats(), fetchedAt: Date.now() };
    sendJSON(res, 200, { ...statsCache.data, fetchedAt: statsCache.fetchedAt });
  } catch (err) {
    sendJSON(res, 200, { error: err.message });
  }
}

// ---------------------------------------------------------------------
// Outcome resolution — a background loop, not a request handler. Every
// 15 minutes it looks for journal rows at least 24h old that are still
// unresolved, replays real Binance 15m candles across that 24h window
// per symbol, and records which of TP1/TP2/TP3/SL was touched first (a
// plain triple-barrier walk), MFE/MAE, and price snapshots at +1h/+4h/
// +24h. HOLD rows just get their price snapshots (no TP/SL to check).
// A row stuck failing (e.g. a delisted symbol) for over a week is closed
// out with a null outcome instead of blocking the queue forever.
// ---------------------------------------------------------------------
const JOURNAL_SYMBOL_OVERRIDES = { PEPE: '1000PEPE' };
function journalFuturesSymbol(coin) {
  return (JOURNAL_SYMBOL_OVERRIDES[coin] || coin) + 'USDT';
}
async function fetchKlineWindow(symbol, startTime, endTime) {
  return getJSON(`${FAPI}/fapi/v1/klines?symbol=${symbol}&interval=15m&startTime=${startTime}&endTime=${endTime}&limit=1000`, 15000);
}
// Models the dashboard's own stated exit plan (see buildPlan()/renderDrawer()
// in index.html): TP1/TP2/TP3 close 40%/35%/25% of the position in turn, and
// the stop moves to breakeven (entry) the moment TP1 fills. So after TP1,
// "SL" no longer means the original stop — it means price round-tripped back
// to entry, which the plan explicitly arms. pnl_pct is the size-weighted
// blend of whatever tranches actually closed, not a single assumed exit.
const TRANCHE = { 1: 0.4, 2: 0.35, 3: 0.25 };
function walkTripleBarrier(row, bars) {
  const L = row.side === 'LONG';
  let stage = 0; // 0 = before TP1, 1 = TP1 done, 2 = TP2 done, 3 = TP3 done (fully closed)
  let remaining = 1,
    pnlAccum = 0,
    mfe = -Infinity,
    mae = Infinity,
    stoppedEarly = false,
    lastClose = bars[bars.length - 1].c;
  const targets = { 0: row.tp1, 1: row.tp2, 2: row.tp3 };
  for (const b of bars) {
    const favorable = L ? b.h : b.l;
    const adverse = L ? b.l : b.h;
    const favPct = L ? (favorable - row.entry) / row.entry : (row.entry - favorable) / row.entry;
    const advPct = L ? (adverse - row.entry) / row.entry : (row.entry - adverse) / row.entry;
    if (favPct > mfe) mfe = favPct;
    if (advPct < mae) mae = advPct;
    if (remaining <= 0) continue; // fully closed already, just keep tracking mfe/mae for the record
    const stopLevel = stage === 0 ? row.sl : row.entry; // breakeven once any TP has filled
    const target = targets[stage];
    const stopHit = stopLevel != null && (L ? b.l <= stopLevel : b.h >= stopLevel);
    const targetHit = target != null && (L ? b.h >= target : b.l <= target);
    if (stopHit && targetHit) {
      // ambiguous same-bar order — conservative: the stop is assumed to trigger first
      const ret = L ? (stopLevel - row.entry) / row.entry : (row.entry - stopLevel) / row.entry;
      pnlAccum += remaining * ret;
      remaining = 0;
      stoppedEarly = true;
    } else if (stopHit) {
      const ret = L ? (stopLevel - row.entry) / row.entry : (row.entry - stopLevel) / row.entry;
      pnlAccum += remaining * ret;
      remaining = 0;
      stoppedEarly = true;
    } else if (targetHit) {
      const tranche = TRANCHE[stage + 1];
      const ret = L ? (target - row.entry) / row.entry : (row.entry - target) / row.entry;
      pnlAccum += tranche * ret;
      remaining -= tranche;
      stage++;
    }
  }
  if (remaining > 0) {
    // 24h window closed with some tranche still open — mark the rest at the last close.
    const ret = L ? (lastClose - row.entry) / row.entry : (row.entry - lastClose) / row.entry;
    pnlAccum += remaining * ret;
  }
  const outcome = stage === 0 ? (stoppedEarly ? 'SL' : 'TIMEOUT') : stage >= 3 ? 'TP3' : 'TP' + stage;
  return { outcome, pnl_pct: pnlAccum * 100, mfe_pct: isFinite(mfe) ? mfe * 100 : null, mae_pct: isFinite(mae) ? mae * 100 : null };
}
async function resolveJournalRow(row) {
  const entryTs = new Date(row.ts).getTime();
  const sym = journalFuturesSymbol(row.symbol);
  const endTs = Math.min(Date.now(), entryTs + RESOLVE_AGE_MS);
  const kl = await fetchKlineWindow(sym, entryTs, endTs);
  if (!Array.isArray(kl) || !kl.length) throw new Error('no kline data for ' + sym);
  const bars = kl.map((r) => ({ t: r[0], h: +r[2], l: +r[3], c: +r[4] }));
  const priceAt = (ms) => {
    let best = null;
    for (const b of bars) {
      if (b.t <= entryTs + ms) best = b;
      else break;
    }
    return best ? best.c : bars[bars.length - 1].c;
  };
  const price_1h = priceAt(60 * 60 * 1000);
  const price_4h = priceAt(4 * 60 * 60 * 1000);
  const price_24h = bars[bars.length - 1].c;
  let outcome = null,
    mfe_pct = null,
    mae_pct = null,
    pnl_pct = null;
  if (row.side !== 'HOLD' && row.entry != null) {
    const r = walkTripleBarrier(row, bars);
    outcome = r.outcome;
    pnl_pct = r.pnl_pct;
    mfe_pct = r.mfe_pct;
    mae_pct = r.mae_pct;
  }
  await supabasePatch('qnx_signal_journal', `id=eq.${row.id}`, {
    resolved: true,
    outcome,
    price_1h,
    price_4h,
    price_24h,
    mfe_pct,
    mae_pct,
    pnl_pct,
    closed_ts: new Date().toISOString(),
  });
}
const RESOLVE_INTERVAL_MS = 15 * 60 * 1000;
const RESOLVE_AGE_MS = 24 * 60 * 60 * 1000;
const RESOLVE_BATCH = 15;
async function runOutcomeResolution() {
  if (!supabaseConfigured()) return;
  try {
    const cutoff = new Date(Date.now() - RESOLVE_AGE_MS).toISOString();
    const rows = await supabaseSelect(
      'qnx_signal_journal',
      `resolved=eq.false&ts=lt.${encodeURIComponent(cutoff)}&order=ts.asc&limit=${RESOLVE_BATCH}&select=id,ts,symbol,side,entry,sl,tp1,tp2,tp3`
    );
    if (!Array.isArray(rows) || !rows.length) return;
    for (const row of rows) {
      try {
        await resolveJournalRow(row);
      } catch (e) {
        console.log('journal resolve failed for id=' + row.id + ': ' + e.message);
        if (Date.now() - new Date(row.ts).getTime() > 7 * 24 * 60 * 60 * 1000) {
          try {
            await supabasePatch('qnx_signal_journal', `id=eq.${row.id}`, { resolved: true, outcome: null, closed_ts: new Date().toISOString() });
          } catch (e2) {
            /* give up until next cycle */
          }
        }
      }
      await sleep(300);
    }
  } catch (e) {
    console.log('outcome resolution cycle failed: ' + e.message);
  }
}
if (supabaseConfigured()) {
  setInterval(runOutcomeResolution, RESOLVE_INTERVAL_MS);
  setTimeout(runOutcomeResolution, 20000); // one short-delayed run after boot, harmless if nothing is due yet
}

// ---------------------------------------------------------------------
// GET /api/intel — free/keyless derivatives-adjacent & macro reads the
// model-improvement review flagged as high value: Coinbase-vs-Binance
// mark premium, Deribit DVOL + put/call open-interest ratio, total
// stablecoin supply, a USD-strength FX proxy, and real Treasury yields.
// ---------------------------------------------------------------------
async function fetchCoinbasePremium() {
  const [cbBtc, cbEth, mBtc, mEth] = await Promise.all([
    getJSON('https://api.exchange.coinbase.com/products/BTC-USD/ticker'),
    getJSON('https://api.exchange.coinbase.com/products/ETH-USD/ticker'),
    getJSON(`${FAPI}/fapi/v1/premiumIndex?symbol=BTCUSDT`),
    getJSON(`${FAPI}/fapi/v1/premiumIndex?symbol=ETHUSDT`),
  ]);
  const cbBtcPx = +cbBtc.price,
    cbEthPx = +cbEth.price,
    mBtcPx = +mBtc.markPrice,
    mEthPx = +mEth.markPrice;
  return {
    btcPremiumPct: mBtcPx ? ((cbBtcPx - mBtcPx) / mBtcPx) * 100 : null,
    ethPremiumPct: mEthPx ? ((cbEthPx - mEthPx) / mEthPx) * 100 : null,
  };
}
async function fetchDeribitDvol(currency) {
  const now = Date.now();
  const j = await getJSON(
    `https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=${currency}&start_timestamp=${now - 3 * 3600 * 1000}&end_timestamp=${now}&resolution=3600`
  );
  const rows = j.result && j.result.data;
  if (!rows || !rows.length) throw new Error('no DVOL data for ' + currency);
  return rows[rows.length - 1][4]; // [ts, open, high, low, close]
}
async function fetchDeribitPutCall(currency) {
  const j = await getJSON(`https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=${currency}&kind=option`);
  const rows = j.result || [];
  let putOi = 0,
    callOi = 0;
  rows.forEach((r) => {
    const m = /-(C|P)$/.exec(r.instrument_name || '');
    if (!m) return;
    const oi = r.open_interest || 0;
    if (m[1] === 'P') putOi += oi;
    else callOi += oi;
  });
  return callOi ? putOi / callOi : null;
}
async function fetchStablecoinSupply() {
  const j = await getJSON('https://stablecoins.llama.fi/stablecoins?includePrices=true', 15000);
  const assets = j.peggedAssets || [];
  return assets.reduce((a, x) => a + ((x.circulating && x.circulating.peggedUSD) || 0), 0);
}
async function fetchUsdStrength() {
  // api.frankfurter.app 302-redirects to api.frankfurter.dev — call the .dev host directly.
  const j = await getJSON('https://api.frankfurter.dev/v1/latest?from=USD&to=EUR,JPY,GBP,CNY');
  return j.rates;
}
async function fetchTreasuryYields() {
  const yr = new Date().getFullYear();
  const url = `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${yr}/all?type=daily_treasury_yield_curve&field_tdr_date_value=${yr}&page&_format=csv`;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 12000);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const text = await r.text();
    const lines = text.trim().split('\n').filter(Boolean);
    if (lines.length < 2) throw new Error('no data rows');
    const header = lines[0].split(',').map((h) => h.replace(/"/g, '').trim());
    const idx2y = header.findIndex((h) => h === '2 Yr');
    const idx10y = header.findIndex((h) => h === '10 Yr');
    if (idx10y < 0) throw new Error('"10 Yr" column not found');
    let best = null;
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',').map((c) => c.replace(/"/g, '').trim());
      const d = new Date(cols[0]);
      if (!isFinite(d.getTime())) continue;
      if (!best || d > best.date) best = { date: d, cols };
    }
    if (!best) throw new Error('no parsable date rows');
    const y10 = parseFloat(best.cols[idx10y]);
    const y2 = idx2y >= 0 ? parseFloat(best.cols[idx2y]) : NaN;
    return { y10: isFinite(y10) ? y10 : null, y2: isFinite(y2) ? y2 : null, date: best.cols[0] };
  } finally {
    clearTimeout(t);
  }
}
const INTEL_CACHE_MS = 5 * 60 * 1000;
let intelCache = { data: null, fetchedAt: 0 };
async function refreshIntelCache() {
  const tasks = {
    coinbase: fetchCoinbasePremium,
    dvolBtc: () => fetchDeribitDvol('BTC'),
    dvolEth: () => fetchDeribitDvol('ETH'),
    putCallBtc: () => fetchDeribitPutCall('BTC'),
    putCallEth: () => fetchDeribitPutCall('ETH'),
    stablecoinSupply: fetchStablecoinSupply,
    usdFx: fetchUsdStrength,
    treasury: fetchTreasuryYields,
  };
  const keys = Object.keys(tasks);
  const results = await Promise.allSettled(keys.map((k) => tasks[k]()));
  const data = {};
  const status = {};
  results.forEach((r, i) => {
    const k = keys[i];
    if (r.status === 'fulfilled') {
      data[k] = r.value;
      status[k] = 'ok';
    } else {
      status[k] = 'error: ' + (r.reason && r.reason.message);
    }
  });
  intelCache = { data: { ...data, status }, fetchedAt: Date.now() };
  return intelCache.data;
}
async function apiIntel(req, res) {
  try {
    const stale = !intelCache.data || Date.now() - intelCache.fetchedAt > INTEL_CACHE_MS;
    if (stale) await refreshIntelCache().catch(() => {});
    if (!intelCache.data) {
      sendJSON(res, 200, { error: 'intel data unavailable' });
      return;
    }
    sendJSON(res, 200, { ...intelCache.data, fetchedAt: intelCache.fetchedAt });
  } catch (err) {
    sendJSON(res, 200, { error: err.message });
  }
}

// ---------------------------------------------------------------------
// GET /api/calendar — best-effort ForexFactory weekly high-impact
// economic calendar (same "proxy it, degrade gracefully if blocked"
// convention as /api/etf above). Caches for 2h since the schedule itself
// barely changes intraday.
// ---------------------------------------------------------------------
const CALENDAR_CACHE_MS = 2 * 60 * 60 * 1000;
let calendarCache = { data: null, fetchedAt: 0, error: null };
async function fetchEconCalendar() {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 12000);
  try {
    const r = await fetch('https://nfs.faireconomy.media/ff_calendar_thisweek.json', {
      signal: ctl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        Accept: 'application/json',
      },
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const raw = await r.json();
    if (!Array.isArray(raw)) throw new Error('unexpected response shape');
    return raw
      .filter((e) => e.impact === 'High')
      .map((e) => ({ title: e.title, country: e.country, date: e.date, impact: e.impact, forecast: e.forecast, previous: e.previous }));
  } finally {
    clearTimeout(t);
  }
}
async function apiCalendar(req, res) {
  try {
    const stale = !calendarCache.data || Date.now() - calendarCache.fetchedAt > CALENDAR_CACHE_MS;
    if (stale) {
      try {
        calendarCache = { data: await fetchEconCalendar(), fetchedAt: Date.now(), error: null };
      } catch (e) {
        if (!calendarCache.data) calendarCache = { data: [], fetchedAt: Date.now(), error: e.message };
      }
    }
    sendJSON(res, 200, { events: calendarCache.data || [], fetchedAt: calendarCache.fetchedAt, error: calendarCache.error });
  } catch (err) {
    sendJSON(res, 200, { events: [], error: err.message });
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
    if (req.url === '/api/intel') return apiIntel(req, res);
    if (req.url === '/api/calendar') return apiCalendar(req, res);
    if (req.url === '/api/journal' && req.method === 'POST') return apiJournalPost(req, res);
    if (req.url === '/api/journal/stats') return apiJournalStats(req, res);
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
