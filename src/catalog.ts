/**
 * Reverse-engineered catalog of velo.xyz's internal chart data API.
 *
 * Everything in this file was derived by:
 *  1. Capturing XHR/fetch calls made by https://velo.xyz/chart (via CDP) while
 *     a symbol was loaded with the "Aggregated Open Interest", "Aggregated Spot
 *     Volume", and "Aggregated Volume" (Cumulative Delta) studies attached.
 *  2. Extracting the TradingView custom-study registrations
 *     (`<Velo> ...` / `@tv-basicstudies-1`) from the chart bundle
 *     (`ChartRoute.*.js`), which expose every available indicator and its
 *     configurable inputs (exchange toggles, unit, view).
 *  3. Cross-referencing the alert-creation schema at `/api/u/meta`, which
 *     independently confirms metric/unit/timeframe enums (OHLC, Volume,
 *     Liquidations, OpenInterest / Dollars, Coins / 1m..1d).
 *
 * None of this is officially documented by Velo. Treat it as best-effort and
 * expect it to break if they ship frontend changes.
 */

/**
 * Minutes-per-bar for each timeframe, used only to compute time deltas
 * (default lookback windows, pagination chunk sizes). This is NOT always
 * what gets sent as the `resolution` query param - see
 * `TIMEFRAME_TO_RESOLUTION_PARAM` below.
 */
export const TIMEFRAME_TO_MINUTES = {
  "1m": 1,
  "5m": 5,
  "15m": 15,
  "1h": 60,
  "4h": 240,
  "1d": 1440,
} as const;

export type Timeframe = keyof typeof TIMEFRAME_TO_MINUTES;

/**
 * Live-confirmed: `resolution` accepts plain minute counts for intraday
 * timeframes (1, 5, 15, 60, 240), but daily bars require the literal string
 * `"1D"` - `resolution=1440` always 400s, even for a single-day window.
 */
export const TIMEFRAME_TO_RESOLUTION_PARAM: Record<Timeframe, string> = {
  "1m": "1",
  "5m": "5",
  "15m": "15",
  "1h": "60",
  "4h": "240",
  "1d": "1D",
};

/**
 * Live-confirmed via binary search (2026-10-12): a single `/api/m/range`
 * request is capped at ~459-460 bars regardless of resolution (tested at
 * 1m/5m/15m/1h/4h) - exceeding it returns HTTP 400. This is presumably a
 * tier-based limit (the session used was tier 0 / free). We use 450 as a
 * safety margin below the observed edge for chunking.
 */
export const MAX_BARS_PER_REQUEST = 450;

/**
 * Live-confirmed via binary search (2026-10-12): historical data has a hard
 * floor at 2021-01-01T00:00:00Z across every exchange tested (Binance,
 * Bybit, OKX, Deribit, Coinbase) - it does not taper off gradually, it just
 * stops. This is Velo's own data-collection start date, not each exchange's
 * actual listing date (e.g. Binance BTCUSDT perps actually launched in Sept
 * 2019, but Velo has no data for it before 2021). Hyperliquid naturally has
 * no data this far back since it launched in 2023.
 */
export const EARLIEST_AVAILABLE_DATA = "2021-01-01T00:00:00.000Z";

/**
 * Live-confirmed via a direct A/B comparison (2026-10-12): for `spotvol`
 * (and presumably `volume`/`tape`), requesting `view=Delta`,
 * `view=Cumulative Delta`, and `view=Cumulative Delta (Candles)` all return
 * byte-identical raw per-bar delta data from `/api/m/range` - the `view`
 * segment of the compound symbol has NO effect on the server response for
 * these. The running-total line the live chart renders for "Cumulative
 * Delta" is computed client-side by the TradingView study, not by the API.
 * See `isCumulativeView` / `cumulativeSum` in veloClient.ts, which both
 * `index.ts` and `dump.ts` use to reproduce that client-side accumulation
 * so callers get data that actually matches the chart.
 */
export const CUMULATIVE_VIEWS_ARE_COMPUTED_CLIENT_SIDE = true;

/** The 8 derivatives venues combined for every "Aggregated <metric>" study
 * (open interest, volume, liquidations, funding, premium, tape). */
export const DERIVATIVES_EXCHANGES = [
  "binance-futures",
  "bybit",
  "okex-swap",
  "deribit",
  "hyperliquid",
  "binance-coin-margin",
  "bybit-coin-margin",
  "okex-coin-margin",
] as const;

/** The 4 spot venues combined for "Aggregated Spot Volume" / "Aggregated Spot
 * Tape". */
export const SPOT_EXCHANGES = ["binance", "coinbase", "bybit-spot", "okex"] as const;

/** The 5 venues used by "Cross Exchange Funding" (no Hyperliquid coin-margin
 * duplicates since it's comparing per-exchange funding, not summing it). */
export const CROSS_EXCHANGE_FUNDING_EXCHANGES = [
  "binance-futures",
  "bybit",
  "okex-swap",
  "deribit",
  "hyperliquid",
] as const;

export type Exchange = string;

/** The `metric` segment of the compound `symbol` query param, i.e.
 * `<ticker>#<exchange...>#<metric>#aggregated#<unit>#<view>`. */
export type Metric =
  | "open_interest"
  | "volume"
  | "spotvol"
  | "liquidations"
  | "funding_rate"
  | "cross_exchange_funding"
  | "premium"
  | "tape"
  | "spottape";

export type Unit = "Dollars" | "Coins";

/**
 * Full indicator registry extracted from the TradingView custom-study
 * metadata (`description: "<Velo> ..."`). `metric` / `defaultExchanges` are
 * only populated for indicators backed by the `/api/m/range` compound-symbol
 * endpoint; the price-derived overlays (Moving Average, Realized Vol,
 * Returns, Total Return) are computed client-side from plain OHLC and have
 * no separate metric.
 *
 * `views` marked (untested) were discovered in the study's input options but
 * we have only live-confirmed the API response shape for "Candles" (OI) and
 * "Cumulative Delta" (volume/spot volume) - see README for verified shapes.
 */
export interface IndicatorDef {
  /** TradingView study id, useful only for cross-referencing the bundle. */
  studyId: string;
  /** Display name as shown in the "Indicators" picker. */
  name: string;
  /** Whether this is the cross-exchange "Aggregated" variant. */
  aggregated: boolean;
  metric?: Metric;
  defaultExchanges?: readonly string[];
  units?: Unit[];
  views: string[];
  notes?: string;
}

export const INDICATORS: IndicatorDef[] = [
  // ---- price-derived overlays (no metric; computed from OHLC close) ----
  {
    studyId: "avg",
    name: "Moving Average",
    aggregated: false,
    views: ["Simple", "Exponential", "OIWAP", "VWAP"],
    notes: "Window + optional std-dev bands. Computed from price, not a separate API metric.",
  },
  {
    studyId: "realizedvol",
    name: "Realized Vol",
    aggregated: false,
    views: ["Standard"],
    notes: "Window only. Computed from price returns.",
  },
  {
    studyId: "returns",
    name: "Returns",
    aggregated: false,
    units: ["Dollars"],
    views: ["(%)", "($)"],
    notes: "Window + %/$ measure. Computed from price.",
  },
  {
    studyId: "tr",
    name: "Total Return",
    aggregated: false,
    views: ["Standard"],
    notes: "No configurable inputs.",
  },

  // ---- single-exchange metrics (use the chart's own exchange) ----
  {
    studyId: "open-interest",
    name: "Open Interest",
    aggregated: false,
    metric: "open_interest",
    units: ["Coins", "Dollars"],
    views: ["Candles", "Change", "Change (%)"],
  },
  {
    studyId: "new-Volume",
    name: "Volume",
    aggregated: false,
    metric: "volume",
    units: ["Coins", "Dollars"],
    views: ["Standard", "Delta", "Cumulative Delta", "Cumulative Delta (Candles)"],
  },
  {
    studyId: "new-liquidations",
    name: "Liquidations",
    aggregated: false,
    metric: "liquidations",
    units: ["Coins", "Dollars"],
    views: ["Standard", "Liquidation Count", "Long Only", "Short Only", "Stacked"],
    notes: "Also supports sound alerts (None/Hitmarker/Bonk/8bit/Pop) + threshold - UI only, not an API param.",
  },
  {
    studyId: "funding-rate",
    name: "Funding",
    aggregated: false,
    metric: "funding_rate",
    views: ["Average", "Close"],
    notes: 'Measure: Rate (%) / Total Spend Rate ($) / Total Spend Rate (Coins). Scaled per 1h/8h/24h/Annum.',
  },
  {
    studyId: "premium",
    name: "Premium",
    aggregated: false,
    metric: "premium",
    views: ["Close", "Average"],
    notes: "Measure (%)/($), plus moving-average window.",
  },
  {
    studyId: "coinbase-premium",
    name: "Coinbase Premium",
    aggregated: false,
    metric: "premium",
    defaultExchanges: ["coinbase"],
    views: ["(%)", "($)"],
    notes: "Premium pinned to Coinbase specifically.",
  },
  {
    studyId: "tape",
    name: "Tape",
    aggregated: false,
    metric: "tape",
    views: ["Trade Count", "Speed (tpm)", "Trade Delta", "Cumulative Trade Delta"],
  },

  // ---- aggregated (cross-exchange sum) metrics ----
  {
    studyId: "aggregated-open-interest",
    name: "Aggregated Open Interest",
    aggregated: true,
    metric: "open_interest",
    defaultExchanges: DERIVATIVES_EXCHANGES,
    units: ["Coins", "Dollars"],
    views: ["Candles", "Change", "Change (%)"],
  },
  {
    studyId: "new-aggregated-Volume",
    name: "Aggregated Volume",
    aggregated: true,
    metric: "volume",
    defaultExchanges: DERIVATIVES_EXCHANGES,
    units: ["Coins", "Dollars"],
    views: ["Standard", "Delta", "Cumulative Delta", "Cumulative Delta (Candles)"],
  },
  {
    studyId: "new-aggregated-spot-volume",
    name: "Aggregated Spot Volume",
    aggregated: true,
    metric: "spotvol",
    defaultExchanges: SPOT_EXCHANGES,
    units: ["Coins", "Dollars"],
    views: ["Standard", "Delta", "Cumulative Delta", "Cumulative Delta (Candles)"],
  },
  {
    studyId: "new-aggregated-liquidations",
    name: "Aggregated Liquidations",
    aggregated: true,
    metric: "liquidations",
    defaultExchanges: DERIVATIVES_EXCHANGES,
    units: ["Coins", "Dollars"],
    views: ["Standard", "Liquidation Count", "Long Only", "Short Only", "Stacked"],
  },
  {
    studyId: "aggregated-funding-rate",
    name: "Aggregated Funding",
    aggregated: true,
    metric: "funding_rate",
    defaultExchanges: DERIVATIVES_EXCHANGES,
    views: ["Average", "Close"],
    notes:
      'Measure: Rate (%) / Total Spend Rate ($) / Total Spend Rate (Coins). Aggregation: Average or Open-Interest-Weighted. Scaled per 1h/8h/24h/Annum.',
  },
  {
    studyId: "aggregated-premium",
    name: "Aggregated Premium",
    aggregated: true,
    metric: "premium",
    defaultExchanges: DERIVATIVES_EXCHANGES,
    views: ["Close", "Average"],
    notes: "Measure (%)/($); Aggregation Average/OI-Weighted; moving-average window.",
  },
  {
    studyId: "cross-exchange-funding",
    name: "Cross Exchange Funding",
    aggregated: true,
    metric: "cross_exchange_funding",
    defaultExchanges: CROSS_EXCHANGE_FUNDING_EXCHANGES,
    views: ["Average", "Close"],
    notes: "Plots one funding-rate line per exchange rather than summing them.",
  },
  {
    studyId: "aggregated-tape",
    name: "Aggregated Tape",
    aggregated: true,
    metric: "tape",
    defaultExchanges: DERIVATIVES_EXCHANGES,
    views: ["Trade Count", "Speed (tpm)", "Trade Delta", "Cumulative Trade Delta"],
  },
  {
    studyId: "aggregated-spot-tape",
    name: "Aggregated Spot Tape",
    aggregated: true,
    metric: "spottape",
    defaultExchanges: SPOT_EXCHANGES,
    views: ["Trade Count", "Speed (tpm)", "Trade Delta", "Cumulative Trade Delta"],
  },
];

export function findIndicator(nameOrStudyId: string): IndicatorDef | undefined {
  const needle = nameOrStudyId.trim().toLowerCase();
  return INDICATORS.find(
    (i) => i.studyId.toLowerCase() === needle || i.name.toLowerCase() === needle
  );
}

export const ALL_METRICS: Metric[] = [
  "open_interest",
  "volume",
  "spotvol",
  "liquidations",
  "funding_rate",
  "cross_exchange_funding",
  "premium",
  "tape",
  "spottape",
];

/** Standard exchange set Velo's own "Aggregated"/cross-exchange studies
 * combine for a given metric, used as the default when a caller doesn't
 * specify `exchanges` explicitly. */
export function defaultExchangesForMetric(metric: Metric): readonly string[] {
  if (metric === "spotvol" || metric === "spottape") return SPOT_EXCHANGES;
  if (metric === "cross_exchange_funding") return CROSS_EXCHANGE_FUNDING_EXCHANGES;
  return DERIVATIVES_EXCHANGES;
}

/** The chart view this metric is typically displayed with, used as the
 * default when a caller doesn't specify `view` explicitly. */
export function defaultViewForMetric(metric: Metric): string {
  switch (metric) {
    case "open_interest":
      return "Candles";
    case "volume":
    case "spotvol":
      return "Cumulative Delta";
    case "liquidations":
      return "Standard";
    case "funding_rate":
    case "cross_exchange_funding":
    case "premium":
      return "Average";
    case "tape":
    case "spottape":
      return "Trade Count";
  }
}
