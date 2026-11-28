import { indicators, segments } from "./indicator-series.mjs";
import { createChart, CandlestickSeries, LineSeries, HistogramSeries, ColorType } from "./vendor/lightweight-charts-5.0.9.mjs";

// The native time scale keeps volume, gestures and crosshair aligned to the same session.
export function createFinancialChart(host, points, mode, locale, onInspect, onOlder, visibleRange) {
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
    let studies = [];
    function setIndicators(keys) {
      for (const study of studies.reverse()) chart.removeSeries(study);
      studies = [];
      function plot(key, pane, component, color) {
        const [name, defaultColor] = indicators[key];
        const groups = segments(points, key, component);
        for (const group of groups) {
          const histogram = component === "histogram";
          const study = chart.addSeries(histogram ? HistogramSeries : LineSeries, {
            color: color || defaultColor, lineWidth: 2, priceLineVisible: false,
            lastValueVisible: group === groups.at(-1),
            title: component ? name + " " + component : name,
          }, pane);
          study.setData(group);
          studies.push(study);
        }
      }
      for (const key of keys) {
        if (key !== "macd" && key !== "rsi14") plot(key, 0);
      }
      if (keys.includes("rsi14")) plot("rsi14", 1);
      if (keys.includes("macd")) {
        const pane = chart.panes().length;
        plot("macd", pane, "histogram", "#8898aa");
        plot("macd", pane, "line");
        plot("macd", pane, "signal", "#ffd166");
      }
      host.style.height = chart.panes().length > 1 ? (330 + 140 * (chart.panes().length - 1)) + "px" : "";
      for (const pane of chart.panes().slice(1)) pane.setHeight(140);
    }
    chart.timeScale().fitContent();
    if (visibleRange) chart.timeScale().setVisibleRange(visibleRange);
    const gesture = new AbortController();
    let interacted = false;
    if (onOlder) {
      const options = { passive: true, capture: true, signal: gesture.signal };
      const atStart = range => range && range.from < 8;
      let drag;
      host.addEventListener("pointerdown", event => {
        if (!event.isPrimary) return;
        interacted = true;
        drag = { id: event.pointerId, x: event.clientX, y: event.clientY, requested: false };
      }, options);
      host.addEventListener("pointermove", event => {
        if (!drag || drag.id !== event.pointerId || drag.requested) return;
        const dx = event.clientX - drag.x;
        const dy = event.clientY - drag.y;
        // Short series may already be clamped at their first bar. A deliberate
        // backward pan still needs to load older data even without a scale event.
        if (dx > 24 && dx > Math.abs(dy) && atStart(chart.timeScale().getVisibleLogicalRange())) {
          drag.requested = true;
          onOlder();
        }
      }, options);
      for (const event of ["pointerup", "pointercancel", "pointerleave"]) {
        host.addEventListener(event, () => { drag = undefined; }, options);
      }
      for (const event of ["wheel", "touchstart"]) {
        host.addEventListener(event, () => { interacted = true; }, options);
      }
      chart.timeScale().subscribeVisibleLogicalRangeChange(range => {
        if (interacted && atStart(range)) onOlder();
      });
    }
    return {
      setIndicators,
      visibleRange: () => chart.timeScale().getVisibleRange(),
      remove: () => { gesture.abort(); chart.remove(); host.style.height = ""; },
      locale: locale => chart.applyOptions({ localization: { locale } }),
      inspect: p => chart.setCrosshairPosition(p.close, p.date, series),
    };
  } catch (error) {
    chart.remove();
    throw error;
  }
}
