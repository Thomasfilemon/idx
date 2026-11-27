import { createPanelState, loadPanel } from "./api.mjs";

export function createMarketPanel({ document, api, formatting, tr, metaState, onStatusChange }) {
  const $ = id => document.getElementById(id);
  const { number, money, signed, cls, date, quoteChange } = formatting;
  let market = null;
  const marketPanel = createPanelState();
  function renderInsights() {
    const counts = [market?.advancing, market?.declining, market?.unchanged];
    for (const key of ["advancing", "declining", "unchanged", "quoted"]) $(key).textContent = number(market?.[key]);
    const complete = counts.every(count => Number.isInteger(count) && count >= 0);
    const classified = complete ? counts.reduce((sum, count) => sum + count, 0) : null;
    $("breadth-track").hidden = !classified;
    for (const [i, key] of ["up", "down", "flat"].entries()) {
      $("breadth-" + key).style.width = classified ? (100 * counts[i] / classified) + "%" : "0%";
    }
    $("breadth-caption").textContent = Number.isFinite(market?.quoted) && Number.isFinite(market?.universe)
      ? "Snapshot · " + number(market.quoted) + tr(" dari ", " of ") + number(market.universe) + tr(" saham tercakup", " stocks covered")
      : tr("Cakupan snapshot pasar belum tersedia.", "Market snapshot coverage unavailable.");

    for (const key of ["gainers", "losers", "most_active"]) {
      const items = Array.isArray(market?.[key]) ? market[key].slice(0, 5) : [];
      const nodes = items.filter(item => item && typeof item.symbol === "string").map(item => {
        const row = document.createElement("div");
        row.className = "mover";
        const symbol = document.createElement("strong");
        symbol.textContent = item.symbol;
        const metric = document.createElement("span");
        if (key === "most_active") {
          metric.className = "activity-metric";
          metric.append(money(item.value));
          const volume = document.createElement("small");
          volume.textContent = number(item.volume) + (Number.isFinite(item.volume) ? tr(" saham", " shares") : "");
          metric.append(volume);
        } else {
          metric.className = cls(item.change_pct);
          metric.textContent = signed(item.change_pct, "%");
        }
        row.append(symbol, metric);
        return row;
      });
      if (!nodes.length) {
        const empty = document.createElement("p");
        empty.className = "movers-empty";
        empty.textContent = marketPanel.loading ? tr("Memuat data pasar…", "Loading market data…") : tr("Data belum tersedia", "Data unavailable");
        nodes.push(empty);
      }
      if (items.length && market?.[key + "_fallback"] === true) {
        const note = document.createElement("p");
        note.className = "movers-empty";
        note.textContent = tr(
          "Peringkat dari saham bervolume positif, tanpa filter kapitalisasi pasar.",
          "Ranked among stocks with positive volume, without a market-cap filter."
        );
        nodes.push(note);
      }
      $(key + "-list").replaceChildren(...nodes);
    }
  }
  function render() {
    for (const id of ["ihsg", "ihsg-change", "advancing", "declining", "unchanged", "quoted", "gainers-list", "losers-list", "most_active-list"]) {
      $(id).setAttribute("data-loading", String(marketPanel.loading && !marketPanel.meta));
    }
    renderInsights();
    const ix = market?.index;
    $("ihsg").textContent = number(ix?.price);
    $("ihsg-change").textContent = quoteChange(ix?.change, ix?.change_pct);
    $("ihsg-change").className = "delta " + cls(ix?.change_pct);
    $("market-status").textContent = marketPanel.error ? tr("Status sesi belum diperbarui", "Session status has not been refreshed") : market?.market_open === true ? tr("Pasar buka", "Market open") : market?.market_open === false ? tr("Pasar tutup", "Market closed") : tr("Status sesi belum diketahui", "Session status unknown");
    $("updated").textContent = tr("Waktu data pasar · ", "Market data time · ") + date(market?.as_of);
    $("market-source").textContent = "Provider · " + (marketPanel.meta?.provider || "—");
    $("mode").textContent = marketPanel.loading ? tr("Memuat data pasar…", "Loading market data…") : marketPanel.error ? (marketPanel.meta ? tr("Snapshot sebelumnya", "Previous snapshot") : tr("Data pasar tidak tersedia", "Market data unavailable"))
      : marketPanel.meta?.stale || market?.behind_session ? tr("Data pasar tertunda", "Market data delayed") : tr("Snapshot pasar", "Market snapshot");
    $("retry-market").hidden = !marketPanel.error;
    $("market-notice").textContent = metaState(marketPanel);
  }
  function refresh() {
    render();
    onStatusChange();
  }
  function loadMarket() {
    return loadPanel(api, marketPanel, "/api/market", "idx.market.v1",
      x => x && Array.isArray(x.gainers) && Array.isArray(x.losers),
      data => { market = data; }, refresh);
  }
  return { render, load: loadMarket, isLoading: () => marketPanel.loading };
}
