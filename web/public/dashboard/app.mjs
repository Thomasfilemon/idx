import { createApi } from "./api.mjs";
import { createFormatting } from "./format.mjs";
import { createI18n } from "./i18n.mjs";
import { createPanelStatus } from "./status.mjs";
import { createMarketPanel } from "./market.mjs";
import { createWatchlistPanel, normalizeSymbol, validSymbol } from "./watchlist.mjs";
import { createHistoryPanel } from "./history.mjs";

export function initDashboard({ document, fetch, storage }) {
  const $ = id => document.getElementById(id);
  const page = document.body?.dataset?.page || "dashboard";
  const browser = document.defaultView;
  if (page === "landing" && browser.location.hash === "#dashboard") {
    browser.location.replace("./dashboard.html#dashboard");
    return;
  }
  const api = createApi(document, fetch);
  const formatting = createFormatting();
  const i18n = createI18n(document, storage, formatting);
  const { tr } = i18n;
  const metaState = createPanelStatus({ tr, date: formatting.date });
  const context = { document, api, formatting, i18n, tr, metaState };
  if (page === "landing") {
    i18n.bind(() => {});
    return;
  }
  const stockPage = page === "stock";
  const readRoute = () => {
    const params = new URLSearchParams(browser.location.search);
    const symbol = normalizeSymbol(params.get("symbol"));
    const range = params.get("range");
    return { symbol: validSymbol(symbol) ? symbol : "BBCA",
      range: ["3w", "1mo", "3mo", "ytd", "1y", "3y"].includes(range) ? range : "1mo" };
  };
  const route = stockPage ? readRoute() : {};
  const market = page === "stock" ? null : createMarketPanel({ ...context, onStatusChange: renderRefresh });
  const watchlist = page === "market" ? null : createWatchlistPanel({ ...context,
    initialSymbol: route.symbol, onStatusChange: renderRefresh,
    onSelect: () => { saveRoute("pushState"); history.update(); },
  });
  const history = watchlist && createHistoryPanel({ ...context, selectedSymbol: watchlist.selected });
  function saveRoute(method) {
    if (!stockPage) return;
    const url = new URL(browser.location.href);
    url.searchParams.set("symbol", watchlist.selected());
    url.searchParams.set("range", $("history-range").value);
    if (url.href !== browser.location.href) browser.history[method](null, "", url);
  }
  if (stockPage) {
    $("history-range").value = route.range;
    saveRoute("replaceState");
    $("history-range").addEventListener("change", () => saveRoute("pushState"));
    browser.addEventListener("popstate", () => {
      const route = readRoute();
      $("history-range").value = route.range;
      watchlist.restore(route.symbol);
      saveRoute("replaceState");
      history.update();
    });
  }
  function renderRefresh() {
    const loading = Boolean(market?.isLoading() || watchlist?.isLoading());
    $("refresh").setAttribute("aria-disabled", String(loading));
    $("refresh-label").textContent = loading ? tr("Memuat data…", "Loading data…") : tr("Perbarui data", "Refresh data");
  }
  function load() {
    market?.load();
    watchlist?.load();
  }
  $("refresh").addEventListener("click", () => {
    if (!market?.isLoading() && !watchlist?.isLoading()) load();
  });
  $("retry-market")?.addEventListener("click", () => {
    $("refresh").focus();
    market?.load();
  });
  $("retry-quotes")?.addEventListener("click", () => {
    $("symbol").focus();
    watchlist?.load();
  });
  i18n.bind(() => {
    market?.render();
    watchlist?.render();
    history?.render();
    renderRefresh();
  });
  load();
}
