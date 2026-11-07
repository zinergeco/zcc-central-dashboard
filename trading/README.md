# Quant Nexus — ZCC Trading

Live AI decision-support dashboard for Binance USDC-M perpetual futures, at
`trading.z-cc.link`, part of [ZCC Command Centre](https://z-cc.link).

## What this is

Every refresh cycle (default every 30 minutes, see `REFRESH_INTERVAL_MINUTES`),
for each enabled symbol in Supabase's `trading_symbols` table, this service:

1. Fetches live public market data from Binance's USDⓈ-M futures API
   (mark price, funding rate, 24h change, 12 hourly candles) — **no API key,
   no trading permission, public endpoints only**.
2. Sends that data to the Anthropic API, which returns a structured
   decision-support read (bias, confidence, suggested leverage tier,
   plain-language rationale) via a forced tool call — not free text, so the
   shape is reliable.
3. Writes the result to Supabase's `trading_signals` table.
4. The dashboard page (`/`) renders the latest signal per symbol from that
   table. `/api/signals` returns the same data as JSON. `/healthz` is a
   plain liveness check.

## What this explicitly is not

**Nothing in this service places, modifies, or cancels a real order.** There
is no Binance API key with trading permission anywhere in this codebase —
only public market-data endpoints are called. The Anthropic system prompt
(`lib.js`) explicitly frames every output as informational decision-support,
never an instruction to execute a trade or personalized financial advice.
Any real order is a human action taken on Binance directly, outside this
system. If real automated execution is ever wanted, that is a deliberate,
separately-scoped, explicitly-approved piece of work — not something that
should get bolted on here as a side effect.

## Required environment variables

- `SUPABASE_URL`, `SUPABASE_SECRET_KEY` — same `zcc-platform` Supabase
  project used by the main agent mesh backend (`trading_symbols` /
  `trading_signals` tables, migration `0007_trading_signals.sql`).
- `ANTHROPIC_API_KEY` — a real Anthropic API key.
- `ANTHROPIC_MODEL` — a current Anthropic model ID. Never hardcoded in code
  (same convention as `zcc-platform`'s `resolveModel.ts`) — the service
  throws on startup of the first cycle if this is unset.
- `REFRESH_INTERVAL_MINUTES` (optional, default `30`).
- `PORT` (optional, default `3000`).

## Stack

Zero npm dependencies — Node 20's built-in `fetch` and `http` cover
Binance, Anthropic, and Supabase's REST API. `node:20-alpine` Dockerfile,
deployed via Coolify as a resource pointed at this `trading/` subdirectory
of the `zcc-central-dashboard` repo.
