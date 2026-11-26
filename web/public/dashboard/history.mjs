import { ensureEnvelope } from "./api.mjs";
import { validHistory, historyGeometry, historyPosition } from "./history-data.mjs";

export function createHistoryPanel({ document, api, formatting, i18n, selectedSymbol }) {
  const $ = id => document.getElementById(id);
  const { number, money, date } = formatting;
  const { tr, setLocalizedMessage } = i18n;
  let historyData;
  let geometry;
  let historyRequest;
  let historyKey = "";
  let tableDirty = true;
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
      + " · " + tr("Volume ", "Volume ") + number(point.volume)
      + (point.provisional ? tr(" · Sementara saat data diambil (*)", " · Provisional when fetched (*)") : "");
    slider.setAttribute("aria-valuetext", label);
    $("history-observation").textContent = label;
  }
  $("history-point").addEventListener("input", showHistoryObservation);
  $("history-records").addEventListener("toggle", renderTable);
  async function updateHistory(force = false) {
    if (!$("history-panel").open) {
      historyRequest?.abort();
      historyRequest = undefined;
      historyKey = "";
      return;
    }
    const symbol = selectedSymbol();
    const range = $("history-range").value;
    const key = symbol + ":" + range;
    if (!force && key === historyKey) return;
    historyKey = key;
    historyRequest?.abort();
    const request = new AbortController();
    historyRequest = request;
    const status = $("history-status");
    historyData = undefined;
    tableDirty = true;
    $("history-rows").replaceChildren();
    $("history-data").hidden = true;
    $("history-retry").hidden = true;
    setLocalizedMessage(status, () => tr("Memuat histori ", "Loading history for ") + symbol + "…");
    try {
      const response = await api.get("/api/history?" + new URLSearchParams({ symbol, range }), request.signal);
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
      if (historyData && !$("history-data").hidden) renderLabels(historyData);
    },
  };
}
