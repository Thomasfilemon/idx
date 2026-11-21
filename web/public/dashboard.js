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
let selected = "BBCA", rows = [], market = null, quoteMeta = null, marketMeta = null;
let status = "loading", message = "", filter = "", sort = "symbol", loadId = 0;
let controller = null;
function notice(text) { $("notice").textContent = text; }
function metaState() {
  if (!quoteMeta || !marketMeta) return "";
  const stale = quoteMeta.stale || marketMeta.stale || marketMeta.data?.behind_session === true;
  return (stale ? "STALE · " : quoteMeta.cached || marketMeta.cached ? "CACHED · " : "LIVE · ") +
    "Quote " + date(quoteMeta.fetched_at) + " · Market " + date(marketMeta.fetched_at);
}
function render() {
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
  $("empty").textContent = status === "loading" ? "Memuat data saham…" : status === "error" ? "Data tidak tersedia. Coba refresh." : !visible.length ? "Tidak ada saham yang cocok dengan pencarian." : "";
  const q = rows.find(x => x.symbol === selected);
  $("detail-title").textContent = selected + " · Detail saham";
  $("detail-name").textContent = q?.name || "Data belum tersedia";
  $("detail-source").textContent = quoteMeta?.provider || "—";
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
  $("mode").textContent = status === "loading" ? "Loading…" : status === "error" ? "API unavailable" : quoteMeta?.stale || marketMeta?.stale || market?.behind_session ? "Stale data" : "Live API";
  $("refresh").disabled = status === "loading";
  notice(message || (status === "loading" ? "Menghubungkan ke API, server gratis mungkin perlu waktu untuk aktif…" : metaState()));
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
async function load() {
  const id = ++loadId;
  controller?.abort(); controller = new AbortController();
  status = "loading"; message = ""; rows = []; market = null; quoteMeta = null; marketMeta = null; render();
  try {
    const [m, q] = await Promise.all([
      get("/api/market", controller.signal),
      get("/api/quote?symbols=" + encodeURIComponent(symbols.join(",")), controller.signal)
    ]);
    if (id !== loadId) return;
    ensureEnvelope(m, "idx.market.v1", x => x && typeof x === "object" && Array.isArray(x.gainers) && Array.isArray(x.losers));
    ensureEnvelope(q, "idx.quotes.v1", Array.isArray);
    market = m.data; marketMeta = m; quoteMeta = q;
    rows = q.data.filter(x => x && typeof x.symbol === "string").map(x => ({ ...x, symbol: normalizeSymbol(x.symbol) }));
    status = "ready";
    const missing = symbols.filter(s => !rows.some(q => q.symbol === s));
    message = metaState() + (missing.length ? " · Tidak ditemukan: " + missing.join(", ") : "");
  } catch (e) {
    if (id !== loadId) return;
    status = "error"; rows = []; market = null; quoteMeta = null; marketMeta = null;
    message = "Gagal memuat live data: " + (e.name === "AbortError" ? "request timeout (55 detik)" : e.message) + ". Coba Refresh.";
  }
  render();
}
$("refresh").addEventListener("click", load);
$("add").addEventListener("click", () => {
  const s = normalizeSymbol($("symbol").value);
  if (!validSymbol(s)) { notice("Masukkan ticker IDX yang valid, misalnya ASII."); return; }
  if (!symbols.includes(s)) {
    if (symbols.length >= 20) { notice("Maksimal 20 ticker."); return; }
    symbols.push(s);
  }
  selected = s; $("symbol").value = ""; load();
});
$("symbol").addEventListener("keydown", e => { if (e.key === "Enter") $("add").click(); });
$("explorer-search").addEventListener("input", e => { filter = e.target.value.trim().toUpperCase(); render(); });
$("explorer-sort").addEventListener("change", e => { sort = allowedSorts.has(e.target.value) ? e.target.value : "symbol"; render(); });
load();
