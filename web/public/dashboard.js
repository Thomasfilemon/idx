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
  if (panel.loading) return "Menghubungkan ke API… Server dapat memerlukan waktu untuk aktif.";
  if (panel.error) return "Gagal memuat data: " + panel.error + ". Coba Refresh.";
  const meta = panel.meta;
  if (!meta) return "";
  const stale = meta.stale || meta.data?.behind_session === true;
  return (stale ? "STALE · " : meta.cached ? "CACHED · " : "") + "Diambil " + date(meta.fetched_at);
}
function renderInsights() {
  for (const key of ["advancing", "declining", "unchanged", "quoted"]) $(key).textContent = number(market?.[key]);
  const up = Number.isFinite(market?.advancing) ? market.advancing : 0;
  const flat = Number.isFinite(market?.unchanged) ? market.unchanged : 0;
  const down = Number.isFinite(market?.declining) ? market.declining : 0;
  const total = up + flat + down;
  $("breadth-up").style.width = total ? (100 * up / total) + "%" : "0%";
  $("breadth-flat").style.width = total ? (100 * flat / total) + "%" : "0%";
  $("breadth-down").style.width = total ? (100 * down / total) + "%" : "0%";
  for (const key of ["gainers", "losers"]) {
    const items = Array.isArray(market?.[key]) ? market[key].slice(0, 5) : [];
    const nodes = items.map(item => {
      const row = document.createElement("div"); row.className = "mover";
      const symbol = document.createElement("strong"); symbol.textContent = item.symbol || "—";
      const change = document.createElement("span"); change.className = cls(item.change_pct);
      change.textContent = signed(item.change_pct, "%");
      row.append(symbol, change); return row;
    });
    if (!nodes.length) {
      const empty = document.createElement("p"); empty.className = "movers-empty";
      empty.textContent = marketPanel.loading ? "Memuat data pasar…" : "Data belum tersedia";
      nodes.push(empty);
    }
    $(key + "-list").replaceChildren(...nodes);
  }
}
function render() {
  renderInsights();
  const visible = sortRows(rows.filter(q => q.symbol.toUpperCase().includes(filter) || String(q.name || "").toUpperCase().includes(filter)), sort);
  const list = visible.map(q => {
    const b = document.createElement("button"); b.type = "button";
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
  $("empty").textContent = !visible.length && !quotesPanel.loading && !quotesPanel.error ? (filter && rows.length ? "Tidak ada saham yang cocok dengan pencarian." : "Data saham belum tersedia.") : "";
  const q = rows.find(x => x.symbol === selected);
  $("detail-title").textContent = selected + " · Detail saham";
  $("detail-name").textContent = q?.name || "Data belum tersedia";
  $("detail-source").textContent = quotesPanel.meta?.provider || "—";
  $("detail-price").textContent = money(q?.price);
  $("detail-change").textContent = signed(q?.change) + " (" + signed(q?.change_pct, "%") + ")";
  $("detail-change").className = cls(q?.change_pct);
  $("detail-volume").textContent = number(q?.volume);
  $("detail-time").textContent = date(q?.market_time);
  const ix = market?.index;
  $("ihsg").textContent = number(ix?.price);
  $("ihsg-change").textContent = ix?.change_pct == null ? "Data IHSG belum tersedia" : signed(ix.change) + " (" + signed(ix.change_pct, "%") + ")";
  $("ihsg-change").className = "delta " + cls(ix?.change_pct);
  $("market-status").textContent = market?.market_open === true ? "Market open" : market?.market_open === false ? "Market closed" : "Market status tidak diketahui";
  $("updated").textContent = market?.as_of ? "Market: " + date(market.as_of) : "—";
  $("mode").textContent = marketPanel.loading ? "Loading…" : marketPanel.error ? "Market unavailable" : marketPanel.meta?.stale || market?.behind_session ? "Stale data" : "Market snapshot";
  $("refresh").disabled = marketPanel.loading || quotesPanel.loading;
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
$("refresh").addEventListener("click", load);
$("add").addEventListener("click", () => {
  const s = normalizeSymbol($("symbol").value);
  if (!validSymbol(s)) { notice("Masukkan ticker IDX yang valid, misalnya ASII."); return; }
  if (!symbols.includes(s)) {
    if (symbols.length >= 20) { notice("Maksimal 20 ticker."); return; }
    symbols.push(s);
  }
  selected = s; $("symbol").value = ""; loadQuotes();
});
$("symbol").addEventListener("keydown", e => { if (e.key === "Enter") $("add").click(); });
$("explorer-search").addEventListener("input", e => { filter = e.target.value.trim().toUpperCase(); render(); });
$("explorer-sort").addEventListener("change", e => { sort = allowedSorts.has(e.target.value) ? e.target.value : "symbol"; render(); });
load();
