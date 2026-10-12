import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";

import {
  DERIVATIVES_EXCHANGES,
  SPOT_EXCHANGES,
  INDICATORS,
  TIMEFRAME_TO_MINUTES,
  MAX_BARS_PER_REQUEST,
  EARLIEST_AVAILABLE_DATA,
  type Metric,
  type Unit,
} from "./catalog.js";
import { buildCompoundSymbol, fetchRange, normalizeRows } from "./veloClient.js";

const TIMEFRAMES = Object.keys(TIMEFRAME_TO_MINUTES) as [string, ...string[]];
const METRICS: [Metric, ...Metric[]] = [
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
const UNITS: [Unit, ...Unit[]] = ["Dollars", "Coins"];

function defaultExchangesFor(metric: Metric): readonly string[] {
  if (metric === "spotvol" || metric === "spottape") return SPOT_EXCHANGES;
  return DERIVATIVES_EXCHANGES;
}

function defaultViewFor(metric: Metric): string {
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
            notes:
              "velo_get_price and velo_get_indicator auto-paginate transparently when a requested range exceeds maxBarsPerRequest, up to a safety cap of 50 chunked requests per call. Data does not exist before earliestAvailableData for any exchange/symbol.",
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
      "Fetch a Velo chart indicator series (open interest, volume, spot volume, liquidations, funding, premium, or tape), optionally aggregated across multiple exchanges, from velo.xyz's internal chart data API. Call velo_list_indicators first to see valid metric/view/exchange combinations. Only metric=open_interest with view=Candles, and metric in {volume, spotvol} with view='Cumulative Delta', have been live-verified; other view values are inferred from the frontend and may need adjustment.",
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
    const resolvedExchanges = exchanges ?? defaultExchangesFor(metric as Metric);
    const resolvedView = view ?? defaultViewFor(metric as Metric);

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
    const series = normalizeRows(raw.arr);

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

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("velo-mcp fatal error:", err);
  process.exit(1);
});
