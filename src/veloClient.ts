import {
  TIMEFRAME_TO_MINUTES,
  TIMEFRAME_TO_RESOLUTION_PARAM,
  MAX_BARS_PER_REQUEST,
  EARLIEST_AVAILABLE_DATA,
  Timeframe,
  Unit,
  Metric,
} from "./catalog.js";

const RANGE_URL = "https://velo.xyz/api/m/range";

export interface RangeResponse {
  begin: string;
  end: string;
  arr: number[][];
}

export interface Candle {
  time: number; // epoch seconds
  timeISO: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface Point {
  time: number; // epoch seconds
  timeISO: string;
  value: number;
}

/**
 * Builds the compound `symbol` query param used for every non-price study,
 * e.g. `NEARUSDT#binance-futures#bybit#...#open_interest#aggregated#Dollars#Candles`.
 *
 * Confirmed live against velo.xyz/chart for metric=open_interest (view
 * "Candles"), metric=spotvol and metric=volume (view "Cumulative Delta").
 * Other metric/view combinations are inferred from the frontend's TradingView
 * study registrations (see catalog.ts) but not individually live-tested.
 */
export function buildCompoundSymbol(params: {
  ticker: string;
  exchanges: readonly string[];
  metric: Metric;
  unit: Unit;
  view: string;
}): string {
  const { ticker, exchanges, metric, unit, view } = params;
  return [ticker, ...exchanges, metric, "aggregated", unit, view].join("#");
}

function toEpochMs(value: number | string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value === "number") return value;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid date/time value: ${value}`);
  }
  return parsed;
}

async function fetchSingleRange(args: {
  exchange: string;
  symbol: string;
  resolutionParam: string;
  beginMs: number;
  endMs: number;
}): Promise<RangeResponse> {
  const url = new URL(RANGE_URL);
  url.searchParams.set("exchange", args.exchange);
  url.searchParams.set("symbol", args.symbol);
  url.searchParams.set("resolution", args.resolutionParam);
  url.searchParams.set("begin", String(args.beginMs));
  url.searchParams.set("end", String(args.endMs));

  const res = await fetch(url.toString(), {
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Velo API request failed (${res.status} ${res.statusText}) for ${url.toString()}: ${body.slice(0, 500)}`
    );
  }
  return (await res.json()) as RangeResponse;
}

export interface FetchRangeArgs {
  /** Anchor exchange. For plain price queries this is the exchange the
   * candle is actually sourced from. For compound (aggregated) symbol
   * queries it appears to just tag the request; the real exchange list
   * lives inside the `symbol` param. */
  exchange: string;
  symbol: string;
  timeframe: Timeframe;
  /** epoch ms or ISO date string. Defaults to `timeframe * defaultBars` ago. */
  begin?: number | string;
  /** epoch ms or ISO date string. Defaults to now. */
  end?: number | string;
  /** Number of bars to default `begin` to, when `begin` is omitted. Default 300. */
  defaultBars?: number;
  /** Safety limit on how many chunked requests a single call may fan out
   * into before erroring. Default 50 (~50 * 450 = 22,500 bars). */
  maxChunks?: number;
}

/**
 * Fetches a time range from `/api/m/range`, transparently paginating across
 * multiple requests if the range exceeds the live-confirmed ~459-460
 * bar-per-request cap (see MAX_BARS_PER_REQUEST in catalog.ts). Results are
 * merged, deduplicated by timestamp (chunk boundaries can overlap by one
 * bar), and sorted ascending.
 */
export async function fetchRange(args: FetchRangeArgs): Promise<RangeResponse> {
  const resolutionMinutes = TIMEFRAME_TO_MINUTES[args.timeframe];
  const resolutionParam = TIMEFRAME_TO_RESOLUTION_PARAM[args.timeframe];
  if (!resolutionMinutes || !resolutionParam) {
    throw new Error(
      `Unknown timeframe "${args.timeframe}". Valid: ${Object.keys(TIMEFRAME_TO_MINUTES).join(", ")}`
    );
  }

  const now = Date.now();
  const endMs = toEpochMs(args.end, now);
  const defaultBars = args.defaultBars ?? 300;
  let beginMs = toEpochMs(args.begin, endMs - resolutionMinutes * 60_000 * defaultBars);

  const earliestMs = Date.parse(EARLIEST_AVAILABLE_DATA);
  if (beginMs < earliestMs) {
    beginMs = earliestMs; // Velo has no data before this regardless of symbol/exchange.
  }
  if (beginMs >= endMs) {
    return { begin: new Date(beginMs).toISOString(), end: new Date(endMs).toISOString(), arr: [] };
  }

  const chunkMs = MAX_BARS_PER_REQUEST * resolutionMinutes * 60_000;
  const totalMs = endMs - beginMs;
  const numChunks = Math.max(1, Math.ceil(totalMs / chunkMs));

  const maxChunks = args.maxChunks ?? 50;
  if (numChunks > maxChunks) {
    throw new Error(
      `Requested range (${new Date(beginMs).toISOString()} .. ${new Date(endMs).toISOString()}) at ${args.timeframe} ` +
        `would require ${numChunks} chunked requests (cap: ${maxChunks}, ~${MAX_BARS_PER_REQUEST} bars/request). ` +
        `Narrow the begin/end range or use a coarser timeframe.`
    );
  }

  if (numChunks === 1) {
    return fetchSingleRange({ exchange: args.exchange, symbol: args.symbol, resolutionParam, beginMs, endMs });
  }

  const windows: Array<{ begin: number; end: number }> = [];
  for (let i = 0; i < numChunks; i++) {
    const cBegin = beginMs + i * chunkMs;
    const cEnd = Math.min(beginMs + (i + 1) * chunkMs, endMs);
    windows.push({ begin: cBegin, end: cEnd });
  }

  const CONCURRENCY = 5;
  const results: RangeResponse[] = new Array(windows.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < windows.length) {
      const i = nextIndex++;
      results[i] = await fetchSingleRange({
        exchange: args.exchange,
        symbol: args.symbol,
        resolutionParam,
        beginMs: windows[i].begin,
        endMs: windows[i].end,
      });
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, windows.length) }, worker));

  const byTime = new Map<number, number[]>();
  for (const chunk of results) {
    for (const row of chunk.arr) byTime.set(row[0], row);
  }
  const arr = Array.from(byTime.values()).sort((a, b) => a[0] - b[0]);

  return {
    begin: new Date(beginMs).toISOString(),
    end: new Date(endMs).toISOString(),
    arr,
  };
}

/** Normalizes the raw `arr` rows into typed candles (5-6 columns) or plain
 * time/value points (2 columns), based on row width. */
export function normalizeRows(arr: number[][]): Candle[] | Point[] {
  if (arr.length === 0) return [];
  const width = arr[0].length;

  if (width >= 5) {
    return arr.map((row) => {
      const [time, open, high, low, close, volume] = row;
      const candle: Candle = {
        time,
        timeISO: new Date(time * 1000).toISOString(),
        open,
        high,
        low,
        close,
      };
      if (width >= 6) candle.volume = volume;
      return candle;
    });
  }

  return arr.map((row) => {
    const [time, value] = row;
    const point: Point = {
      time,
      timeISO: new Date(time * 1000).toISOString(),
      value,
    };
    return point;
  });
}
