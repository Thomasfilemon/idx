import { createChart, CandlestickSeries, LineSeries, HistogramSeries, ColorType } from "./vendor/lightweight-charts-5.0.9.mjs";

// The native time scale keeps volume, gestures and crosshair aligned to the same session.
export function createFinancialChart(host, points, mode, locale, onInspect) {
  const chart = createChart(host, {
    autoSize: true,
    layout: { background: { type: ColorType.Solid, color: "#151f30" }, textColor: "#cfdae7" },
    grid: { vertLines: { color: "#243042" }, horzLines: { color: "#243042" } },
    localization: { locale },
    handleScroll: { horzTouchDrag: true, vertTouchDrag: false },
    handleScale: { pinch: true, mouseWheel: true },
  });
  try {
    const candle = mode === "candlestick";
    const series = chart.addSeries(candle ? CandlestickSeries : LineSeries,
      candle ? { upColor: "#a6ef79", downColor: "#fa8e98", borderVisible: false,
        wickUpColor: "#a6ef79", wickDownColor: "#fa8e98" } : { color: "#a6ef79", lineWidth: 2 });
    series.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.28 } });
    series.setData(points.map(p => candle
      ? { time: p.date, open: p.open, high: p.high, low: p.low, close: p.close }
      : { time: p.date, value: p.close }));
    const volume = chart.addSeries(HistogramSeries, {
      priceScaleId: "volume", priceFormat: { type: "volume" },
      color: "#76a4c6", priceLineVisible: false, lastValueVisible: false,
    });
    volume.priceScale().applyOptions({ scaleMargins: { top: 0.80, bottom: 0 } });
    volume.setData(points.map(p => p.volume == null ? { time: p.date } : { time: p.date, value: p.volume }));
    const indices = new Map(points.map((p, i) => [p.date, i]));
    chart.subscribeCrosshairMove(event => {
      const day = event.time;
      if (!day) return;
      const key = typeof day === "string" ? day : [day.year, String(day.month).padStart(2, "0"),
        String(day.day).padStart(2, "0")].join("-");
      if (indices.has(key)) onInspect(indices.get(key));
    });
    chart.timeScale().fitContent();
    return {
      remove: () => chart.remove(),
      locale: locale => chart.applyOptions({ localization: { locale } }),
      inspect: p => chart.setCrosshairPosition(p.close, p.date, series),
    };
  } catch (error) {
    chart.remove();
    throw error;
  }
}
