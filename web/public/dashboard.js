const apiBase = document.querySelector('meta[name="idx-api-base"]')?.content.trim().replace(/\/+$/, "") || "";
const $ = (id) => document.getElementById(id);
const fmt = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 2 });
const number = (n) => Number.isFinite(n) ? fmt.format(n) : "—";
const money = (n) => Number.isFinite(n) ? "Rp" + fmt.format(n) : "—";
const signed = (n, unit = "") => Number.isFinite(n) ? (n > 0 ? "+" : "") + fmt.format(n) + unit : "—";
const cls = (n) => n > 0 ? "positive" : n < 0 ? "negative" : "";
const date = (value) => { if (!value) return "—"; const d = new Date(value); return Number.isNaN(d.getTime()) ? "—" : new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Jakarta" }).format(d) + " WIB"; };
const allowedSorts = new Set(["symbol", "price", "change_pct", "volume"]);
const normalizeSymbol = (s) => String(s || "").trim().toUpperCase().replace(/\.JK$/, "");
const validSymbol = (s) => /^[A-Z0-9][A-Z0-9-]{0,11}$/.test(s);
const ensureEnvelope = (body, schema, isValid) => {
  if (!body || body.schema !== schema || !isValid(body.data)) throw Error("Format respons API tidak sesuai (" + schema + ")");
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
function metaState(panel) {
  if (panel.loading) return panel.meta ? "Memperbarui data…" : "Menghubungkan ke API… Server dapat memerlukan waktu untuk aktif.";
  if (panel.error) {
    const message = "Gagal memuat data: " + panel.error + ".";
    return panel.meta ? message + " Menampilkan data terakhir yang berhasil diambil pada " + date(panel.meta.fetched_at) + "." : message;
  }
  const meta = panel.meta;
  if (!meta) return "";
  const state = [];
  if (meta.data?.behind_session === true) state.push("Data tertinggal dari sesi terakhir");
  else if (meta.stale) state.push("Data lama dari provider");
  if (meta.cached) state.push("Respons dari cache");
  if (meta.warnings?.length) state.push("Provider melaporkan keterbatasan data");
  state.push("Respons diambil " + date(meta.fetched_at));
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
    ? "Snapshot · " + number(market.quoted) + " dari " + number(market.universe) + " saham tercakup"
    : "Cakupan snapshot pasar belum tersedia.";

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
        volume.textContent = number(item.volume) + (Number.isFinite(item.volume) ? " saham" : "");
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
      empty.textContent = marketPanel.loading ? "Memuat data pasar…" : "Data belum tersedia";
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
    const company = document.createElement("div"); company.className = "company"; company.textContent = q.name || "Nama belum tersedia";
    const price = document.createElement("div"); price.className = "price"; price.textContent = money(q.price);
    const change = document.createElement("div"); change.className = "change " + cls(q.change_pct); change.textContent = signed(q.change_pct, "%");
    left.append(ticker, company); right.append(price, change); b.append(left, right);
    b.addEventListener("click", () => { selected = q.symbol; render(); updateHistory(); }); return b;
  });
  $("stocks").replaceChildren(...list);
  if (focusedTicker) list.find(button => button.dataset.ticker === focusedTicker)?.focus({ preventScroll: true });
  $("empty").textContent = !visible.length && !quotesPanel.loading && !quotesPanel.error ? (filter && rows.length ? "Tidak ada saham yang cocok dengan pencarian." : "Data saham belum tersedia.") : "";
  const q = rows.find(x => x.symbol === selected);
  $("detail-title").textContent = selected + " · Detail saham";
  $("detail-name").textContent = q?.name || "Data belum tersedia";
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
  $("market-status").textContent = marketPanel.error ? "Status sesi belum diperbarui" : market?.market_open === true ? "Pasar buka" : market?.market_open === false ? "Pasar tutup" : "Status sesi belum diketahui";
  $("updated").textContent = "Waktu data pasar · " + date(market?.as_of);
  $("market-source").textContent = "Provider · " + (marketPanel.meta?.provider || "—");
  $("mode").textContent = marketPanel.loading ? "Memuat data pasar…" : marketPanel.error ? (marketPanel.meta ? "Snapshot sebelumnya" : "Data pasar tidak tersedia")
    : marketPanel.meta?.stale || market?.behind_session ? "Data pasar tertunda" : "Snapshot pasar";
  const loading = marketPanel.loading || quotesPanel.loading;
  $("refresh").setAttribute("aria-disabled", String(loading));
  $("refresh-label").textContent = loading ? "Memuat data…" : "Refresh data";
  $("retry-market").hidden = !marketPanel.error;
  $("retry-quotes").hidden = !quotesPanel.error;
  $("market-notice").textContent = metaState(marketPanel);
  const missing = quotesPanel.meta && !quotesPanel.loading && !quotesPanel.error ? symbols.filter(s => !rows.some(q => q.symbol === s)) : [];
  notice(metaState(quotesPanel) + (missing.length ? " · Tidak ditemukan: " + missing.join(", ") : ""));
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
    panel.error = e.name === "AbortError" ? "request timeout (55 detik)" : e.message;
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
  $("issuer-status").textContent = "";
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
    status.textContent = "Masukkan minimal 2 karakter.";
    return;
  }
  status.textContent = "Memuat katalog emiten…";
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
        $("symbol-feedback").textContent = "";
        $("symbol").focus();
      });
      return button;
    });
    results.replaceChildren(...buttons);
    status.textContent = matches.length ? "Menampilkan " + buttons.length + " dari " + matches.length + " hasil. Pilih emiten untuk mengisi ticker."
      : "Emiten tidak ditemukan di katalog.";
  } catch {
    if (id === issuerSearchId) status.textContent = "Katalog tidak tersedia. Coba cari lagi atau masukkan ticker secara manual.";
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
  $("symbol-feedback").textContent = "";
});
$("add-stock").addEventListener("submit", e => {
  e.preventDefault();
  const input = $("symbol");
  const s = normalizeSymbol(input.value);
  const feedback = $("symbol-feedback");
  if (!validSymbol(s)) {
    feedback.textContent = "Masukkan ticker IDX yang valid, misalnya ASII.";
    input.setAttribute("aria-invalid", "true");
    input.focus();
    return;
  }
  if (!symbols.includes(s)) {
    if (symbols.length >= 20) {
      feedback.textContent = "Watchlist sudah berisi 20 ticker.";
      return;
    }
    symbols.push(s);
  }
  selected = s;
  updateHistory();
  input.value = "";
  input.removeAttribute("aria-invalid");
  feedback.textContent = "";
  loadQuotes();
});
$("explorer-search").addEventListener("input", e => { filter = e.target.value.trim().toUpperCase(); render(); });
$("explorer-sort").addEventListener("change", e => { sort = allowedSorts.has(e.target.value) ? e.target.value : "symbol"; render(); });
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
  $("history-dates").textContent = points[0].date + " – " + points.at(-1).date + " · " + points.length + " hari dengan data";
  $("history-price-range").textContent = "Rentang penutupan · " + money(low) + " – " + money(high);
  $("history-volume-range").textContent = maxVolume ? "Volume tertinggi · " + number(maxVolume) + " saham" : "Volume tidak tersedia.";
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
  $("history-data").hidden = true;
  $("history-retry").hidden = true;
  status.textContent = "Memuat histori " + symbol + "…";
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
      status.textContent = "Belum ada data historis " + symbol + " untuk rentang ini.";
      return;
    }
    drawHistory(data.points);
    $("history-data").hidden = false;
    status.textContent = symbol + " · " + (provider || "Provider tidak diketahui")
      + (stale ? " · Data lama dari provider" : cached ? " · Respons dari cache" : "")
      + (warnings?.length ? " · Dapat berisi data tidak lengkap" : "");
  } catch {
    if (historyRequest !== request) return;
    status.textContent = "Histori " + symbol + " belum dapat dimuat.";
    $("history-retry").hidden = false;
  }
}
$("history-panel").addEventListener("toggle", () => updateHistory());
$("history-range").addEventListener("change", () => updateHistory());
$("history-retry").addEventListener("click", () => {
  $("history-range").focus();
  updateHistory(true);
});

load();
