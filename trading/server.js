const http = require('http');
const { fetchMarketSnapshot, generateSignal, listEnabledSymbols, writeSignal, latestSignalPerSymbol } = require('./lib.js');

const PORT = process.env.PORT || 3000;
const REFRESH_MS = Number(process.env.REFRESH_INTERVAL_MINUTES || 30) * 60 * 1000;

let lastRunAt = null;
let lastRunError = null;
let lastRunSummary = [];

async function runCycle() {
  const startedAt = new Date().toISOString();
  const summary = [];
  let symbols;
  try {
    symbols = await listEnabledSymbols();
  } catch (err) {
    lastRunError = `Could not load symbol list from Supabase: ${err.message}`;
    console.error('[cycle]', lastRunError);
    return;
  }

  for (const sym of symbols) {
    try {
      const snapshot = await fetchMarketSnapshot(sym.symbol);
      const signal = await generateSignal(sym.symbol, snapshot, sym.leverage_tiers);
      await writeSignal({
        symbol: sym.symbol,
        mark_price: snapshot.mark_price,
        bias: signal.bias,
        confidence: signal.confidence,
        suggested_leverage_tier: signal.suggested_leverage_tier,
        rationale: signal.rationale,
        model: signal.model,
        raw_market_snapshot: snapshot,
      });
      summary.push({ symbol: sym.symbol, ok: true, bias: signal.bias });
      console.log(`[cycle] ${sym.symbol}: ${signal.bias} (${(signal.confidence * 100).toFixed(0)}%)`);
    } catch (err) {
      summary.push({ symbol: sym.symbol, ok: false, error: err.message });
      console.error(`[cycle] ${sym.symbol} failed:`, err.message);
    }
    // Small gap between symbols so we're not bursting either API.
    await new Promise(r => setTimeout(r, 1500));
  }

  lastRunAt = startedAt;
  lastRunError = null;
  lastRunSummary = summary;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtPct(n) {
  if (n === null || n === undefined) return '—';
  return `${(n * 100).toFixed(0)}%`;
}

function biasColor(bias) {
  if (bias === 'long') return '#35e8c8';
  if (bias === 'short') return '#ff6b8b';
  return '#a9adc9';
}

async function renderDashboard() {
  let rows = [];
  let loadError = null;
  try {
    rows = await latestSignalPerSymbol();
    rows.sort((a, b) => a.symbol.localeCompare(b.symbol));
  } catch (err) {
    loadError = err.message;
  }

  const cards = rows.map(r => `
    <div class="card">
      <div class="card-head">
        <span class="sym">${esc(r.symbol)}</span>
        <span class="bias" style="color:${biasColor(r.bias)}; border-color:${biasColor(r.bias)}44;">${esc((r.bias || '—').toUpperCase())}</span>
      </div>
      <div class="price">$${r.mark_price ? Number(r.mark_price).toLocaleString(undefined, { maximumFractionDigits: 4 }) : '—'}</div>
      <div class="meta-row"><span class="k">Confidence</span><span class="v">${fmtPct(r.confidence)}</span></div>
      <div class="meta-row"><span class="k">Suggested tier</span><span class="v">${esc(r.suggested_leverage_tier || '—')}</span></div>
      <p class="rationale">${esc(r.rationale || 'No rationale recorded.')}</p>
      <div class="ts">generated ${esc(r.generated_at ? new Date(r.generated_at).toLocaleString('en-GB', { timeZone: 'UTC', hour12: false }) + ' UTC' : '—')}</div>
    </div>
  `).join('');

  const statusLine = loadError
    ? `<div class="status err">Could not load signals from Supabase: ${esc(loadError)}</div>`
    : rows.length === 0
      ? `<div class="status">No signals generated yet — first refresh cycle is still running.</div>`
      : `<div class="status">Last refresh: ${lastRunAt ? esc(new Date(lastRunAt).toLocaleString('en-GB', { timeZone: 'UTC', hour12: false }) + ' UTC') : 'pending'} · next in ≤ ${Math.round(REFRESH_MS / 60000)} min${lastRunError ? ` · <span class="err-inline">${esc(lastRunError)}</span>` : ''}</div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Quant Nexus — ZCC Trading</title>
<meta name="description" content="Quant Nexus — live AI decision-support signals for Binance USDC-M perpetual futures. Informational only, no automated trade execution." />
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Sora:wght@400;600;700;800&family=Manrope:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root{
    --bg-0:#07080f; --iris:#6c5ce7; --azure:#3fa7ff; --aqua:#35e8c8;
    --text-0:#eef0ff; --text-1:#a9adc9; --text-2:#6b7094; --line:rgba(140,150,210,0.14);
  }
  *{box-sizing:border-box;margin:0;padding:0;}
  body{
    background:
      radial-gradient(60% 50% at 18% 0%, rgba(108,92,231,0.18), transparent 60%),
      radial-gradient(55% 45% at 85% 10%, rgba(63,167,255,0.14), transparent 60%),
      var(--bg-0);
    color:var(--text-0); font-family:'Manrope', sans-serif; min-height:100vh; padding:40px 20px 60px;
  }
  .top{max-width:1040px; margin:0 auto 28px; text-align:center;}
  .badge{display:inline-flex; align-items:center; gap:8px; padding:6px 14px; border:1px solid var(--line); border-radius:999px; font-family:'JetBrains Mono', monospace; font-size:10.5px; letter-spacing:0.12em; text-transform:uppercase; color:var(--text-1); margin-bottom:18px;}
  .badge .dot{width:6px;height:6px;border-radius:50%;background:var(--aqua); box-shadow:0 0 8px var(--aqua);}
  h1{font-family:'Sora', sans-serif; font-weight:800; font-size:clamp(2rem,5vw,3rem); letter-spacing:-0.02em; background:linear-gradient(100deg, var(--iris), var(--azure), var(--aqua)); -webkit-background-clip:text; background-clip:text; color:transparent; margin-bottom:8px;}
  .sub{font-family:'Sora', sans-serif; font-weight:600; color:var(--text-1); margin-bottom:16px;}
  .disclaimer{max-width:620px; margin:0 auto; color:var(--text-2); font-size:0.85rem; line-height:1.55;}
  .status{max-width:1040px; margin:22px auto 24px; text-align:center; font-family:'JetBrains Mono', monospace; font-size:11.5px; color:var(--text-2);}
  .status.err{color:#ff6b8b;}
  .err-inline{color:#ff6b8b;}
  .grid{max-width:1040px; margin:0 auto; display:grid; grid-template-columns:repeat(auto-fit, minmax(240px,1fr)); gap:16px;}
  .card{border:1px solid var(--line); background:rgba(255,255,255,0.025); backdrop-filter:blur(10px); border-radius:16px; padding:20px;}
  .card-head{display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;}
  .sym{font-family:'Sora', sans-serif; font-weight:700; font-size:1.05rem;}
  .bias{font-family:'JetBrains Mono', monospace; font-size:10.5px; letter-spacing:0.08em; border:1px solid; border-radius:999px; padding:3px 9px;}
  .price{font-family:'Sora', sans-serif; font-weight:800; font-size:1.6rem; margin-bottom:14px;}
  .meta-row{display:flex; justify-content:space-between; font-size:0.85rem; padding:4px 0; border-top:1px solid var(--line);}
  .meta-row .k{color:var(--text-2);}
  .rationale{margin-top:12px; font-size:0.85rem; line-height:1.5; color:var(--text-1);}
  .ts{margin-top:14px; font-family:'JetBrains Mono', monospace; font-size:10px; color:var(--text-2);}
  footer{max-width:1040px; margin:40px auto 0; text-align:center; font-size:0.78rem; color:var(--text-2); font-family:'JetBrains Mono', monospace;}
  footer a{color:var(--text-1); text-decoration:none;}
  footer a:hover{color:var(--aqua);}
</style>
</head>
<body>
  <div class="top">
    <div class="badge"><span class="dot"></span>Live decision-support feed</div>
    <h1>Quant Nexus</h1>
    <div class="sub">ZCC Trading — AI Futures Decision Desk</div>
    <p class="disclaimer">
      AI-generated analysis of live Binance USDC-M perpetual futures data, refreshed automatically.
      This is informational decision-support only — not personalized financial advice, and nothing
      on this page places, modifies, or cancels a real order. Any trade is a human action you take
      yourself on Binance.
    </p>
  </div>
  ${statusLine}
  <div class="grid">${cards || ''}</div>
  <footer>trading.z-cc.link · part of <a href="https://z-cc.link" rel="noopener">z-cc.link</a></footer>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }
  if (req.url === '/api/signals') {
    try {
      const rows = await latestSignalPerSymbol();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ last_run_at: lastRunAt, last_run_error: lastRunError, signals: rows }));
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }
  try {
    const html = await renderDashboard();
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end(`Render error: ${err.message}`);
  }
});

server.listen(PORT, () => {
  console.log(`Quant Nexus running on port ${PORT}, refresh every ${REFRESH_MS / 60000} min`);
  runCycle().catch(err => console.error('[startup cycle]', err));
  setInterval(() => runCycle().catch(err => console.error('[cycle]', err)), REFRESH_MS);
});
