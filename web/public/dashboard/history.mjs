import { ensureEnvelope } from "./api.mjs";
import { validHistory, completeOhlc, historyGeometry, historyPosition } from "./history-data.mjs";

export function createHistoryPanel({ document, api, formatting, i18n, selectedSymbol }) {
  const $ = id => document.getElementById(id);
  const { number, money, date } = formatting;
  const { tr, setLocalizedMessage } = i18n;
  const stockPage = document.body?.dataset?.page === "stock";
  const controls = stockPage ? $("indicator-controls") : null;
  const selectedIndicators = () => Array.from(controls?.querySelectorAll("input:checked") || [], input => input.value);
  controls?.addEventListener("change", () => {
    chart?.setIndicators(selectedIndicators());
    showHistoryObservation();
  });
  let historyData;
  let geometry;
  let historyRequest;
  let historyKey = "";
  let tableDirty = true;
  let chart;
  let chartVersion = 0;
  let preferredMode = "candlestick";
  const host = $("financial-chart");
  function clearChart() {
    chartVersion++;
    chart?.remove();
    chart = undefined;
    host.hidden = true;
    $("history-data").classList.remove("interactive");
  }
  async function drawChart() {
    clearChart();
    const version = chartVersion;
    const { points } = historyData;
    const available = points.every(completeOhlc);
    const mode = available ? preferredMode : "line";
    const selector = $("history-style");
    selector.value = mode;
    selector.disabled = !available;
    const status = $("history-chart-status");
    setLocalizedMessage(status, () => available ? "" : tr(
      "OHLC belum lengkap. Grafik garis memakai harga penutupan.",
      "OHLC is incomplete. The line chart uses closing prices."));
    try {
      const { createFinancialChart } = await import("./financial-chart.mjs");
      if (chartVersion !== version) return;
      host.hidden = false;
      chart = createFinancialChart(host, points, mode, document.documentElement.lang, index => {
        $("history-point").value = String(index);
        showHistoryObservation();
      });
      if (controls && historyData.calculation) chart.setIndicators(selectedIndicators());
      $("history-data").classList.add("interactive");
    } catch {
      if (chartVersion !== version) return;
      host.hidden = true;
      setLocalizedMessage(status, () => tr("Grafik interaktif tidak tersedia. Harga dan volume tersedia di bawah.",
        "Interactive chart unavailable. Prices and volumes are shown below."));
    }
  }
  $("history-style").addEventListener("change", event => {
    preferredMode = event.target.value === "line" ? "line" : "candlestick";
    if (historyData) drawChart();
  });
  const historyPrice = (value, currency) => currency === "IDR" ? money(value)
    : number(value) + (currency && Number.isFinite(value) ? " " + currency : "");
  function renderLabels({ points, currency }) {
    const { low, high, maxVolume } = geometry;
    $("history-dates").textContent = points[0].date + " – " + points.at(-1).date + " · " + number(points.length) + tr(" hari dengan data", " days with data")
      + (points.some(point => point.provisional) ? tr(" · * Sesi belum selesai saat data diambil", " · * Session incomplete when fetched") : "");
    $("history-price-range").textContent = tr("Rentang penutupan · ", "Closing price range · ") + historyPrice(low, currency) + " – " + historyPrice(high, currency);
    $("history-volume-range").textContent = maxVolume ? tr("Volume tertinggi · ", "Highest volume · ") + number(maxVolume) + tr(" saham", " shares") : tr("Volume tidak tersedia.", "Volume unavailable.");
    $("history-currency").textContent = currency
      ? tr("Mata uang · ", "Currency · ") + currency
      : tr("Mata uang tidak dilaporkan provider.", "Currency not reported by the provider.");
    const slider = $("history-point");
    const previousIndex = Number(slider.value);
    slider.max = String(points.length - 1);
    slider.value = String(Number.isInteger(previousIndex) && previousIndex >= 0 && previousIndex < points.length
      ? previousIndex : points.length - 1);
    slider.disabled = points.length === 1;
    showHistoryObservation();
    tableDirty = true;
    renderTable();
  }
  function renderTable() {
    if (!historyData || !tableDirty || !$("history-records").open) return;
    const tableRows = [...historyData.points].reverse().map(point => {
      const row = document.createElement("tr");
      for (const value of [point.date + (point.provisional ? " *" : ""), number(point.close), number(point.adjusted_close), number(point.volume)]) {
        const cell = document.createElement("td");
        cell.textContent = value;
        row.append(cell);
      }
      return row;
    });
    $("history-rows").replaceChildren(...tableRows);
    tableDirty = false;
  }
  function showHistoryObservation() {
    if (!historyData) return;
    const { points, currency } = historyData;
    const slider = $("history-point");
    const point = points[Number(slider.value)];
    if (!point) return;
    const x = historyPosition(points, point);
    $("history-price-guide").setAttribute("d", "M" + x + " 0v116");
    $("history-volume-guide").setAttribute("d", "M" + x + " 0v65");
    const label = point.date + " · " + tr("Penutupan ", "Close ") + historyPrice(point.close, currency)
      + (completeOhlc(point) ? " · " + tr("Buka ", "Open ") + historyPrice(point.open, currency)
        + " · " + tr("Tertinggi ", "High ") + historyPrice(point.high, currency)
        + " · " + tr("Terendah ", "Low ") + historyPrice(point.low, currency) : "")
      + " · " + tr("Volume ", "Volume ") + number(point.volume)
      + (point.provisional ? tr(" · Sementara saat data diambil (*)", " · Provisional when fetched (*)") : "");
    if (controls) {
      controls.disabled = !historyData.calculation;
      const row = point.indicators;
      const values = selectedIndicators().map(key => {
        const value = row?.[key];
        if (key === "macd" && value) return "MACD / Signal / Δ " +
          [value.line, value.signal, value.histogram].map(v => number(v)).join(" / ");
        return key.toUpperCase() + " " + number(value);
      });
      let reason = "";
      if (!historyData.calculation) reason = tr("Indikator tidak tersedia.", "Indicators unavailable.");
      else if (values.length && !row) reason = point.provisional
        ? tr("Sesi sementara.", "Provisional session.")
        : tr("Sesi di luar kalender terverifikasi.", "Session outside verified calendar.");
      else if (values.length && selectedIndicators().some(key => row?.[key] == null))
        reason = number(row.observations) + tr(" sesi berurutan tersedia.", " consecutive sessions available.");
      $("indicator-readout").textContent = [point.date, ...values, reason].filter(Boolean).join(" · ");
    }
    slider.setAttribute("aria-valuetext", label);
    $("history-observation").textContent = label;
  }
  $("history-point").addEventListener("input", () => {
    showHistoryObservation();
    if (historyData) chart?.inspect(historyData.points[Number($("history-point").value)]);
  });
  $("history-records").addEventListener("toggle", renderTable);
  async function updateHistory(force = false) {
    if (document.body?.dataset?.page !== "stock" && !$("history-panel").open) {
      historyRequest?.abort();
      historyRequest = undefined;
      historyKey = "";
      return;
    }
    const symbol = selectedSymbol();
    if (document.body?.dataset?.page === "stock") $("chart-symbol").textContent = symbol;
    const range = $("history-range").value;
    const key = symbol + ":" + range;
    if (!force && key === historyKey) return;
    historyKey = key;
    historyRequest?.abort();
    const request = new AbortController();
    historyRequest = request;
    const status = $("history-status");
    if (document.defaultView) clearChart();
    historyData = undefined;
    tableDirty = true;
    $("history-rows").replaceChildren();
    $("history-data").hidden = true;
    $("history-retry").hidden = true;
    setLocalizedMessage(status, () => tr("Memuat histori ", "Loading history for ") + symbol + "…");
    try {
      const path = "/api/history?" + new URLSearchParams({ symbol, range });
      let response;
      if (stockPage) {
        try {
          response = await api.get(path + "&indicators=true", request.signal);
        } catch (error) {
          if (request.signal.aborted) throw error;
          // Older API releases and providers without five-year history can still serve prices.
          response = await api.get(path, request.signal);
        }
      } else response = await api.get(path, request.signal);
      if (historyRequest !== request) return;
      const { data, provider, stale, cached, warnings, fetched_at } = ensureEnvelope(response, "idx.daily-history.v1",
        data => validHistory(data, symbol, range));
      if (!data.points.length) {
        setLocalizedMessage(status, () => tr("Belum ada data historis ", "No historical data for ") + symbol + tr(" untuk rentang ini.", " in this range."));
        return;
      }
      historyData = data;
      geometry = historyGeometry(data.points);
      $("history-price-path").setAttribute("d", geometry.pricePath);
      $("history-volume-path").setAttribute("d", geometry.volumePath);
      $("history-point").max = String(data.points.length - 1);
      $("history-point").value = String(data.points.length - 1);
      renderLabels(historyData);
      $("history-data").hidden = false;
      if (document.defaultView) drawChart();
      setLocalizedMessage(status, () => symbol + " · " + (provider || tr("Provider tidak diketahui", "Unknown provider"))
        + (stale ? tr(" · Data lama dari provider", " · Stale provider data") : cached ? tr(" · Respons dari cache", " · Cached response") : "")
        + (warnings?.length ? tr(" · Dapat berisi data tidak lengkap", " · Data may be incomplete") : "")
        + (fetched_at ? tr(" · Diambil ", " · Fetched ") + date(fetched_at) : ""));
    } catch {
      if (historyRequest !== request) return;
      setLocalizedMessage(status, () => tr("Histori ", "History for ") + symbol + tr(" belum dapat dimuat.", " could not be loaded."));
      $("history-retry").hidden = false;
    }
  }
  $("history-panel").addEventListener("toggle", () => updateHistory());
  $("history-range").addEventListener("change", () => updateHistory());
  $("history-retry").addEventListener("click", () => {
    $("history-range").focus();
    updateHistory(true);
  });
  return {
    update: updateHistory,
    render: () => {
      chart?.locale(document.documentElement.lang);
      if (historyData && !$("history-data").hidden) renderLabels(historyData);
    },
  };
}
