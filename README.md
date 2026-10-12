# velo-mcp

An **unofficial** MCP server exposing [velo.xyz](https://velo.xyz)'s internal chart data API — reverse-engineered by capturing network traffic from the `/chart` page and extracting the TradingView custom-study registrations from its frontend bundle. Not affiliated with or endorsed by Velo. No auth required for the endpoints used here, but treat this as fragile: it can break any time Velo changes their frontend.

## Tools

- **`velo_list_indicators`** — returns the full reverse-engineered catalog: every indicator available on the Velo chart, its default exchange set, unit options (Dollars/Coins), and valid "view" styles. Call this first.
- **`velo_get_price`** — OHLCV price candles for `ticker` on a single `exchange`.
- **`velo_get_indicator`** — a metric series (open interest, volume, spot volume, liquidations, funding, premium, cross-exchange funding, or tape), optionally aggregated across multiple exchanges.

## Install / run

```bash
npm install
npm run build
npm start        # runs dist/index.js over stdio
```

Point an MCP client (Claude Desktop, Cursor, etc.) at `node /path/to/velo-mcp/dist/index.js`.

## Dump script

A standalone CLI for pulling data to a file without going through MCP, reusing the same client/catalog code:

```bash
npm run dump -- --ticker <TICKER> --timeframe <1m|5m|15m|1h|4h|1d> --lookback <duration|ISO date> \
  [--indicator <name-or-metric>] [--view <view>] [--unit Dollars|Coins] \
  [--exchange <anchor-exchange>] [--exchanges ex1,ex2,...] [--format csv|json] [--out <path>]
```

`--lookback` accepts `<number><unit>` with unit in `{h, d, w, mo, y}` (e.g. `90d`, `6mo`, `1y`), or a plain ISO date to use as the begin time directly. `--indicator` accepts a catalog display name (`"Aggregated Open Interest"`), a study id (`aggregated-open-interest`), or a raw metric key (`open_interest`, `volume`, etc.) — omit it to dump plain OHLCV price. Output defaults to `dumps/velo-<ticker>-<metric>-<timeframe>-<timestamp>.csv`, created automatically; `dumps/` is gitignored.

Examples:

```bash
npm run dump -- --ticker BTCUSDT --timeframe 1h --lookback 90d
npm run dump -- --ticker NEARUSDT --timeframe 5m --lookback 7d --indicator "Aggregated Open Interest"
npm run dump -- --ticker NEARUSDT --timeframe 1h --lookback 1y --indicator volume --view "Cumulative Delta" --unit Coins
npm run dump -- --ticker NEARUSDT --timeframe 5m --lookback 2d --indicator premium --exchange coinbase
npm run dump -- --list-indicators
```

Price-derived overlays with no separate API metric (Moving Average, Realized Vol, Returns, Total Return) aren't supported as `--indicator` values — you'll get a clear error pointing you to drop `--indicator` and compute them from the dumped price series yourself.

## How the underlying API works

Everything hangs off one endpoint:

```
GET https://velo.xyz/api/m/range?exchange=<exchange>&symbol=<symbol>&resolution=<minutes>&begin=<epochMs>&end=<epochMs>
```

Response shape:

```json
{ "begin": "2026-10-11T...Z", "end": "2026-10-12T...Z", "arr": [[...], ...] }
```

`arr` row timestamps are **epoch seconds** (request params are epoch **ms**). Row width tells you what you got:

| width | shape |
|---|---|
| 6 | `[time, open, high, low, close, volume]` — price candles |
| 5 | `[time, open, high, low, close]` — e.g. Open Interest "Candles" view |
| 2 | `[time, value]` — single-line series, e.g. "Cumulative Delta" |

### Plain price query

`symbol` is just the ticker, e.g. `NEARUSDT`.

### Compound/aggregated indicator query

`symbol` becomes a `#`-joined (percent-encoded as `%23`) chain:

```
<ticker>#<exchange1>#<exchange2>#...#<metric>#aggregated#<unit>#<view>
```

- **metric**: `open_interest`, `volume`, `spotvol`, `liquidations`, `funding_rate`, `cross_exchange_funding`, `premium`, `tape`, `spottape`
- **unit**: `Dollars` | `Coins`
- **view**: depends on metric — `Candles`, `Standard`, `Delta`, `Cumulative Delta`, `Cumulative Delta (Candles)`, `Change`, `Change (%)`, `Average`, `Close`, `Liquidation Count`, `Long Only`, `Short Only`, `Stacked`, `Trade Count`, `Speed (tpm)`, `Trade Delta`, `Cumulative Trade Delta`

Exchange groups actually used by Velo's own "Aggregated" studies:

- **Derivatives (8)**: `binance-futures`, `bybit`, `okex-swap`, `deribit`, `hyperliquid`, `binance-coin-margin`, `bybit-coin-margin`, `okex-coin-margin`
- **Spot (4)**: `binance`, `coinbase`, `bybit-spot`, `okex`
- **Cross Exchange Funding (5)**: the 5 non-coin-margin derivatives venues above

### Timeframe → resolution

| timeframe | `resolution` query value |
|---|---|
| 1m | `1` |
| 5m | `5` |
| 15m | `15` |
| 1h | `60` |
| 4h | `240` |
| 1d | **`1D`** (literal string — `1440` always returns 400, even for a 1-day window) |

### Per-request limits (live-confirmed, tier 0 / free account)

- **Max ~459–460 bars per request**, regardless of resolution — confirmed via binary search at 1m/5m/15m/1h/4h. Exceeding it returns HTTP 400 with an empty body. This is exactly why the live chart issues several chunked requests on initial load instead of one. `velo_get_price` / `velo_get_indicator` handle this transparently: `fetchRange()` auto-splits any range bigger than `MAX_BARS_PER_REQUEST` (450, set with a safety margin) into multiple concurrent requests, merges, dedupes by timestamp, and sorts — callers never see a 400 from this. There's a safety cap of 50 chunks (~22,500 bars) per call to stop an LLM from accidentally triggering thousands of requests; past that it throws a clear error asking you to narrow the range or use a coarser timeframe.
- **Historical floor: `2021-01-01T00:00:00Z`**, platform-wide — binary-searched backward from "now" and found data stops dead at that exact timestamp on every exchange tested (Binance, Bybit, OKX, Deribit, Coinbase), not a gradual taper. This is Velo's own data-collection start date, unrelated to when each exchange/instrument actually launched (e.g. real Binance BTCUSDT perp history goes back to Sept 2019, but Velo has none of it before 2021-01-01). Hyperliquid naturally has nothing this far back since it launched in 2023. `fetchRange()` silently clamps any `begin` earlier than this floor rather than erroring.

## Verification status

Live-tested against the running chart:

- Price candles (plain symbol)
- `open_interest` + `Candles` view
- `volume` + `Cumulative Delta` view
- `spotvol` + `Cumulative Delta` view

All other metric/view combinations in `src/catalog.ts` are inferred from the TradingView custom-study `inputs` metadata in the frontend bundle (which view options exist per indicator) but haven't been individually confirmed to produce a sensible `arr` shape. If you hit something that looks wrong, that's the likely culprit — open the chart, add the matching indicator, and recapture the request to confirm/correct `src/catalog.ts`.

## Not covered (yet)

The frontend also calls several endpoints this server doesn't touch:

- `/api/a/*` (profile, session, status, layouts) — account/session stuff, requires auth
- Market screener (futures/options/spot table on `/chart`, `/futures/:ticker`, `/market`) — not reverse-engineered
- Options chain data
- Any WebSocket/streaming channel for live updates (the chart appeared to poll `/api/m/range`, no streaming transport was observed)

## Disclaimer

This talks to an **undocumented, internal** API by reverse-engineering the public chart frontend. It is not an official Velo product or SDK. Use at your own risk; expect breakage; respect velo.xyz's terms of service.
