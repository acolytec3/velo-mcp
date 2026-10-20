# AGENTS.md — velo-mcp

Guidance for AI agents working in this repo. Read this before making changes.

## What this is

An **unofficial** MCP server + CLI exposing velo.xyz's internal chart data API. None of this is documented by Velo — everything here was reverse-engineered by (1) capturing network traffic from `https://velo.xyz/chart` via CDP while studies were attached, and (2) extracting TradingView custom-study registrations from the chart's minified frontend bundle (`ChartRoute.*.js`). Treat all of it as fragile and best-effort; it can break the moment Velo ships a frontend change. **Do not assume anything about this API beyond what's documented here or in `src/catalog.ts` without live-testing it first** (see "How to verify changes" below).

## Layout

```
src/
  catalog.ts     # Static reverse-engineered facts: indicators, exchange groups,
                 # timeframe→resolution mapping, data limits. No network calls.
                 # This is the source of truth — update it, not README.md, when
                 # you discover/confirm new API behavior.
  veloClient.ts  # fetchRange() (auto-paginating HTTP client), buildCompoundSymbol(),
                 # normalizeRows() (shapes raw arr rows into Candle|Point).
  index.ts       # MCP server (@modelcontextprotocol/server v2) — 4 tools:
                 # velo_list_indicators, velo_get_price, velo_get_indicator,
                 # velo_get_heatmap_levels.
  dump.ts        # Standalone CLI (`npm run dump --`) for one-off data pulls to
                 # CSV/JSON. Reuses catalog.ts/veloClient.ts — do not duplicate
                 # logic here; if you need new shared behavior, put it in
                 # catalog.ts or veloClient.ts and import it in both index.ts
                 # and dump.ts.
```

Build: `npm run build` (tsc). Run server: `npm start`. Run CLI: `npm run dump -- --ticker ... --timeframe ... --lookback ...` (see README.md for full flag list).

## Core reverse-engineered facts (as of 2026-10-12)

### The one endpoint everything hangs off

```
GET https://velo.xyz/api/m/range?exchange=<exchange>&symbol=<symbol>&resolution=<res>&begin=<epochMs>&end=<epochMs>
```

No auth required (confirmed with and without cookies). Response: `{ begin, end, arr: number[][] }`. `arr` row timestamps are **epoch seconds**; request `begin`/`end` are epoch **ms**. Row width tells you the shape:

- width 6 → `[time, open, high, low, close, volume]` (price candles)
- width 5 → `[time, open, high, low, close]` (e.g. Open Interest "Candles" view)
- width 2 → `[time, value]` (single-line series, e.g. "Cumulative Delta")

### Plain price vs. compound/aggregated symbol

- Plain price: `symbol` is just the ticker, e.g. `NEARUSDT`.
- Indicators: `symbol` is a `#`-joined chain (percent-encoded as `%23` on the wire):
  `<ticker>#<exchange1>#...#<exchangeN>#<metric>#aggregated#<unit>#<view>`
  The literal `aggregated` segment is always present, even for single-exchange / non-"Aggregated X" studies (just pass one exchange in that case). `buildCompoundSymbol()` in `veloClient.ts` builds this.

### Resolution quirk — THE #1 GOTCHA

`resolution` accepts plain minute counts for intraday bars (`1`, `5`, `15`, `60`, `240`) but **daily bars require the literal string `"1D"`**. `resolution=1440` always 400s, even for a single day. This is encoded in `TIMEFRAME_TO_RESOLUTION_PARAM` in `catalog.ts` — if you ever reimplement timeframe handling, do not go back to `resolution=minutes` for `"1d"`.

### Per-request row cap — THE #2 GOTCHA

A single request is capped at **~459–460 bars**, independent of resolution (confirmed at 1m/5m/15m/1h/4h via binary search). Exceeding it returns HTTP 400 with an empty body. `MAX_BARS_PER_REQUEST = 450` in `catalog.ts` (safety margin below the observed edge). `fetchRange()` in `veloClient.ts` auto-paginates transparently above this (5-way concurrent fetch, dedupe by timestamp, sort), with a `maxChunks` safety ceiling (default 50 ≈ 22,500 bars) that throws a clear error rather than silently issuing thousands of requests. **Never bypass `fetchRange()` to call the endpoint directly** — you'll hit silent 400s on anything more than ~1.5 days of 5m data.

This cap might be tier-specific (observed account was tier 0 / free per its JWT). If you're testing from a paid account and find a different cap, update `MAX_BARS_PER_REQUEST` and this doc.

### "Cumulative" views don't actually accumulate server-side — THE #3 GOTCHA

A/B-confirmed by requesting `view=Delta`, `view=Cumulative Delta`, and `view=Cumulative Delta (Candles)` for the same metric/range: **all three return byte-identical raw per-bar delta data**. The `view` segment of the compound symbol has no effect on what `/api/m/range` sends back for these. The smoothly running-total line you see on the live chart for "Cumulative Delta" is accumulated **client-side** by the TradingView study — never trust raw "Cumulative ..." API output as already-summed; it isn't. `isCumulativeView()` / `cumulativeSum()` / `applyCumulativeIfRequested()` in `veloClient.ts` reproduce that accumulation locally, and both `index.ts` (`velo_get_indicator`) and `dump.ts` apply it automatically whenever `view` matches `/cumulative/i`. If you add new call sites that fetch a "Cumulative ..." view, route through `applyCumulativeIfRequested()` rather than assuming the API already did it.

### Historical floor — THE #4 GOTCHA

Data has a hard floor at **`2021-01-01T00:00:00Z`**, confirmed identical across every exchange tested (Binance, Bybit, OKX, Deribit, Coinbase) via binary search — it stops dead, not a gradual taper. This is Velo's own data-collection start date, **not** when the underlying exchange/instrument actually launched (e.g. real Binance BTCUSDT perp history goes back to Sept 2019, Velo has none of it before 2021-01-01). Hyperliquid has nothing this far back since it launched in 2023 — don't mistake that for a bug. `EARLIEST_AVAILABLE_DATA` in `catalog.ts`; `fetchRange()` clamps `begin` to it silently rather than erroring.

### Exchange groups

- **Derivatives (8)**: `binance-futures`, `bybit`, `okex-swap`, `deribit`, `hyperliquid`, `binance-coin-margin`, `bybit-coin-margin`, `okex-coin-margin` — default aggregation set for `open_interest`, `volume`, `liquidations`, `funding_rate`, `premium`, `tape`.
- **Spot (4)**: `binance`, `coinbase`, `bybit-spot`, `okex` — default set for `spotvol`, `spottape`.
- **Cross Exchange Funding (5)**: the 5 non-coin-margin derivatives venues — default set for `cross_exchange_funding` only (plots one line per exchange rather than summing; don't default this one to the 8-exchange set, that was a bug we already fixed once).

### Indicator catalog

`src/catalog.ts` → `INDICATORS` has all 17 Velo indicators (4 price-derived overlays with no API metric, 7 single-exchange metrics, 9 aggregated metrics — some indicators share a metric, e.g. Open Interest and Aggregated Open Interest both use `open_interest`, just different default exchange counts). `defaultExchangesForMetric()` / `defaultViewForMetric()` centralize the "what does Velo's own UI default to" logic — both `index.ts` and `dump.ts` call these, don't reimplement.

### Verification status — be honest about what's untested

Live-confirmed end-to-end: plain price candles, `open_interest`+`Candles`, `volume`+`Cumulative Delta`, `spotvol`+`Cumulative Delta`, daily (`1D`) resolution, cross-chunk pagination, pre-2021 clamping. Every other metric/view combination in the catalog is inferred from the TradingView study `inputs` metadata (i.e., we know the option exists in the UI) but its actual `arr` response shape hasn't been individually confirmed. If something looks wrong for an untested combo, that's the likely cause — don't assume the code is buggy before checking against the live chart.

### Chart heatmap (`/api/l/levels`) — separate from `/api/m/range`

The price-chart heatmap overlay (orderbook depth; Hyperliquid liquidation/TP/SL
books) is **`GET /api/l/levels`**, gzip or plain CSV text, **not** the compound
symbol `/api/m/range` pipeline. Query params: `begin`/`end` (epoch ms), `reso`
(minute count — daily is `1440`, not `1D`), `spread`, plus either `coin` (aggregated
orderbook) or `exchange`+`product` (non-orderbook types append `-liqBook`/`-tpBook`/`-slBook`
to `exchange`). **512-bucket cap** per request (`steps (minutes / reso) > 512` → 403);
`fetchHeatmapLevels()` in `veloClient.ts` buffers each response fully and auto-chunks.
Orderbook coverage is the `depth=true` subset of `https://api.velo.xyz/api/v1/futures`
(12 coins / 32 exchange+product rows as of 2026-10-20 — see `HEATMAP_ORDERBOOK_*` in
`catalog.ts`). `coin=NEAR` and most alt perps 404. HL liquidation/tp/sl books use
`hyperliquid-{liqBook|tpBook|slBook}` + hyperliquid product ids (`BTC-USD`, not `BTCUSDT`).
Live WebSocket updates use `wss://wss.velo.xyz/api/w/connect` — not exposed in MCP yet.

### Not implemented / out of scope so far

- `/api/a/*` (profile, session, status, layouts) — requires auth, account-specific, not touched.
- Market screener (the coin table on `/chart`, `/futures/:ticker`, `/market`) — not reverse-engineered.
- Options chain data — not reverse-engineered.
- No streaming/WebSocket transport was observed; the live chart just polls `/api/m/range`.

## How to verify changes

There's no automated test suite (yet). The pattern used throughout this project's history, and what you should do before claiming something works:

1. `npm run build` and check for type errors.
2. Spawn the built server and drive it over stdio JSON-RPC directly (see git history / commit messages for the exact `node -e "..."` harness used — spawn `dist/index.js`, send `initialize`, `notifications/initialized`, then `tools/call`, and assert on the real response).
3. For client/catalog changes, also sanity-check against the **live** `https://velo.xyz/api/m/range` endpoint directly with `curl`/`fetch` before updating `catalog.ts` claims — don't infer from the minified bundle alone when you can confirm live.
4. If it's registered as an MCP server in `~/.cursor/mcp.json` (entry: `velo` → `node /home/jim/development/velo-mcp/dist/index.js`), note that a running Cursor session won't pick up code changes until the MCP connection is reloaded/restarted — rebuilding `dist/` alone isn't enough for *this* session's already-spawned process.

## Conventions

- Keep `catalog.ts` free of network calls — it's pure static data/logic, safe to import from both the server and the CLI without side effects.
- When you discover new live-confirmed API behavior, update `catalog.ts`'s comments/constants (the "source of truth") and this file's gotchas section, not just README.md.
- Prefer fixing shared logic in `catalog.ts`/`veloClient.ts` over duplicating it in `index.ts` or `dump.ts`.
