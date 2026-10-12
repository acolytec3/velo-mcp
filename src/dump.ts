#!/usr/bin/env node
/**
 * Standalone CLI for dumping Velo price/indicator history to a file, without
 * going through the MCP server. Reuses the same reverse-engineered client
 * (veloClient.ts) and indicator catalog (catalog.ts) as the MCP tools.
 *
 * Usage:
 *   npm run dump -- --ticker <TICKER> --timeframe <1m|5m|15m|1h|4h|1d> --lookback <duration|ISO date> \
 *     [--indicator <name-or-metric>] [--view <view>] [--unit Dollars|Coins] \
 *     [--exchange <anchor-exchange>] [--exchanges ex1,ex2,...] [--format csv|json] [--out <path>]
 *
 * Examples:
 *   npm run dump -- --ticker BTCUSDT --timeframe 1h --lookback 90d
 *   npm run dump -- --ticker NEARUSDT --timeframe 5m --lookback 7d --indicator "Aggregated Open Interest"
 *   npm run dump -- --ticker NEARUSDT --timeframe 1h --lookback 1y --indicator volume --view "Cumulative Delta" --unit Coins
 *   npm run dump -- --ticker NEARUSDT --timeframe 5m --lookback 2d --indicator premium --exchange coinbase
 *   npm run dump -- --list-indicators
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  TIMEFRAME_TO_MINUTES,
  INDICATORS,
  ALL_METRICS,
  findIndicator,
  defaultExchangesForMetric,
  defaultViewForMetric,
  type Timeframe,
  type Metric,
  type Unit,
} from "./catalog.js";
import { buildCompoundSymbol, fetchRange, normalizeRows, type Candle, type Point } from "./veloClient.js";

interface ParsedArgs {
  ticker: string;
  timeframe: Timeframe;
  lookback: string;
  indicator?: string;
  view?: string;
  unit: Unit;
  exchange: string;
  exchanges?: string[];
  format: "csv" | "json";
  out?: string;
}

function printUsageAndExit(message?: string): never {
  if (message) console.error(`Error: ${message}\n`);
  console.error(`Usage:
  npm run dump -- --ticker <TICKER> --timeframe <1m|5m|15m|1h|4h|1d> --lookback <duration|ISO date> \\
    [--indicator <name-or-metric>] [--view <view>] [--unit Dollars|Coins] \\
    [--exchange <anchor-exchange>] [--exchanges ex1,ex2,...] [--format csv|json] [--out <path>]

--lookback accepts "<number><unit>" with unit in {h, d, w, mo, y} (e.g. "90d", "6mo", "1y"),
or a plain ISO date (e.g. "2024-01-01") to use as the begin time directly.

--indicator accepts either a catalog display name ("Aggregated Open Interest"),
a study id ("aggregated-open-interest"), or a raw metric key (${ALL_METRICS.join(", ")}).
Omit --indicator to dump plain OHLCV price instead.

Examples:
  npm run dump -- --ticker BTCUSDT --timeframe 1h --lookback 90d
  npm run dump -- --ticker NEARUSDT --timeframe 5m --lookback 7d --indicator "Aggregated Open Interest"
  npm run dump -- --ticker NEARUSDT --timeframe 1h --lookback 1y --indicator volume --view "Cumulative Delta" --unit Coins
  npm run dump -- --ticker NEARUSDT --timeframe 5m --lookback 2d --indicator premium --exchange coinbase
  npm run dump -- --list-indicators
`);
  process.exit(1);
}

function parseArgs(argv: string[]): ParsedArgs {
  const map = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      map.set(key, "true");
    } else {
      map.set(key, next);
      i++;
    }
  }

  if (map.has("list-indicators")) {
    console.log(JSON.stringify(INDICATORS, null, 2));
    process.exit(0);
  }

  if (map.has("help")) printUsageAndExit();

  const ticker = map.get("ticker");
  const timeframe = map.get("timeframe");
  const lookback = map.get("lookback");

  if (!ticker) printUsageAndExit("--ticker is required");
  if (!timeframe || !(timeframe in TIMEFRAME_TO_MINUTES)) {
    printUsageAndExit(`--timeframe is required and must be one of ${Object.keys(TIMEFRAME_TO_MINUTES).join(", ")}`);
  }
  if (!lookback) printUsageAndExit("--lookback is required (e.g. 30d, 6mo, 1y, or an ISO date)");

  const exchangesRaw = map.get("exchanges");

  return {
    ticker,
    timeframe: timeframe as Timeframe,
    lookback,
    indicator: map.get("indicator"),
    view: map.get("view"),
    unit: (map.get("unit") as Unit) || "Dollars",
    exchange: map.get("exchange") || "binance-futures",
    exchanges: exchangesRaw ? exchangesRaw.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
    format: (map.get("format") as "csv" | "json") || "csv",
    out: map.get("out"),
  };
}

const DURATION_RE = /^(\d+(?:\.\d+)?)(mo|[hdwy])$/i;
const MS_PER_UNIT: Record<string, number> = {
  h: 3_600_000,
  d: 86_400_000,
  w: 7 * 86_400_000,
  mo: 30 * 86_400_000,
  y: 365 * 86_400_000,
};

function parseLookbackToBeginMs(lookback: string, endMs: number): number {
  const trimmed = lookback.trim();
  const durationMatch = DURATION_RE.exec(trimmed);
  if (durationMatch) {
    const amount = parseFloat(durationMatch[1]);
    const unit = durationMatch[2].toLowerCase();
    return endMs - amount * MS_PER_UNIT[unit];
  }
  const asDate = Date.parse(trimmed);
  if (!Number.isNaN(asDate)) return asDate;
  throw new Error(
    `Could not parse --lookback "${lookback}". Use "<number>h|d|w|mo|y" (e.g. "90d", "6mo", "1y") or an ISO date (e.g. "2024-01-01").`
  );
}

function resolveMetric(indicatorArg: string): { metric: Metric; label: string } {
  const def = findIndicator(indicatorArg);
  if (def) {
    if (!def.metric) {
      throw new Error(
        `"${indicatorArg}" (${def.name}) is a price-derived overlay (computed client-side from OHLC) with no separate API metric - not supported by this dump script. Omit --indicator to dump plain price instead.`
      );
    }
    return { metric: def.metric, label: def.name };
  }
  if ((ALL_METRICS as string[]).includes(indicatorArg)) {
    return { metric: indicatorArg as Metric, label: indicatorArg };
  }
  throw new Error(`Unknown indicator "${indicatorArg}". Run with --list-indicators to see options.`);
}

function isCandle(row: Candle | Point): row is Candle {
  return "open" in row;
}

function toCsv(rows: (Candle | Point)[]): string {
  if (rows.length === 0) return "";
  if (isCandle(rows[0])) {
    const header = "time,timeISO,open,high,low,close,volume";
    const lines = (rows as Candle[]).map((r) =>
      [r.time, r.timeISO, r.open, r.high, r.low, r.close, r.volume ?? ""].join(",")
    );
    return [header, ...lines].join("\n") + "\n";
  }
  const header = "time,timeISO,value";
  const lines = (rows as Point[]).map((r) => [r.time, r.timeISO, r.value].join(","));
  return [header, ...lines].join("\n") + "\n";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const endMs = Date.now();
  const beginMs = parseLookbackToBeginMs(args.lookback, endMs);
  if (beginMs >= endMs) printUsageAndExit(`--lookback "${args.lookback}" resolves to a begin time in the future`);

  let symbol: string;
  let exchangesUsed: readonly string[] | undefined;
  let viewUsed: string | undefined;
  let metricLabel = "price";

  if (args.indicator) {
    const { metric, label } = resolveMetric(args.indicator);
    metricLabel = label;
    exchangesUsed = args.exchanges ?? defaultExchangesForMetric(metric);
    viewUsed = args.view ?? defaultViewForMetric(metric);
    symbol = buildCompoundSymbol({ ticker: args.ticker, exchanges: exchangesUsed, metric, unit: args.unit, view: viewUsed });
  } else {
    symbol = args.ticker;
  }

  console.error(
    `Fetching ${args.ticker} ${metricLabel}${viewUsed ? ` (${viewUsed})` : ""} @ ${args.timeframe} ` +
      `from ${new Date(beginMs).toISOString()} to ${new Date(endMs).toISOString()}...`
  );

  const raw = await fetchRange({
    exchange: args.exchange,
    symbol,
    timeframe: args.timeframe,
    begin: beginMs,
    end: endMs,
  });
  const rows = normalizeRows(raw.arr);

  console.error(
    `Got ${rows.length} rows (server range ${raw.begin} .. ${raw.end}).` +
      (rows.length === 0 ? " No data - check the ticker/exchange/indicator combination." : "")
  );

  const safeMetric = metricLabel.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const defaultName = `velo-${args.ticker}-${safeMetric}-${args.timeframe}-${stamp}.${args.format}`;
  const outPath = resolve(args.out || `dumps/${defaultName}`);
  mkdirSync(dirname(outPath), { recursive: true });

  const content =
    args.format === "json"
      ? JSON.stringify(
          {
            ticker: args.ticker,
            indicator: args.indicator ? metricLabel : undefined,
            metric: args.indicator ? (resolveMetric(args.indicator).metric) : undefined,
            exchange: args.exchange,
            exchanges: exchangesUsed,
            unit: args.indicator ? args.unit : undefined,
            view: viewUsed,
            timeframe: args.timeframe,
            symbolQueryParam: symbol,
            begin: raw.begin,
            end: raw.end,
            rows,
          },
          null,
          2
        )
      : toCsv(rows);

  writeFileSync(outPath, content);
  console.error(`Wrote ${rows.length} rows to ${outPath}`);
}

main().catch((err) => {
  console.error("dump failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
