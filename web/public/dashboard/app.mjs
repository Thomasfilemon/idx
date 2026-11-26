import { createApi } from "./api.mjs";
import { createFormatting } from "./format.mjs";
import { createI18n } from "./i18n.mjs";
import { createPanelStatus } from "./status.mjs";
import { createMarketPanel } from "./market.mjs";
import { createWatchlistPanel } from "./watchlist.mjs";
import { createHistoryPanel } from "./history.mjs";

export function initDashboard({ document, fetch, storage }) {
  const $ = id => document.getElementById(id);
  const api = createApi(document, fetch);
  const formatting = createFormatting();
  const i18n = createI18n(document, storage, formatting);
  const { tr } = i18n;
  const metaState = createPanelStatus({ tr, date: formatting.date });
  const context = { document, api, formatting, i18n, tr, metaState };
  const market = createMarketPanel({ ...context, onStatusChange: renderRefresh });
  const watchlist = createWatchlistPanel({ ...context, onStatusChange: renderRefresh, onSelect: () => history.update() });
  const history = createHistoryPanel({ ...context, selectedSymbol: watchlist.selected });
  function renderRefresh() {
    const loading = market.isLoading() || watchlist.isLoading();
    $("refresh").setAttribute("aria-disabled", String(loading));
    $("refresh-label").textContent = loading ? tr("Memuat data…", "Loading data…") : tr("Perbarui data", "Refresh data");
  }
  function load() {
    market.load();
    watchlist.load();
  }
  $("refresh").addEventListener("click", () => {
    if (!market.isLoading() && !watchlist.isLoading()) load();
  });
  $("retry-market").addEventListener("click", () => {
    $("refresh").focus();
    market.load();
  });
  $("retry-quotes").addEventListener("click", () => {
    $("symbol").focus();
    watchlist.load();
  });
  i18n.bind(() => {
    market.render();
    watchlist.render();
    history.render();
    renderRefresh();
  });
  load();
}
