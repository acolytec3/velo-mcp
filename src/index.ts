import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";

import {
  DERIVATIVES_EXCHANGES,
  SPOT_EXCHANGES,
  INDICATORS,
  TIMEFRAME_TO_MINUTES,
  MAX_BARS_PER_REQUEST,
  MAX_LEVELS_BUCKETS_PER_REQUEST,
  EARLIEST_AVAILABLE_DATA,
  HEATMAP_TYPES,
  HEATMAP_COVERAGE_HINT,
  HEATMAP_ORDERBOOK_COINS,
  HEATMAP_ORDERBOOK_PRODUCTS,
  HEATMAP_HYPERLIQUID_BOOK_PRODUCTS,
  FUTURES_CATALOG_CSV_URL,
  ALL_METRICS,
  defaultExchangesForMetric,
  defaultViewForMetric,
  type Metric,
  type Unit,
  type HeatmapType,
} from "./catalog.js";
import {
  buildCompoundSymbol,
  fetchRange,
  fetchHeatmapLevels,
  normalizeRows,
  applyCumulativeIfRequested,
  isCumulativeView,
} from "./veloClient.js";

const TIMEFRAMES = Object.keys(TIMEFRAME_TO_MINUTES) as [string, ...string[]];
const METRICS = ALL_METRICS as [Metric, ...Metric[]];
const UNITS: [Unit, ...Unit[]] = ["Dollars", "Coins"];

const server = new McpServer({ name: "velo-mcp", version: "0.1.0" });

server.registerTool(
  "velo_list_indicators",
  {
    title: "List Velo indicators",
    description:
      "List every indicator available on velo.xyz's chart (reverse-engineered from the TradingView custom-study registrations), including which ones are plain-price overlays vs. backed by a metric/exchange-aggregated API query, their default exchange sets, and their valid 'view' options. Also reports the earliest available historical data and the per-request bar cap. Call this before velo_get_indicator to pick valid metric/view/unit combinations.",
    inputSchema: z.object({}),
  },
  async () => ({
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            timeframes: Object.keys(TIMEFRAME_TO_MINUTES),
            exchangeGroups: {
              derivatives: DERIVATIVES_EXCHANGES,
              spot: SPOT_EXCHANGES,
            },
            earliestAvailableData: EARLIEST_AVAILABLE_DATA,
            maxBarsPerRequest: MAX_BARS_PER_REQUEST,
            maxLevelsBucketsPerRequest: MAX_LEVELS_BUCKETS_PER_REQUEST,
            heatmapTypes: HEATMAP_TYPES,
            heatmapOrderbookCoins: HEATMAP_ORDERBOOK_COINS,
            heatmapOrderbookProducts: HEATMAP_ORDERBOOK_PRODUCTS,
            heatmapHyperliquidBookProducts: HEATMAP_HYPERLIQUID_BOOK_PRODUCTS,
            futuresCatalogCsvUrl: FUTURES_CATALOG_CSV_URL,
            heatmapCoverageHint: HEATMAP_COVERAGE_HINT,
            notes:
              "velo_get_price and velo_get_indicator auto-paginate transparently when a requested range exceeds maxBarsPerRequest, up to a safety cap of 50 chunked requests per call. velo_get_heatmap_levels uses GET /api/l/levels (chart overlay history), chunks at maxLevelsBucketsPerRequest (server hard cap 512 buckets), default maxChunks 200. Data does not exist before earliestAvailableData for any exchange/symbol.",
            indicators: INDICATORS,
          },
          null,
          2
        ),
      },
    ],
  })
);

server.registerTool(
  "velo_get_price",
  {
    title: "Get Velo price candles",
    description:
      "Fetch OHLCV price candles for a ticker on a single exchange from velo.xyz's internal chart data API (undocumented, no auth required).",
    inputSchema: z.object({
      ticker: z
        .string()
        .describe('Instrument symbol as Velo knows it, e.g. "NEARUSDT", "BTCUSDT".'),
      exchange: z
        .string()
        .default("binance-futures")
        .describe('Exchange id, e.g. "binance-futures", "bybit", "okex-swap", "deribit", "coinbase".'),
      timeframe: z.enum(TIMEFRAMES).default("5m").describe("Bar size."),
      begin: z
        .union([z.string(), z.number()])
        .optional()
        .describe("Range start as ISO date string or epoch ms. Defaults to ~300 bars before `end`."),
      end: z
        .union([z.string(), z.number()])
        .optional()
        .describe("Range end as ISO date string or epoch ms. Defaults to now."),
    }),
  },
  async ({ ticker, exchange, timeframe, begin, end }) => {
    const raw = await fetchRange({
      exchange,
      symbol: ticker,
      timeframe: timeframe as keyof typeof TIMEFRAME_TO_MINUTES,
      begin,
      end,
    });
    const candles = normalizeRows(raw.arr);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ exchange, ticker, timeframe, begin: raw.begin, end: raw.end, candles }, null, 2),
        },
      ],
    };
  }
);

server.registerTool(
  "velo_get_indicator",
  {
    title: "Get Velo aggregated indicator series",
    description:
      "Fetch a Velo chart indicator series (open interest, volume, spot volume, liquidations, funding, premium, or tape), optionally aggregated across multiple exchanges, from velo.xyz's internal chart data API. Call velo_list_indicators first to see valid metric/view/exchange combinations. Only metric=open_interest with view=Candles, and metric in {volume, spotvol} with view='Cumulative Delta', have been live-verified; other view values are inferred from the frontend and may need adjustment. Note: for any 'Cumulative ...' view, velo.xyz's raw API only ever returns per-bar delta (Delta and Cumulative Delta are byte-identical server responses) - this tool locally accumulates it into a running total so the result actually matches what the live chart displays.",
    inputSchema: z.object({
      ticker: z.string().describe('Instrument symbol, e.g. "NEARUSDT".'),
      metric: z.enum(METRICS).describe("Which indicator metric to fetch."),
      exchanges: z
        .array(z.string())
        .optional()
        .describe(
          "Exchanges to combine. Defaults to Velo's standard aggregation set for the metric (derivatives venues for most metrics, spot venues for spotvol/spottape). Pass a single exchange for a non-aggregated, single-venue series."
        ),
      unit: z.enum(UNITS).default("Dollars").describe("Dollars or Coins."),
      view: z
        .string()
        .optional()
        .describe(
          'Chart view/style, e.g. "Candles", "Standard", "Delta", "Cumulative Delta", "Cumulative Delta (Candles)", "Average", "Close". Defaults to the metric\'s typical view - see velo_list_indicators.'
        ),
      timeframe: z.enum(TIMEFRAMES).default("5m").describe("Bar size."),
      begin: z
        .union([z.string(), z.number()])
        .optional()
        .describe("Range start as ISO date string or epoch ms. Defaults to ~300 bars before `end`."),
      end: z
        .union([z.string(), z.number()])
        .optional()
        .describe("Range end as ISO date string or epoch ms. Defaults to now."),
      anchorExchange: z
        .string()
        .default("binance-futures")
        .describe("Value sent as the top-level `exchange` query param; observed to just tag the request."),
    }),
  },
  async ({ ticker, metric, exchanges, unit, view, timeframe, begin, end, anchorExchange }) => {
    const resolvedExchanges = exchanges ?? defaultExchangesForMetric(metric as Metric);
    const resolvedView = view ?? defaultViewForMetric(metric as Metric);

    const symbol = buildCompoundSymbol({
      ticker,
      exchanges: resolvedExchanges,
      metric: metric as Metric,
      unit: unit as Unit,
      view: resolvedView,
    });

    const raw = await fetchRange({
      exchange: anchorExchange,
      symbol,
      timeframe: timeframe as keyof typeof TIMEFRAME_TO_MINUTES,
      begin,
      end,
    });
    let series = normalizeRows(raw.arr);
    const cumulativeApplied = isCumulativeView(resolvedView);
    if (cumulativeApplied) series = applyCumulativeIfRequested(series, resolvedView);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              ticker,
              metric,
              exchanges: resolvedExchanges,
              unit,
              view: resolvedView,
              timeframe,
              symbolQueryParam: symbol,
              begin: raw.begin,
              end: raw.end,
              note: cumulativeApplied
                ? "velo.xyz's API returns raw per-bar delta for 'Cumulative ...' views - it does not pre-accumulate server-side. This series has been locally cumulatively summed to match what the live chart displays."
                : undefined,
              series,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.registerTool(
  "velo_get_heatmap_levels",
  {
    title: "Get Velo chart heatmap level history",
    description:
      "Fetch historical price-level heatmap data used by velo.xyz's chart overlay (orderbook depth, or Hyperliquid liquidation/TP/SL books). Uses GET /api/l/levels — not the /api/m/range indicator API. Each response is fully buffered and parsed server-side (no streaming). Requests longer than ~512 resolution buckets are auto-chunked. " +
      HEATMAP_COVERAGE_HINT,
    inputSchema: z.object({
      heatmapType: z
        .enum([...HEATMAP_TYPES] as [HeatmapType, ...HeatmapType[]])
        .default("orderbook")
        .describe("Chart heatmap layer type."),
      coin: z
        .string()
        .optional()
        .describe(
          `Aggregated orderbook only. Valid coins: ${HEATMAP_ORDERBOOK_COINS.join(", ")}. Do not combine with exchange/product.`
        ),
      exchange: z
        .string()
        .optional()
        .describe(
          'Exchange without suffix, e.g. "binance-futures", "hyperliquid". Must match a row in heatmapOrderbookProducts (see velo_list_indicators).'
        ),
      product: z
        .string()
        .optional()
        .describe(
          'Exchange-native symbol, e.g. "BTCUSDT", "BTC-USD", "xyz:GOLD" — not every *USDT perp has heatmaps (NEAR has none).'
        ),
      timeframe: z.enum(TIMEFRAMES).default("1h").describe("Bucket size (maps to reso minutes on /api/l/levels)."),
      spread: z.string().default("10").describe("Price grid step (spread query param; chart default is 10)."),
      begin: z
        .union([z.string(), z.number()])
        .optional()
        .describe("Range start as ISO date or epoch ms. Defaults to ~300 buckets before end."),
      end: z
        .union([z.string(), z.number()])
        .optional()
        .describe("Range end as ISO date or epoch ms. Defaults to now."),
      bin: z.boolean().optional().describe("If true, passes bin=1 (binned levels)."),
      slow: z.boolean().optional().describe("If true, passes slow=1."),
      maxChunks: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Safety cap on chunked HTTP requests (default 200). Raise for very long history."),
    }),
  },
  async ({ heatmapType, coin, exchange, product, timeframe, spread, begin, end, bin, slow, maxChunks }) => {
    const result = await fetchHeatmapLevels({
      heatmapType,
      coin,
      exchange,
      product,
      timeframe: timeframe as keyof typeof TIMEFRAME_TO_MINUTES,
      spread,
      begin,
      end,
      bin,
      slow,
      maxChunks,
    });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              heatmapType,
              target: coin ? { coin } : { exchange, product },
              timeframe,
              spread: result.spread,
              reso: result.reso,
              begin: result.begin,
              end: result.end,
              snapshotCount: result.snapshots.length,
              snapshots: result.snapshots,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("velo-mcp fatal error:", err);
  process.exit(1);
});
