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
    let renderedMode = mode;
    function addPriceSeries(style) {
      const candle = style === "candlestick";
      const priceSeries = chart.addSeries(candle ? CandlestickSeries : LineSeries,
        candle ? { upColor: "#a6ef79", downColor: "#fa8e98", borderVisible: false,
          wickUpColor: "#a6ef79", wickDownColor: "#fa8e98" } : { color: "#a6ef79", lineWidth: 2 });
      priceSeries.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.28 } });
      return priceSeries;
    }
    let series = addPriceSeries(renderedMode);
    const volume = chart.addSeries(HistogramSeries, {
      priceScaleId: "volume", priceFormat: { type: "volume" },
      color: "#76a4c6", priceLineVisible: false, lastValueVisible: false,
    });
    volume.priceScale().applyOptions({ scaleMargins: { top: 0.80, bottom: 0 } });
    let indices;
    function setPriceData() {
      indices = new Map(points.map((p, i) => [p.date, i]));
      series.setData(points.map(p => renderedMode === "candlestick"
        ? { time: p.date, open: p.open, high: p.high, low: p.low, close: p.close }
        : { time: p.date, value: p.close }));
      volume.setData(points.map(p => p.volume == null ? { time: p.date } : { time: p.date, value: p.volume }));
    }
    setPriceData();
    chart.subscribeCrosshairMove(event => {
      const day = event.time;
      if (!day) return;
      const key = typeof day === "string" ? day : [day.year, String(day.month).padStart(2, "0"),
        String(day.day).padStart(2, "0")].join("-");
      if (indices.has(key)) onInspect(indices.get(key));
    });
    const studies = new Map();
    let activeKeys = [];
    function clearStudies() {
      for (const { series: group } of [...studies.values()].reverse()) {
        for (const study of group.slice().reverse()) chart.removeSeries(study);
      }
      studies.clear();
    }
    function refreshStudies() {
      const plans = [];
      function plot(key, pane, component, color) {
        const [name, defaultColor] = indicators[key];
        const groups = segments(points, key, component).reverse();
        if (groups.length) plans.push({
          id: key + ":" + (component || ""), pane, groups,
          histogram: component === "histogram", color: color || defaultColor,
          title: component ? name + " " + component : name,
        });
        return groups.length > 0;
      }
      for (const key of activeKeys) {
        if (key !== "macd" && key !== "rsi14") plot(key, 0);
      }
      const rsiPane = activeKeys.includes("rsi14") && plot("rsi14", 1);
      if (activeKeys.includes("macd")) {
        const pane = rsiPane ? 2 : 1;
        plot("macd", pane, "histogram", "#8898aa");
        plot("macd", pane, "line");
        plot("macd", pane, "signal", "#ffd166");
      }
      // A newly available oscillator may create a pane before another one.
      // Rebuild studies only in that rare case; the price and volume chart stay mounted.
      if (plans.some(plan => studies.has(plan.id) && studies.get(plan.id).pane !== plan.pane)) clearStudies();
      for (const plan of plans) {
        const group = studies.get(plan.id) || { pane: plan.pane, series: [] };
        for (const [i, data] of plan.groups.entries()) {
          const options = { color: plan.color, lineWidth: 2, priceLineVisible: false,
            lastValueVisible: i === 0, title: plan.title };
          const study = group.series[i] || chart.addSeries(plan.histogram ? HistogramSeries : LineSeries,
            options, plan.pane);
          group.series[i] = study;
          study.setData(data);
        }
        for (const study of group.series.splice(plan.groups.length)) chart.removeSeries(study);
        studies.set(plan.id, group);
      }
      host.style.height = chart.panes().length > 1 ? (330 + 140 * (chart.panes().length - 1)) + "px" : "";
      for (const pane of chart.panes().slice(1)) pane.setHeight(140);
    }
    function setIndicators(keys) {
      clearStudies();
      activeKeys = keys;
      refreshStudies();
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
      prependPoints: (nextPoints, nextMode) => {
        const scale = chart.timeScale();
        const range = scale.getVisibleLogicalRange();
        const added = nextPoints.length - points.length;
        // Ignore scale-change notifications caused by this programmatic update.
        interacted = false;
        points = nextPoints;
        if (nextMode !== renderedMode) {
          chart.removeSeries(series);
          renderedMode = nextMode;
          series = addPriceSeries(renderedMode);
        }
        setPriceData();
        refreshStudies();
        if (range) scale.setVisibleLogicalRange({ from: range.from + added, to: range.to + added });
      },
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
