// Quant Nexus — market data, AI signal generation, and Supabase persistence.
//
// SAFETY: this module never places, modifies, or cancels a real order. Only
// Binance's public, unauthenticated market-data endpoints are called (no
// API key, no trading permission exists anywhere in this service). The
// Anthropic call below is asked for decision-support analysis only, and the
// system prompt explicitly forbids it from being framed as an instruction
// to execute a trade. Any real order is a human action taken on Binance
// itself, entirely outside this service.

const BINANCE_BASE = 'https://fapi.binance.com';

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

// ---------------------------------------------------------------------------
// Binance USDⓈ-M futures — public market data only
// ---------------------------------------------------------------------------

async function fetchJson(url, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function fetchMarketSnapshot(symbol) {
  const [premium, ticker24h, klines] = await Promise.all([
    fetchJson(`${BINANCE_BASE}/fapi/v1/premiumIndex?symbol=${symbol}`),
    fetchJson(`${BINANCE_BASE}/fapi/v1/ticker/24hr?symbol=${symbol}`),
    fetchJson(`${BINANCE_BASE}/fapi/v1/klines?symbol=${symbol}&interval=1h&limit=12`),
  ]);
  return {
    symbol,
    mark_price: Number(premium.markPrice),
    index_price: Number(premium.indexPrice),
    last_funding_rate: Number(premium.lastFundingRate),
    next_funding_time: premium.nextFundingTime,
    price_change_percent_24h: Number(ticker24h.priceChangePercent),
    high_24h: Number(ticker24h.highPrice),
    low_24h: Number(ticker24h.lowPrice),
    volume_24h_base: Number(ticker24h.volume),
    // last 12 hourly candles: [openTime, open, high, low, close, volume]
    recent_1h_candles: klines.map(k => ({
      t: k[0], o: Number(k[1]), h: Number(k[2]), l: Number(k[3]), c: Number(k[4]), v: Number(k[5]),
    })),
    fetched_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Anthropic — decision-support signal generation (structured via tool use)
// ---------------------------------------------------------------------------

const SIGNAL_TOOL = {
  name: 'emit_signal',
  description: 'Emit one structured decision-support read on this symbol. This is informational only — nothing you output here executes a trade.',
  input_schema: {
    type: 'object',
    properties: {
      bias: { type: 'string', enum: ['long', 'short', 'neutral'] },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      suggested_leverage_tier: { type: 'string', description: 'Which of the provided leverage tiers this read fits, by its max_leverage value, e.g. "10x" — purely descriptive, not a recommendation to use it.' },
      rationale: { type: 'string', description: 'Plain-language reasoning a human can sanity-check in 2-3 sentences, citing the specific data points used.' },
    },
    required: ['bias', 'confidence', 'suggested_leverage_tier', 'rationale'],
  },
};

const SYSTEM_PROMPT = `You are a decision-support analyst for Quant Nexus, part of ZCC Trading.
You are given live Binance USDC-M perpetual futures market data for one symbol and that
symbol's configured leverage tiers. Produce ONE structured read via the emit_signal tool.

Hard rules:
- You are never executing a trade, placing an order, or giving personalized financial advice.
  You are annotating market data for a human who will make their own decision.
- Base your read only on the data provided. Do not invent price levels or news not present
  in the data. If the data is genuinely ambiguous, say so and use bias "neutral" with lower confidence.
- Keep rationale concrete and falsifiable — reference specific numbers from the data
  (e.g. "24h change of +3.2% with price holding above the 12h high") rather than vague
  sentiment language.
- confidence reflects how clearly the provided data supports the stated bias, not a probability
  of profit.`;

async function generateSignal(symbol, snapshot, leverageTiers) {
  const model = required('ANTHROPIC_MODEL');
  const apiKey = required('ANTHROPIC_API_KEY');

  const userContent = JSON.stringify({ symbol, market_snapshot: snapshot, leverage_tiers: leverageTiers }, null, 2);

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 600,
      system: SYSTEM_PROMPT,
      tools: [SIGNAL_TOOL],
      tool_choice: { type: 'tool', name: 'emit_signal' },
      messages: [{ role: 'user', content: userContent }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Anthropic API ${res.status}: ${body.slice(0, 500)}`);
  }

  const data = await res.json();
  const toolUse = (data.content || []).find(b => b.type === 'tool_use' && b.name === 'emit_signal');
  if (!toolUse) throw new Error('Anthropic response had no emit_signal tool_use block');

  return {
    bias: toolUse.input.bias,
    confidence: toolUse.input.confidence,
    suggested_leverage_tier: toolUse.input.suggested_leverage_tier,
    rationale: toolUse.input.rationale,
    model,
  };
}

// ---------------------------------------------------------------------------
// Supabase — REST (service role), no client library needed
// ---------------------------------------------------------------------------

function supabaseHeaders() {
  const key = required('SUPABASE_SECRET_KEY');
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'content-type': 'application/json',
  };
}

async function supaFetch(path, init = {}) {
  const base = required('SUPABASE_URL');
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { ...supabaseHeaders(), ...(init.headers || {}) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Supabase ${res.status} on ${path}: ${body.slice(0, 500)}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

async function listEnabledSymbols() {
  return supaFetch('/rest/v1/trading_symbols?select=*&enabled=eq.true&order=symbol.asc');
}

async function writeSignal(row) {
  return supaFetch('/rest/v1/trading_signals', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(row),
  });
}

async function latestSignalPerSymbol() {
  // Supabase REST doesn't do DISTINCT ON directly; pull recent rows and reduce in JS.
  const rows = await supaFetch('/rest/v1/trading_signals?select=*&order=generated_at.desc&limit=200');
  const bySymbol = new Map();
  for (const row of rows) {
    if (!bySymbol.has(row.symbol)) bySymbol.set(row.symbol, row);
  }
  return [...bySymbol.values()];
}

module.exports = {
  fetchMarketSnapshot,
  generateSignal,
  listEnabledSymbols,
  writeSignal,
  latestSignalPerSymbol,
};
