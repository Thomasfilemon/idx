const apiBase = document.querySelector('meta[name="idx-api-base"]')?.content.trim().replace(/\/+$/, "") || "";
const $ = (id) => document.getElementById(id);
let language = "id";
try {
  if (globalThis.localStorage?.getItem("idx-language") === "en") language = "en";
} catch {
  // Language remains usable when browser storage is unavailable.
}
const tr = (id, en) => language === "en" ? en : id;
let fmt;
let dateFmt;
function setFormats() {
  const locale = tr("id-ID", "en-GB");
  fmt = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
  dateFmt = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Jakarta" });
}
setFormats();
const localizedMessages = new Map();
function setLocalizedMessage(element, message) {
  localizedMessages.set(element, message);
  element.textContent = message();
}
const number = (n) => Number.isFinite(n) ? fmt.format(n) : "—";
const money = (n) => Number.isFinite(n) ? "Rp" + fmt.format(n) : "—";
const signed = (n, unit = "") => Number.isFinite(n) ? (n > 0 ? "+" : "") + fmt.format(n) + unit : "—";
const cls = (n) => n > 0 ? "positive" : n < 0 ? "negative" : "";
const date = (value) => { if (!value) return "—"; const d = new Date(value); return Number.isNaN(d.getTime()) ? "—" : dateFmt.format(d) + " WIB"; };
const allowedSorts = new Set(["symbol", "price", "change_pct", "volume"]);
const normalizeSymbol = (s) => String(s || "").trim().toUpperCase().replace(/\.JK$/, "");
const validSymbol = (s) => /^[A-Z0-9][A-Z0-9-]{0,11}$/.test(s);
const ensureEnvelope = (body, schema, isValid) => {
  if (!body || body.schema !== schema || !isValid(body.data)) {
    throw Error("Schema mismatch", { cause: { schema } });
  }
  return body;
};
const sortRows = (items, sort) => [...items].sort((a, b) => {
  if (sort === "symbol") return a.symbol.localeCompare(b.symbol);
  const x = a[sort], y = b[sort];
  if (!Number.isFinite(x)) return Number.isFinite(y) ? 1 : a.symbol.localeCompare(b.symbol);
  if (!Number.isFinite(y)) return -1;
  return y - x || a.symbol.localeCompare(b.symbol);
});
let symbols = ["BBCA", "BBRI", "TLKM"];
let selected = "BBCA", rows = [], market = null;
let filter = "", sort = "symbol";
const marketPanel = { meta: null, loading: false, error: "", controller: null };
const quotesPanel = { meta: null, loading: false, error: "", controller: null };
function notice(text) { $("notice").textContent = text; }
function panelError(error) {
  if (error.name === "AbortError") return tr("request timeout (55 detik)", "Request timed out (55 seconds)");
  if (error.cause?.schema) {
    return tr("Format respons API tidak sesuai (", "Unexpected API response format (") + error.cause.schema + ")";
  }
  if (/^HTTP \d{3}$/.test(error.message)) return error.message;
  return tr("API tidak dapat dihubungi atau memberi respons yang tidak valid", "The API could not be reached or returned an invalid response");
}
function metaState(panel) {
  if (panel.loading) return panel.meta ? tr("Memperbarui data…", "Updating data…") : tr("Menghubungkan ke API… Server dapat memerlukan waktu untuk aktif.", "Connecting to the API… The server may need time to start.");
  if (panel.error) {
    const message = tr("Gagal memuat data: ", "Could not load data: ") + panelError(panel.error) + ".";
    return panel.meta ? message + tr(" Menampilkan data terakhir yang berhasil diambil pada ", " Showing the last data received at ") + date(panel.meta.fetched_at) + "." : message;
  }
  const meta = panel.meta;
  if (!meta) return "";
  const state = [];
  if (meta.data?.behind_session === true) state.push(tr("Data tertinggal dari sesi terakhir", "Data is behind the latest session"));
  else if (meta.stale) state.push(tr("Data lama dari provider", "Stale provider data"));
  if (meta.cached) state.push(tr("Respons dari cache", "Cached response"));
  if (meta.warnings?.length) state.push(tr("Provider melaporkan keterbatasan data", "The provider reported limited data"));
  state.push(tr("Respons diambil ", "Response received ") + date(meta.fetched_at));
  return state.join(" · ");
}
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
    $(key + "-list").replaceChildren(...nodes);
  }
}
function quoteChange(change, percent) {
  if (!Number.isFinite(change)) return signed(percent, "%");
  return Number.isFinite(percent) ? signed(change) + " (" + signed(percent, "%") + ")" : signed(change);
}
function render() {
  const focusedStock = document.activeElement;
  const focusedTicker = focusedStock?.dataset?.ticker;
  renderInsights();
  const visible = sortRows(rows.filter(q => q.symbol.toUpperCase().includes(filter) || String(q.name || "").toUpperCase().includes(filter)), sort);
  const list = visible.map(q => {
    const b = document.createElement("button"); b.type = "button";
    b.dataset.ticker = q.symbol;
    b.setAttribute("aria-pressed", String(q.symbol === selected));
    b.className = "stock" + (q.symbol === selected ? " selected" : "");
    const left = document.createElement("div"), right = document.createElement("div"); right.className = "stock-right";
    const ticker = document.createElement("div"); ticker.className = "ticker"; ticker.textContent = q.symbol;
    const company = document.createElement("div"); company.className = "company"; company.textContent = q.name || tr("Nama belum tersedia", "Name unavailable");
    const price = document.createElement("div"); price.className = "price"; price.textContent = money(q.price);
    const change = document.createElement("div"); change.className = "change " + cls(q.change_pct); change.textContent = signed(q.change_pct, "%");
    left.append(ticker, company); right.append(price, change); b.append(left, right);
    b.addEventListener("click", () => { selected = q.symbol; render(); updateHistory(); }); return b;
  });
  $("stocks").replaceChildren(...list);
  if (focusedTicker) list.find(button => button.dataset.ticker === focusedTicker)?.focus({ preventScroll: true });
  $("empty").textContent = !visible.length && !quotesPanel.loading && !quotesPanel.error ? (filter && rows.length ? tr("Tidak ada saham yang cocok dengan pencarian.", "No stocks match your search.") : tr("Data saham belum tersedia.", "Stock data is unavailable.")) : "";
  const q = rows.find(x => x.symbol === selected);
  $("detail-title").textContent = selected + tr(" · Detail saham", " · Stock details");
  $("detail-name").textContent = q?.name || tr("Data belum tersedia", "Data unavailable");
  $("detail-source").textContent = quotesPanel.meta?.provider || "—";
  $("detail-price").textContent = money(q?.price);
  $("detail-change").textContent = quoteChange(q?.change, q?.change_pct);
  $("detail-change").className = cls(q?.change_pct);
  $("detail-volume").textContent = number(q?.volume);
  $("detail-time").textContent = date(q?.market_time);
  const ix = market?.index;
  $("ihsg").textContent = number(ix?.price);
  $("ihsg-change").textContent = quoteChange(ix?.change, ix?.change_pct);
  $("ihsg-change").className = "delta " + cls(ix?.change_pct);
  $("market-status").textContent = marketPanel.error ? tr("Status sesi belum diperbarui", "Session status has not been refreshed") : market?.market_open === true ? tr("Pasar buka", "Market open") : market?.market_open === false ? tr("Pasar tutup", "Market closed") : tr("Status sesi belum diketahui", "Session status unknown");
  $("updated").textContent = tr("Waktu data pasar · ", "Market data time · ") + date(market?.as_of);
  $("market-source").textContent = "Provider · " + (marketPanel.meta?.provider || "—");
  $("mode").textContent = marketPanel.loading ? tr("Memuat data pasar…", "Loading market data…") : marketPanel.error ? (marketPanel.meta ? tr("Snapshot sebelumnya", "Previous snapshot") : tr("Data pasar tidak tersedia", "Market data unavailable"))
    : marketPanel.meta?.stale || market?.behind_session ? tr("Data pasar tertunda", "Market data delayed") : tr("Snapshot pasar", "Market snapshot");
  const loading = marketPanel.loading || quotesPanel.loading;
  $("refresh").setAttribute("aria-disabled", String(loading));
  $("refresh-label").textContent = loading ? tr("Memuat data…", "Loading data…") : tr("Perbarui data", "Refresh data");
  $("retry-market").hidden = !marketPanel.error;
  $("retry-quotes").hidden = !quotesPanel.error;
  $("market-notice").textContent = metaState(marketPanel);
  const missing = quotesPanel.meta && !quotesPanel.loading && !quotesPanel.error ? symbols.filter(s => !rows.some(q => q.symbol === s)) : [];
  notice(metaState(quotesPanel) + (missing.length ? tr(" · Tidak ditemukan: ", " · Not found: ") + missing.join(", ") : ""));
}
async function get(path, signal, base = apiBase) {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), 55000);
  const abort = () => timeout.abort();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await fetch(base + path, { signal: timeout.signal, headers: { Accept: "application/json" } });
    if (!response.ok) throw Error("HTTP " + response.status);
    const body = await response.json();
    if (body?.error) throw Error(body.error.message || "API error");
    return body;
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
}
async function loadPanel(panel, path, schema, isValid, accept) {
  panel.controller?.abort();
  const controller = new AbortController();
  panel.controller = controller;
  panel.loading = true;
  panel.error = "";
  render();
  try {
    const body = ensureEnvelope(await get(path, controller.signal), schema, isValid);
    if (panel.controller !== controller) return;
    panel.meta = body;
    accept(body.data);
  } catch (e) {
    if (panel.controller !== controller) return;
    panel.error = e;
  }
  panel.loading = false;
  render();
}
function loadMarket() {
  return loadPanel(marketPanel, "/api/market", "idx.market.v1",
    x => x && Array.isArray(x.gainers) && Array.isArray(x.losers),
    data => { market = data; });
}
function loadQuotes() {
  return loadPanel(quotesPanel, "/api/quote?symbols=" + encodeURIComponent(symbols.join(",")),
    "idx.quotes.v1", Array.isArray, data => {
      rows = (data ?? []).filter(x => x && typeof x.symbol === "string")
        .map(x => ({ ...x, symbol: normalizeSymbol(x.symbol) }));
    });
}
function load() {
  loadMarket();
  loadQuotes();
}
let issuerCatalog;
let issuerSearchId = 0;
function loadIssuerCatalog() {
  issuerCatalog ??= get("./issuer-catalog.json?v=" + encodeURIComponent(document.querySelector('meta[name="idx-build"]')?.content || ""), undefined, "")
    .then(data => {
      if (!Array.isArray(data) || !data.length || !data.every(issuer =>
        typeof issuer?.symbol === "string" && validSymbol(issuer.symbol) && typeof issuer.name === "string")) {
        throw Error("Katalog emiten tidak valid");
      }
      return data;
    })
    .catch(error => {
      issuerCatalog = undefined;
      throw error;
    });
  return issuerCatalog;
}
$("issuer-query").addEventListener("input", () => {
  issuerSearchId++;
  $("issuer-results").replaceChildren();
  setLocalizedMessage($("issuer-status"), () => "");
});
$("issuer-search").addEventListener("submit", async event => {
  event.preventDefault();
  const id = ++issuerSearchId;
  const query = $("issuer-query").value.trim().toUpperCase();
  const ticker = normalizeSymbol(query);
  const status = $("issuer-status");
  const results = $("issuer-results");
  results.replaceChildren();
  if (query.length < 2) {
    setLocalizedMessage(status, () => tr("Masukkan minimal 2 karakter.", "Enter at least 2 characters."));
    return;
  }
  setLocalizedMessage(status, () => tr("Memuat katalog emiten…", "Loading issuer catalog…"));
  try {
    const catalog = await loadIssuerCatalog();
    if (id !== issuerSearchId) return;
    const rank = issuer => issuer.symbol === ticker ? 0 : issuer.symbol.startsWith(ticker) ? 1 : 2;
    const matches = catalog.filter(issuer => rank(issuer) < 2 || issuer.name.toUpperCase().includes(query))
      .sort((a, b) => rank(a) - rank(b) || a.symbol.localeCompare(b.symbol));
    const buttons = matches.slice(0, 8).map(issuer => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "stock";
      button.textContent = issuer.symbol + " · " + issuer.name;
      button.addEventListener("click", () => {
        $("symbol").value = issuer.symbol;
        $("symbol").removeAttribute("aria-invalid");
        setLocalizedMessage($("symbol-feedback"), () => "");
        $("symbol").focus();
      });
      return button;
    });
    results.replaceChildren(...buttons);
    setLocalizedMessage(status, () => matches.length ? tr("Menampilkan ", "Showing ") + buttons.length + tr(" dari ", " of ") + matches.length + tr(" hasil. Pilih emiten untuk mengisi ticker.", " results. Select an issuer to fill the ticker field.")
      : tr("Emiten tidak ditemukan di katalog.", "No issuers found in the catalog."));
  } catch {
    if (id === issuerSearchId) setLocalizedMessage(status, () => tr("Katalog tidak tersedia. Coba cari lagi atau masukkan ticker secara manual.", "Catalog unavailable. Try again or enter a ticker manually."));
  }
});
$("refresh").addEventListener("click", () => {
  if (!marketPanel.loading && !quotesPanel.loading) load();
});
$("retry-market").addEventListener("click", () => {
  $("refresh").focus();
  loadMarket();
});
$("retry-quotes").addEventListener("click", () => {
  $("symbol").focus();
  loadQuotes();
});
$("symbol").addEventListener("input", () => {
  $("symbol").removeAttribute("aria-invalid");
  setLocalizedMessage($("symbol-feedback"), () => "");
});
$("add-stock").addEventListener("submit", e => {
  e.preventDefault();
  const input = $("symbol");
  const s = normalizeSymbol(input.value);
  const feedback = $("symbol-feedback");
  if (!validSymbol(s)) {
    setLocalizedMessage(feedback, () => tr("Masukkan ticker IDX yang valid, misalnya ASII.", "Enter a valid IDX ticker, such as ASII."));
    input.setAttribute("aria-invalid", "true");
    input.focus();
    return;
  }
  if (!symbols.includes(s)) {
    if (symbols.length >= 20) {
      setLocalizedMessage(feedback, () => tr("Watchlist sudah berisi 20 ticker.", "The watchlist already contains 20 tickers."));
      return;
    }
    symbols.push(s);
  }
  selected = s;
  updateHistory();
  input.value = "";
  input.removeAttribute("aria-invalid");
  setLocalizedMessage(feedback, () => "");
  loadQuotes();
});
$("explorer-search").addEventListener("input", e => { filter = e.target.value.trim().toUpperCase(); render(); });
$("explorer-sort").addEventListener("change", e => { sort = allowedSorts.has(e.target.value) ? e.target.value : "symbol"; render(); });
let historyPoints;
let historyRequest;
let historyKey = "";
function drawHistory(points) {
  const days = points.map(point => Date.parse(point.date) / 86400000);
  const closes = points.map(point => point.close);
  const low = Math.min(...closes), high = Math.max(...closes);
  const maxVolume = Math.max(0, ...points.map(point => point.volume ?? 0));
  const span = days.at(-1) - days[0];
  const x = i => span ? 3 + 394 * (days[i] - days[0]) / span : 200;
  const y = close => high === low ? 58 : 6 + 104 * (high - close) / (high - low);
  const width = Math.min(9, 340 / Math.max(1, span));
  // Plot observations at their calendar dates and leave unreported days blank.
  $("history-price-path").setAttribute("d", points.map((point, i) =>
    "M" + x(i) + " " + y(point.close) + "h0.1").join(" "));
  $("history-volume-path").setAttribute("d", points.map((point, i) => {
    if (!point.volume) return "";
    const height = 62 * point.volume / maxVolume;
    return "M" + (x(i) - width / 2) + " 64v-" + height + "h" + width + "v" + height + "Z";
  }).join(" "));
  $("history-dates").textContent = points[0].date + " – " + points.at(-1).date + " · " + points.length + tr(" hari dengan data", " days with data");
  $("history-price-range").textContent = tr("Rentang penutupan · ", "Closing price range · ") + money(low) + " – " + money(high);
  $("history-volume-range").textContent = maxVolume ? tr("Volume tertinggi · ", "Highest volume · ") + number(maxVolume) + tr(" saham", " shares") : tr("Volume tidak tersedia.", "Volume unavailable.");
  const tableRows = points.map(point => {
    const row = document.createElement("tr");
    for (const value of [point.date, number(point.close), number(point.volume)]) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.append(cell);
    }
    return row;
  });
  $("history-rows").replaceChildren(...tableRows);
}
async function updateHistory(force = false) {
  if (!$("history-panel").open) {
    historyRequest?.abort();
    historyRequest = undefined;
    historyKey = "";
    return;
  }
  const symbol = selected;
  const range = $("history-range").value;
  const key = symbol + ":" + range;
  if (!force && key === historyKey) return;
  historyKey = key;
  historyRequest?.abort();
  const request = new AbortController();
  historyRequest = request;
  const status = $("history-status");
  historyPoints = undefined;
  $("history-data").hidden = true;
  $("history-retry").hidden = true;
  setLocalizedMessage(status, () => tr("Memuat histori ", "Loading history for ") + symbol + "…");
  try {
    const response = await get("/api/history?" + new URLSearchParams({ symbol, range }), request.signal);
    if (historyRequest !== request) return;
    const { data, provider, stale, cached, warnings } = ensureEnvelope(response, "idx.daily-history.v1",
      data => data?.symbol === symbol && data.range === range && Array.isArray(data.points)
        && data.points.length <= 1100 && data.points.every((point, i, list) =>
          typeof point?.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(point.date)
          && Number.isFinite(Date.parse(point.date)) && (!i || list[i - 1].date < point.date)
          && Number.isFinite(point.close) && point.close > 0
          && (point.volume === null || (Number.isFinite(point.volume) && point.volume >= 0))));
    if (!data.points.length) {
      setLocalizedMessage(status, () => tr("Belum ada data historis ", "No historical data for ") + symbol + tr(" untuk rentang ini.", " in this range."));
      return;
    }
    historyPoints = data.points;
    drawHistory(historyPoints);
    $("history-data").hidden = false;
    setLocalizedMessage(status, () => symbol + " · " + (provider || tr("Provider tidak diketahui", "Unknown provider"))
      + (stale ? tr(" · Data lama dari provider", " · Stale provider data") : cached ? tr(" · Respons dari cache", " · Cached response") : "")
      + (warnings?.length ? tr(" · Dapat berisi data tidak lengkap", " · Data may be incomplete") : ""));
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

const staticCopy = [];
for (const [selector, attr] of [
  ["[data-en]", null], ["[data-en-aria-label]", "aria-label"], ["[data-en-placeholder]", "placeholder"],
  ["[data-en-content]", "content"],
]) {
  for (const element of document.querySelectorAll?.(selector) ?? []) {
    const id = attr ? element.getAttribute(attr) : element.textContent;
    const en = element.getAttribute(attr ? "data-en-" + attr : "data-en");
    staticCopy.push(() => {
      if (attr) element.setAttribute(attr, tr(id, en));
      else element.textContent = tr(id, en);
    });
  }
}
function applyLanguage() {
  if (document.documentElement) document.documentElement.lang = language;
  $("dashboard-language").value = language;
  setFormats();
  staticCopy.forEach(update => update());
  for (const [element, message] of localizedMessages) element.textContent = message();
  if (historyPoints && !$("history-data").hidden) drawHistory(historyPoints);
}
$("dashboard-language").addEventListener("change", event => {
  language = event.target.value === "en" ? "en" : "id";
  try {
    globalThis.localStorage?.setItem("idx-language", language);
  } catch {
    // Apply the selected language for this page even without storage.
  }
  applyLanguage();
  render();
});
applyLanguage();
load();
