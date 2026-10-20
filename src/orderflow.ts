import {
  DERIVATIVES_EXCHANGES,
  defaultExchangesForMetric,
  HEATMAP_ORDERBOOK_COINS,
  type Metric,
  type Timeframe,
  type Unit,
} from "./catalog.js";
import {
  buildCompoundSymbol,
  fetchRange,
  fetchHeatmapLevels,
  normalizeRows,
  applyCumulativeIfRequested,
  isCumulativeView,
  type Candle,
  type Point,
  type HeatmapSnapshot,
  type FetchRangeArgs,
} from "./veloClient.js";

export interface OrderflowBar {
  time: number;
  timeISO: string;
  open: number;
  high: number;
  low: number;
  close: number;
  candleVolume?: number;
  derivVolume?: number;
  derivVolumeDelta?: number;
  cumulativeDerivVolumeDelta?: number;
  spotVolume?: number;
  spotVolumeDelta?: number;
  tradeCount?: number;
  tradeDelta?: number;
  cumulativeTradeDelta?: number;
  liquidations?: number;
  openInterest?: number;
  fundingRate?: number;
  /** deriv volume / trade count when both are present and trade count > 0. */
  avgTradeNotional?: number;
  /** liquidations / deriv volume when both > 0. */
  liquidationToVolumeRatio?: number;
}

export interface FetchOrderflowPanelArgs {
  ticker: string;
  timeframe?: Timeframe;
  begin?: number | string;
  end?: number | string;
  unit?: Unit;
  /** Price candle exchange (plain symbol query). */
  priceExchange?: string;
  /** Override aggregation for deriv metrics; defaults per metric. */
  exchanges?: string[];
  includeSpot?: boolean;
  includeFunding?: boolean;
  includeOpenInterest?: boolean;
  /** Attach latest orderbook heatmap snapshot when ticker coin is in Velo's depth catalog. */
  includeHeatmapSnapshot?: boolean;
  maxChunks?: number;
  concurrency?: number;
  requestDelayMs?: number;
}

function tickerToCoin(ticker: string): string {
  return ticker.toUpperCase().replace(/USDT$|USD$|-PERP$/i, "");
}

function rangeArgs(
  base: FetchOrderflowPanelArgs,
  anchorExchange: string
): Pick<FetchRangeArgs, "begin" | "end" | "maxChunks" | "concurrency" | "requestDelayMs"> {
  return {
    begin: base.begin,
    end: base.end,
    maxChunks: base.maxChunks,
    concurrency: base.concurrency,
    requestDelayMs: base.requestDelayMs,
  };
}

async function fetchMetricPoints(args: {
  ticker: string;
  metric: Metric;
  view: string;
  unit: Unit;
  exchanges: readonly string[];
  anchorExchange: string;
  timeframe: Timeframe;
  panel: FetchOrderflowPanelArgs;
}): Promise<Point[]> {
  const symbol = buildCompoundSymbol({
    ticker: args.ticker,
    exchanges: args.exchanges,
    metric: args.metric,
    unit: args.unit,
    view: args.view,
  });
  const raw = await fetchRange({
    exchange: args.anchorExchange,
    symbol,
    timeframe: args.timeframe,
    ...rangeArgs(args.panel, args.anchorExchange),
  });
  let series = normalizeRows(raw.arr);
  if (isCumulativeView(args.view)) {
    series = applyCumulativeIfRequested(series, args.view);
  }
  return series as Point[];
}

async function fetchOiCloses(args: {
  ticker: string;
  unit: Unit;
  exchanges: readonly string[];
  anchorExchange: string;
  timeframe: Timeframe;
  panel: FetchOrderflowPanelArgs;
}): Promise<Map<number, number>> {
  const symbol = buildCompoundSymbol({
    ticker: args.ticker,
    exchanges: args.exchanges,
    metric: "open_interest",
    unit: args.unit,
    view: "Candles",
  });
  const raw = await fetchRange({
    exchange: args.anchorExchange,
    symbol,
    timeframe: args.timeframe,
    ...rangeArgs(args.panel, args.anchorExchange),
  });
  const candles = normalizeRows(raw.arr) as Candle[];
  return new Map(candles.map((c) => [c.time, c.close]));
}

function pointMap(series: Point[]): Map<number, number> {
  return new Map(series.map((p) => [p.time, p.value]));
}

/**
 * Fetches an aligned bar-level order-flow panel: OHLCV plus aggregated
 * derivatives flow (volume, tape, liquidations, OI, funding) and optional spot
 * volume. Cumulative Delta / Cumulative Trade Delta are accumulated locally to
 * match the live chart (see veloClient cumulative gotcha).
 */
export async function fetchOrderflowPanel(args: FetchOrderflowPanelArgs): Promise<{
  ticker: string;
  timeframe: Timeframe;
  unit: Unit;
  priceExchange: string;
  exchanges: readonly string[];
  begin: string;
  end: string;
  barCount: number;
  notes: string[];
  bars: OrderflowBar[];
  heatmapLatestSnapshot?: HeatmapSnapshot;
  heatmapSkippedReason?: string;
}> {
  const timeframe = args.timeframe ?? "5m";
  const unit = args.unit ?? "Dollars";
  const priceExchange = args.priceExchange ?? "binance-futures";
  const exchanges = args.exchanges ?? DERIVATIVES_EXCHANGES;
  const includeSpot = args.includeSpot ?? true;
  const includeFunding = args.includeFunding ?? true;
  const includeOpenInterest = args.includeOpenInterest ?? true;
  const includeHeatmapSnapshot = args.includeHeatmapSnapshot ?? false;

  const notes: string[] = [
    "Bar-level order flow only — no per-price footprint or trade tape.",
    "Cumulative volume/trade delta series are locally summed from per-bar delta API rows.",
  ];

  const priceRaw = await fetchRange({
    exchange: priceExchange,
    symbol: args.ticker,
    timeframe,
    ...rangeArgs(args, priceExchange),
  });
  const candles = normalizeRows(priceRaw.arr) as Candle[];
  if (candles.length === 0) {
    return {
      ticker: args.ticker,
      timeframe,
      unit,
      priceExchange,
      exchanges,
      begin: priceRaw.begin,
      end: priceRaw.end,
      barCount: 0,
      notes,
      bars: [],
    };
  }

  const derivEx = exchanges;
  const spotEx = defaultExchangesForMetric("spotvol");

  const [
    derivVolStd,
    derivVolDelta,
    derivVolCum,
    tapeCount,
    tapeDelta,
    tapeCum,
    liquidations,
    spotVolStd,
    spotVolDelta,
    funding,
    oiByTime,
  ] = await Promise.all([
    fetchMetricPoints({
      ticker: args.ticker,
      metric: "volume",
      view: "Standard",
      unit,
      exchanges: derivEx,
      anchorExchange: priceExchange,
      timeframe,
      panel: args,
    }),
    fetchMetricPoints({
      ticker: args.ticker,
      metric: "volume",
      view: "Delta",
      unit,
      exchanges: derivEx,
      anchorExchange: priceExchange,
      timeframe,
      panel: args,
    }),
    fetchMetricPoints({
      ticker: args.ticker,
      metric: "volume",
      view: "Cumulative Delta",
      unit,
      exchanges: derivEx,
      anchorExchange: priceExchange,
      timeframe,
      panel: args,
    }),
    fetchMetricPoints({
      ticker: args.ticker,
      metric: "tape",
      view: "Trade Count",
      unit,
      exchanges: derivEx,
      anchorExchange: priceExchange,
      timeframe,
      panel: args,
    }),
    fetchMetricPoints({
      ticker: args.ticker,
      metric: "tape",
      view: "Trade Delta",
      unit,
      exchanges: derivEx,
      anchorExchange: priceExchange,
      timeframe,
      panel: args,
    }),
    fetchMetricPoints({
      ticker: args.ticker,
      metric: "tape",
      view: "Cumulative Trade Delta",
      unit,
      exchanges: derivEx,
      anchorExchange: priceExchange,
      timeframe,
      panel: args,
    }),
    fetchMetricPoints({
      ticker: args.ticker,
      metric: "liquidations",
      view: "Standard",
      unit,
      exchanges: derivEx,
      anchorExchange: priceExchange,
      timeframe,
      panel: args,
    }),
    includeSpot
      ? fetchMetricPoints({
          ticker: args.ticker,
          metric: "spotvol",
          view: "Standard",
          unit,
          exchanges: spotEx,
          anchorExchange: priceExchange,
          timeframe,
          panel: args,
        })
      : Promise.resolve([] as Point[]),
    includeSpot
      ? fetchMetricPoints({
          ticker: args.ticker,
          metric: "spotvol",
          view: "Delta",
          unit,
          exchanges: spotEx,
          anchorExchange: priceExchange,
          timeframe,
          panel: args,
        })
      : Promise.resolve([] as Point[]),
    includeFunding
      ? fetchMetricPoints({
          ticker: args.ticker,
          metric: "funding_rate",
          view: "Average",
          unit,
          exchanges: derivEx,
          anchorExchange: priceExchange,
          timeframe,
          panel: args,
        })
      : Promise.resolve([] as Point[]),
    includeOpenInterest
      ? fetchOiCloses({
          ticker: args.ticker,
          unit,
          exchanges: derivEx,
          anchorExchange: priceExchange,
          timeframe,
          panel: args,
        })
      : Promise.resolve(new Map<number, number>()),
  ]);

  const mDerivVol = pointMap(derivVolStd);
  const mDerivDelta = pointMap(derivVolDelta);
  const mDerivCum = pointMap(derivVolCum);
  const mTapeCount = pointMap(tapeCount);
  const mTapeDelta = pointMap(tapeDelta);
  const mTapeCum = pointMap(tapeCum);
  const mLiq = pointMap(liquidations);
  const mSpotVol = pointMap(spotVolStd);
  const mSpotDelta = pointMap(spotVolDelta);
  const mFunding = pointMap(funding);

  const bars: OrderflowBar[] = candles.map((c) => {
    const derivVolume = mDerivVol.get(c.time);
    const tradeCount = mTapeCount.get(c.time);
    const liquidationsVal = mLiq.get(c.time);
    const bar: OrderflowBar = {
      time: c.time,
      timeISO: c.timeISO,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      candleVolume: c.volume,
      derivVolume,
      derivVolumeDelta: mDerivDelta.get(c.time),
      cumulativeDerivVolumeDelta: mDerivCum.get(c.time),
      tradeCount,
      tradeDelta: mTapeDelta.get(c.time),
      cumulativeTradeDelta: mTapeCum.get(c.time),
      liquidations: liquidationsVal,
    };
    if (includeSpot) {
      bar.spotVolume = mSpotVol.get(c.time);
      bar.spotVolumeDelta = mSpotDelta.get(c.time);
    }
    if (includeFunding) bar.fundingRate = mFunding.get(c.time);
    if (includeOpenInterest) bar.openInterest = oiByTime.get(c.time);
    if (derivVolume !== undefined && tradeCount !== undefined && tradeCount > 0) {
      bar.avgTradeNotional = derivVolume / tradeCount;
    }
    if (derivVolume !== undefined && liquidationsVal !== undefined && derivVolume > 0) {
      bar.liquidationToVolumeRatio = liquidationsVal / derivVolume;
    }
    return bar;
  });

  let heatmapLatestSnapshot: HeatmapSnapshot | undefined;
  let heatmapSkippedReason: string | undefined;
  if (includeHeatmapSnapshot) {
    const coin = tickerToCoin(args.ticker);
    if (!HEATMAP_ORDERBOOK_COINS.includes(coin)) {
      heatmapSkippedReason = `No orderbook heatmap for coin ${coin} (not in Velo depth catalog).`;
    } else {
      try {
        const hm = await fetchHeatmapLevels({
          coin,
          timeframe: "1h",
          begin: args.begin,
          end: args.end,
          maxChunks: args.maxChunks,
          concurrency: args.concurrency,
          requestDelayMs: args.requestDelayMs,
        });
        heatmapLatestSnapshot = hm.snapshots.at(-1);
        if (!heatmapLatestSnapshot) heatmapSkippedReason = "Heatmap request returned no snapshots for range.";
      } catch (e) {
        heatmapSkippedReason = e instanceof Error ? e.message : String(e);
      }
    }
  }

  return {
    ticker: args.ticker,
    timeframe,
    unit,
    priceExchange,
    exchanges: derivEx,
    begin: priceRaw.begin,
    end: priceRaw.end,
    barCount: bars.length,
    notes,
    bars,
    heatmapLatestSnapshot,
    heatmapSkippedReason,
  };
}
