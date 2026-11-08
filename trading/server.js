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
    // Tracked per-step so the dashboard's Connections panel can report
    // genuinely real status per upstream (Binance / Claude / Supabase)
    // instead of one conflated ok/fail flag.
    const entry = { symbol: sym.symbol, ok: false, market_ok: false, ai_ok: false, db_write_ok: false };
    try {
      const snapshot = await fetchMarketSnapshot(sym.symbol);
      entry.market_ok = true;
      const signal = await generateSignal(sym.symbol, snapshot, sym.leverage_tiers);
      entry.ai_ok = true;
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
      entry.db_write_ok = true;
      entry.ok = true;
      entry.bias = signal.bias;
      summary.push(entry);
      console.log(`[cycle] ${sym.symbol}: ${signal.bias} (${(signal.confidence * 100).toFixed(0)}%)`);
    } catch (err) {
      entry.error = err.message;
      summary.push(entry);
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

function connState(ok) {
  if (ok === true) return { label: 'Online', c: 'var(--ok)' };
  if (ok === false) return { label: 'Degraded', c: 'var(--bad)' };
  return { label: 'Checking…', c: 'var(--muted)' };
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
    <div class="card glass" id="card-${esc(r.symbol)}" style="--c:${biasColor(r.bias)}">
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

  const symbolNav = rows.map(r => `<a href="#card-${esc(r.symbol)}">${esc(r.symbol)}</a>`).join('')
    || '<span style="padding:9px 10px;display:block;color:var(--faint);font-size:13px">none yet</span>';

  const haveCycle = Array.isArray(lastRunSummary) && lastRunSummary.length > 0;
  const binance = connState(haveCycle ? lastRunSummary.some(s => s.market_ok) : null);
  const claude = connState(haveCycle ? lastRunSummary.some(s => s.ai_ok) : null);
  const supabase = connState(!loadError);
  const checkedAt = lastRunAt ? esc(new Date(lastRunAt).toLocaleString('en-GB', { timeZone: 'UTC', hour12: false }) + ' UTC') : 'pending';
  const modelName = esc(process.env.ANTHROPIC_MODEL || 'default');

  const connCards = `
    <div class="card glass" style="--c:#35e8c8">
      <h4>Quant Nexus</h4>
      <p class="conndesc">This page. Static Node service, served from trading.z-cc.link.</p>
      <div class="connrow"><span class="pill" style="--c:var(--ok)"><i></i><span class="txt">Online</span></span></div>
      <div class="connchecked">You're looking at it right now</div>
    </div>
    <div class="card glass" style="--c:#f0b90b">
      <h4>Binance Futures (market data)</h4>
      <p class="conndesc">Public USDC-M perpetuals endpoints — price, funding, candles. Read-only, no API key stored anywhere.</p>
      <div class="connrow"><span class="pill" style="--c:${binance.c}"><i></i><span class="txt">${binance.label}</span></span></div>
      <div class="connchecked">Checked at last refresh · ${checkedAt}</div>
    </div>
    <div class="card glass" style="--c:#8B7CFF">
      <h4>Claude &middot; ${modelName}</h4>
      <p class="conndesc">Generates each signal's bias, confidence and rationale from the live market snapshot.</p>
      <div class="connrow"><span class="pill" style="--c:${claude.c}"><i></i><span class="txt">${claude.label}</span></span></div>
      <div class="connchecked">Checked at last refresh · ${checkedAt}</div>
    </div>
    <div class="card glass" style="--c:#3fa7ff">
      <h4>Supabase &middot; zcc-platform</h4>
      <p class="conndesc">Stores every generated signal and the enabled-symbol configuration this page reads.</p>
      <div class="connrow"><span class="pill" style="--c:${supabase.c}"><i></i><span class="txt">${supabase.label}</span></span></div>
      <div class="connchecked">Checked just now, on this page load</div>
    </div>
  `;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Quant Nexus — ZCC Trading</title>
<meta name="description" content="Quant Nexus — live AI decision-support signals for Binance USDC-M perpetual futures. Informational only, no automated trade execution." />
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Sora:wght@400;500;600;700;800&family=Manrope:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root{
  --void:#07080f; --deep:#0B0D24; --deep2:#11143a;
  --glass:rgba(118,128,255,.055); --glass2:rgba(118,128,255,.10); --glass3:rgba(118,128,255,.16);
  --edge:rgba(150,160,255,.14); --edge2:rgba(170,165,255,.30);
  --text:#ECEEFF; --soft:#B4B9E4; --muted:#7D83B6; --faint:#4C5285;
  --iris:#8B7CFF; --azure:#5B8CFF; --aqua:#3FE0F0;
  --ok:#5EF2C2; --warn:#FFB547; --bad:#FF5470;
  --grad:linear-gradient(135deg,#8B7CFF 0%,#5B8CFF 55%,#3FE0F0 100%);
  --f-display:"Sora",ui-sans-serif,system-ui,sans-serif;
  --f-body:"Manrope",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
  --f-mono:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
  --r-xl:22px; --r-lg:16px; --r-md:12px; --r-sm:8px;
  --side:250px;
}
*{box-sizing:border-box}
h1,h2,h3,h4,p{margin:0}
button,input{font-family:inherit}
html{scroll-behavior:smooth}
html,body{height:100%}
body{margin:0;color:var(--text);font:15px/1.6 var(--f-body);-webkit-font-smoothing:antialiased;
  background:
    radial-gradient(1200px 700px at 58% -10%,rgba(110,92,255,.26),transparent 60%),
    radial-gradient(900px 600px at -10% 105%,rgba(160,90,255,.16),transparent 60%),
    radial-gradient(800px 600px at 105% 60%,rgba(63,224,240,.10),transparent 60%),
    var(--void);
  background-attachment:fixed;overflow-x:hidden;
  animation:drift 24s ease-in-out infinite;
}
@keyframes drift{0%,100%{background-position:0 0,0 0,0 0,0 0}50%{background-position:2% -1%,-1% 1%,1% -2%,0 0}}
a{color:var(--aqua);text-decoration:none}
::selection{background:var(--iris);color:#fff}
:focus-visible{outline:2px solid var(--aqua);outline-offset:2px;border-radius:6px}
.mono{font-family:var(--f-mono)}

.glass{background:linear-gradient(180deg,rgba(255,255,255,.035),rgba(255,255,255,.01)),var(--glass);
  border:1px solid var(--edge);border-radius:var(--r-xl);
  backdrop-filter:blur(18px) saturate(140%);-webkit-backdrop-filter:blur(18px) saturate(140%);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.06),0 20px 50px -30px rgba(0,0,0,.8)}
.live{display:inline-flex;align-items:center;gap:6px;font:600 12px/1 var(--f-body);color:var(--ok)}
.live::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--ok);box-shadow:0 0 10px var(--ok);animation:pulse 1.8s infinite}
@keyframes pulse{50%{opacity:.35}}
.btn{display:inline-flex;align-items:center;gap:8px;font:600 13px/1 var(--f-body);color:var(--text);background:var(--glass2);border:1px solid var(--edge);padding:9px 14px;border-radius:999px;cursor:pointer;transition:background .2s,border-color .2s}
.btn:hover{background:var(--glass3);border-color:var(--edge2)}
.btn.pri{background:var(--grad);border-color:transparent;color:#fff;box-shadow:0 8px 24px -10px rgba(110,100,255,.9)}
.btn.sm{padding:7px 11px;font-size:12px}
.pill{display:inline-flex;align-items:center;gap:6px;font:600 11.5px/1 var(--f-body);color:var(--soft);background:var(--glass);border:1px solid var(--edge);padding:6px 9px;border-radius:999px;white-space:nowrap}
.pill i{width:7px;height:7px;border-radius:50%;background:var(--c,var(--iris));display:inline-block;box-shadow:0 0 8px var(--c,var(--iris))}

.qngate{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;padding:24px;
  background:radial-gradient(ellipse at 50% 20%,rgba(120,100,255,.25),transparent 55%),radial-gradient(ellipse at 50% 100%,rgba(63,224,240,.10),transparent 50%),var(--void)}
.qngate-card{width:100%;max-width:400px;padding:30px 28px;border-radius:var(--r-xl)}
.qngate-brand{display:flex;align-items:center;gap:11px;margin-bottom:4px}
.qngate-brand svg{width:36px;height:36px;flex:none;filter:drop-shadow(0 0 10px rgba(139,124,255,.7))}
.qngate-brand b{display:block;font:600 16px/1.2 var(--f-display)}
.qngate-brand small{display:block;font:500 11.5px/1.3 var(--f-body);color:var(--muted)}
.qngate-sub{margin:10px 0 22px;color:var(--soft);font-size:13.5px;line-height:1.5}
.qngate-card label{display:block;font:600 12px/1 var(--f-body);color:var(--soft);margin:0 0 6px}
.qngate-card input{width:100%;padding:11px 13px;margin-bottom:14px;border-radius:var(--r-md);background:var(--deep2);border:1px solid var(--edge);color:var(--text);font:14px/1.4 var(--f-body);box-sizing:border-box}
.qngate-card input:focus-visible{outline:2px solid var(--aqua);outline-offset:2px}
.qngate-err{color:var(--bad);font-size:12.5px;margin:-4px 0 12px}
.qngate-submit{width:100%;justify-content:center;margin-top:4px;padding:12px;font-size:14.5px;border:0;cursor:pointer}
.qngate-demo{margin-top:20px;padding:13px 15px;border-radius:var(--r-md);background:var(--glass2);border:1px dashed var(--edge2);font-size:12.5px;color:var(--muted);line-height:1.8}
.qngate-demo b{color:var(--text)}
.qngate-demo-admin{margin-top:9px;padding-top:9px;border-top:1px dashed var(--edge)}

.shell{display:grid;grid-template-columns:var(--side) 1fr;min-height:100vh}
aside.side{position:sticky;top:0;height:100vh;padding:20px 14px;display:flex;flex-direction:column;gap:18px;border-right:1px solid var(--edge);background:rgba(8,9,28,.55);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);z-index:40;overflow-y:auto;scrollbar-width:none}
.brand{display:flex;align-items:center;gap:11px;padding:4px 8px 6px}
.brand svg{width:34px;height:34px;flex:none;filter:drop-shadow(0 0 10px rgba(139,124,255,.7))}
.brand b{display:block;font:600 15px/1.15 var(--f-display)}
.brand small{display:block;font:500 11.5px/1.3 var(--f-body);color:var(--muted)}
nav.menu{display:flex;flex-direction:column;gap:2px}
nav.menu .grp{font:600 11.5px/1 var(--f-body);color:var(--faint);padding:14px 10px 7px;text-transform:uppercase;letter-spacing:.06em}
nav.menu a{display:block;padding:9px 10px;border-radius:11px;color:var(--soft);font:500 14px/1.2 var(--f-body);transition:background .15s,color .15s}
nav.menu a:hover{background:var(--glass);color:var(--text)}
.autobox{margin-top:auto;padding:14px;border-radius:var(--r-lg)}
.autobox .t{display:flex;align-items:center;gap:8px;font:600 13px/1.2 var(--f-body)}
.autobox p{margin:6px 0 0;font-size:12.5px;line-height:1.45;color:var(--muted)}

.menubtn{display:none;width:38px;height:38px;border-radius:11px;border:1px solid var(--edge);background:var(--glass2);color:var(--text);cursor:pointer;flex:none;margin-bottom:14px;position:relative}
.menubtn::before{content:"";position:absolute;inset:0;margin:auto;width:16px;height:2px;background:var(--text);box-shadow:0 -5px var(--text),0 5px var(--text);left:11px;top:18px}
main{min-width:0;padding:34px 30px 60px}
header.top{max-width:1040px;margin:0 0 10px}
.badge{display:inline-flex;align-items:center;gap:8px;padding:6px 14px;border:1px solid var(--edge);border-radius:999px;font:600 10.5px/1 var(--f-mono);letter-spacing:.12em;text-transform:uppercase;color:var(--soft);margin-bottom:18px}
.badge .dot{width:6px;height:6px;border-radius:50%;background:var(--aqua);box-shadow:0 0 8px var(--aqua)}
h1{font:800 clamp(2rem,5vw,3rem)/1.05 var(--f-display);letter-spacing:-0.02em;background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent;margin-bottom:8px}
.sub{font:600 16px/1.3 var(--f-display);color:var(--soft);margin-bottom:16px}
.disclaimer{max-width:640px;color:var(--muted);font-size:.85rem;line-height:1.55}
.qnwho{display:flex;align-items:center;gap:10px;margin-top:18px}
.status{max-width:1040px;margin:22px 0 24px;font:600 11.5px/1.4 var(--f-mono);color:var(--muted)}
.status.err{color:var(--bad)}
.err-inline{color:var(--bad)}

.grid{max-width:1040px;display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px}
.grid.g3{grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}
.card{padding:20px;transition:transform .2s,box-shadow .2s}
.card:hover{transform:translateY(-3px)}
.card-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}
.sym{font:700 1.05rem/1.2 var(--f-display)}
.bias{font:600 10.5px/1 var(--f-mono);letter-spacing:.08em;border:1px solid;border-radius:999px;padding:3px 9px}
.price{font:800 1.6rem/1.2 var(--f-display);margin-bottom:14px;color:var(--text)}
.meta-row{display:flex;justify-content:space-between;font-size:.85rem;padding:6px 0;border-top:1px solid var(--edge)}
.meta-row .k{color:var(--muted)}
.meta-row .v{color:var(--soft);font-weight:600}
.rationale{margin-top:12px;font-size:.85rem;line-height:1.5;color:var(--soft)}
.ts{margin-top:14px;font:500 10px/1 var(--f-mono);color:var(--faint)}

.vh{max-width:1040px;margin:48px 0 16px}
.vh h2{font:700 1.3rem/1.2 var(--f-display);margin-bottom:6px}
.vh p{color:var(--muted);font-size:.88rem;max-width:620px}
.card h4{font:600 14px/1.2 var(--f-display);margin-bottom:6px}
.conndesc{font-size:.82rem;color:var(--muted);line-height:1.45;margin-bottom:12px}
.connrow{display:flex;align-items:center;gap:10px}
.connchecked{margin-top:10px;font:500 11px/1.3 var(--f-mono);color:var(--faint)}

footer{max-width:1040px;margin:48px 0 0;font:500 11.5px/1.5 var(--f-mono);color:var(--faint)}
footer a{color:var(--soft)}
footer a:hover{color:var(--aqua)}

@media (max-width:880px){
  .shell{grid-template-columns:1fr}
  aside.side{position:fixed;left:0;top:0;width:260px;transform:translateX(-100%);transition:transform .25s ease;box-shadow:30px 0 60px -30px rgba(0,0,0,.9)}
  aside.side.open{transform:translateX(0)}
  .menubtn{display:inline-flex;align-items:center;justify-content:center}
  main{padding:22px 18px 50px}
}
</style>
</head>
<body>

<div id="qnGate" class="qngate" role="dialog" aria-modal="true" aria-label="Sign in to Quant Nexus">
  <div class="qngate-card glass">
    <div class="qngate-brand">
      <svg viewBox="0 0 40 40" aria-hidden="true"><defs><linearGradient id="qg1" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#B2A6FF"/><stop offset=".55" stop-color="#5B8CFF"/><stop offset="1" stop-color="#3FE0F0"/></linearGradient></defs><path d="M20 2l12 9-4 21-8 6-8-6-4-21z" fill="url(#qg1)" fill-opacity=".22" stroke="url(#qg1)" stroke-width="1.6" stroke-linejoin="round"/><path d="M8 11h24M20 2l-6 9 6 27 6-27z" fill="none" stroke="url(#qg1)" stroke-width="1.2" stroke-linejoin="round" opacity=".85"/></svg>
      <div><b>Quant Nexus</b><small>ZCC Trading</small></div>
    </div>
    <p class="qngate-sub">Sign in to open the live signal desk.</p>
    <form id="qnGateForm">
      <label for="qnUser">Username</label>
      <input id="qnUser" type="text" autocomplete="username">
      <label for="qnPass">Password</label>
      <input id="qnPass" type="password" autocomplete="current-password">
      <div id="qnGateError" class="qngate-err" hidden>That username or password isn't right. Try the demo credentials below.</div>
      <button type="submit" class="btn pri qngate-submit">Sign in</button>
    </form>
    <div class="qngate-demo mono">
      Viewer access<br>Username: <b>demo</b> &nbsp;&middot;&nbsp; Password: <b>zinerge2026</b>
      <div class="qngate-demo-admin">Admin access<br>Username: <b>admin</b> &nbsp;&middot;&nbsp; Password: <b>zinerge2026admin</b></div>
    </div>
  </div>
</div>

<div class="shell">
<aside class="side" id="qnSide" aria-label="Main navigation">
  <div class="brand">
    <svg viewBox="0 0 40 40" aria-hidden="true"><defs><linearGradient id="qg2" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#B2A6FF"/><stop offset=".55" stop-color="#5B8CFF"/><stop offset="1" stop-color="#3FE0F0"/></linearGradient></defs><path d="M20 2l12 9-4 21-8 6-8-6-4-21z" fill="url(#qg2)" fill-opacity=".22" stroke="url(#qg2)" stroke-width="1.6" stroke-linejoin="round"/><path d="M8 11h24M20 2l-6 9 6 27 6-27z" fill="none" stroke="url(#qg2)" stroke-width="1.2" stroke-linejoin="round" opacity=".85"/></svg>
    <div><b>Quant Nexus</b><small>ZCC Trading</small></div>
  </div>
  <nav class="menu">
    <div class="grp">Overview</div>
    <a href="#signals">Signal desk</a>
    <a href="#connections">Connections</a>
    <div class="grp">Symbols</div>
    ${symbolNav}
  </nav>
  <div class="autobox glass">
    <div class="t"><span class="live"></span>Auto-refresh</div>
    <p>Every ${Math.round(REFRESH_MS / 60000)} min &middot; informational only &middot; no automated execution.</p>
  </div>
</aside>

<main>
<header class="top">
  <button class="menubtn" id="qnMenuBtn" aria-label="Open navigation"></button>
  <div class="badge"><span class="dot"></span>Live decision-support feed</div>
  <h1>Quant Nexus</h1>
  <div class="sub">ZCC Trading — AI Futures Decision Desk</div>
  <p class="disclaimer">
    AI-generated analysis of live Binance USDC-M perpetual futures data, refreshed automatically.
    This is informational decision-support only — not personalized financial advice, and nothing
    on this page places, modifies, or cancels a real order. Any trade is a human action you take
    yourself on Binance.
  </p>
  <div class="qnwho">
    <span class="pill" id="qnRoleBadge"><i></i><span class="txt">Viewer</span></span>
    <button class="btn sm" id="qnLogoutBtn" type="button">Sign out</button>
  </div>
</header>

${statusLine}

<section id="signals">
  <div class="grid">${cards || ''}</div>
</section>

<section id="connections">
  <div class="vh"><h2>Connections</h2><p>What this page actually talks to, checked live — every status below reflects a real call, not a simulation.</p></div>
  <div class="grid g3">${connCards}</div>
</section>

<footer>trading.z-cc.link &middot; part of <a href="https://z-cc.link" rel="noopener">z-cc.link</a></footer>
</main>
</div>

<script>
(function(){
  var KEY = 'qnx_authed_v1';
  var ROLE_KEY = 'qnx_role_v1';
  function ready(fn){ if (document.readyState !== 'loading') { fn(); } else { document.addEventListener('DOMContentLoaded', fn); } }
  function applyRoleUI(role){
    var badge = document.getElementById('qnRoleBadge');
    if (badge) {
      badge.querySelector('.txt').textContent = role === 'admin' ? 'Admin' : 'Viewer';
      badge.style.setProperty('--c', role === 'admin' ? 'var(--iris)' : 'var(--muted)');
    }
  }
  ready(function(){
    var gate = document.getElementById('qnGate');
    var alreadyIn = false, savedRole = 'viewer';
    try {
      alreadyIn = localStorage.getItem(KEY) === '1';
      savedRole = localStorage.getItem(ROLE_KEY) || 'viewer';
    } catch (e) {}
    if (gate && alreadyIn) { gate.style.display = 'none'; }
    applyRoleUI(savedRole);
    var form = document.getElementById('qnGateForm');
    var err = document.getElementById('qnGateError');
    if (form) {
      form.addEventListener('submit', function(e){
        e.preventDefault();
        var u = (document.getElementById('qnUser').value || '').trim().toLowerCase();
        var p = document.getElementById('qnPass').value || '';
        var role = null;
        if (u === 'demo' && p === 'zinerge2026') { role = 'viewer'; }
        else if (u === 'admin' && p === 'zinerge2026admin') { role = 'admin'; }
        if (role) {
          try { localStorage.setItem(KEY, '1'); localStorage.setItem(ROLE_KEY, role); } catch (e) {}
          if (err) err.hidden = true;
          if (gate) gate.style.display = 'none';
          applyRoleUI(role);
        } else if (err) {
          err.hidden = false;
        }
      });
    }
    var logoutBtn = document.getElementById('qnLogoutBtn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', function(){
        try { localStorage.removeItem(KEY); localStorage.removeItem(ROLE_KEY); } catch (e) {}
        location.reload();
      });
    }
    var menuBtn = document.getElementById('qnMenuBtn');
    var side = document.getElementById('qnSide');
    if (menuBtn && side) {
      menuBtn.addEventListener('click', function(){ side.classList.toggle('open'); });
      var links = side.querySelectorAll('a');
      for (var i = 0; i < links.length; i++) {
        links[i].addEventListener('click', function(){ side.classList.remove('open'); });
      }
    }
  });
})();
</script>
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
