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
  if (panel.error) return "Gagal memuat data: " + panel.error + ".";
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
    b.addEventListener("click", () => { selected = q.symbol; render(); }); return b;
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
  $("market-status").textContent = market?.market_open === true ? "Pasar buka" : market?.market_open === false ? "Pasar tutup" : "Status sesi belum diketahui";
  $("updated").textContent = "Waktu data pasar · " + date(market?.as_of);
  $("market-source").textContent = "Provider · " + (marketPanel.meta?.provider || "—");
  $("mode").textContent = marketPanel.loading ? "Memuat data pasar…" : marketPanel.error ? "Data pasar tidak tersedia"
    : marketPanel.meta?.stale || market?.behind_session ? "Data pasar tertunda" : "Snapshot pasar";
  const loading = marketPanel.loading || quotesPanel.loading;
  $("refresh").setAttribute("aria-disabled", String(loading));
  $("refresh-label").textContent = loading ? "Memuat data…" : "Refresh data";
  $("retry-market").hidden = !marketPanel.error;
  $("retry-quotes").hidden = !quotesPanel.error;
  $("market-notice").textContent = metaState(marketPanel);
  const missing = quotesPanel.meta && !quotesPanel.loading ? symbols.filter(s => !rows.some(q => q.symbol === s)) : [];
  notice(metaState(quotesPanel) + (missing.length ? " · Tidak ditemukan: " + missing.join(", ") : ""));
}
async function get(path, signal) {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), 55000);
  const abort = () => timeout.abort();
  signal.addEventListener("abort", abort, { once: true });
  try {
    const response = await fetch(apiBase + path, { signal: timeout.signal, headers: { Accept: "application/json" } });
    if (!response.ok) throw Error("HTTP " + response.status);
    const body = await response.json();
    if (body?.error) throw Error(body.error.message || "API error");
    return body;
  } finally { clearTimeout(timer); signal.removeEventListener("abort", abort); }
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
    panel.meta = null;
    panel.error = e.name === "AbortError" ? "request timeout (55 detik)" : e.message;
    accept(null);
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
  input.value = "";
  input.removeAttribute("aria-invalid");
  feedback.textContent = "";
  loadQuotes();
});
$("explorer-search").addEventListener("input", e => { filter = e.target.value.trim().toUpperCase(); render(); });
$("explorer-sort").addEventListener("change", e => { sort = allowedSorts.has(e.target.value) ? e.target.value : "symbol"; render(); });
load();
