import { createPanelState, loadPanel } from "./api.mjs";

const allowedSorts = new Set(["symbol", "price", "change_pct", "volume"]);
const normalizeSymbol = (s) => String(s || "").trim().toUpperCase().replace(/\.JK$/, "");
const validSymbol = (s) => /^[A-Z0-9][A-Z0-9-]{0,11}$/.test(s);

const sortRows = (items, sort) => [...items].sort((a, b) => {
  if (sort === "symbol") return a.symbol.localeCompare(b.symbol);
  const x = a[sort], y = b[sort];
  if (!Number.isFinite(x)) return Number.isFinite(y) ? 1 : a.symbol.localeCompare(b.symbol);
  if (!Number.isFinite(y)) return -1;
  return y - x || a.symbol.localeCompare(b.symbol);
});

export function createWatchlistPanel({ document, api, formatting, i18n, metaState, onSelect, onStatusChange }) {
  const $ = id => document.getElementById(id);
  const { number, money, signed, cls, date, quoteChange } = formatting;
  const { tr, setLocalizedMessage } = i18n;
  const symbols = ["BBCA", "BBRI", "TLKM"];
  let selected = "BBCA", rows = [];
  let filter = "", sort = "symbol";
  const quotesPanel = createPanelState();

  function renderList() {
    const focusedStock = document.activeElement;
    const focusedTicker = focusedStock?.dataset?.ticker;
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
      b.addEventListener("click", () => {
        if (selected === q.symbol) return;
        selected = q.symbol;
        renderList();
        renderDetail();
        onSelect();
      });
      return b;
    });
    $("stocks").replaceChildren(...list);
    if (focusedTicker) list.find(button => button.dataset.ticker === focusedTicker)?.focus({ preventScroll: true });
    $("empty").textContent = !visible.length && !quotesPanel.loading && !quotesPanel.error ? (filter && rows.length ? tr("Tidak ada saham yang cocok dengan pencarian.", "No stocks match your search.") : tr("Data saham belum tersedia.", "Stock data is unavailable.")) : "";
  }
  function renderDetail() {
    const q = rows.find(x => x.symbol === selected);
    $("detail-title").textContent = selected + tr(" · Detail saham", " · Stock details");
    $("detail-name").textContent = q?.name || tr("Data belum tersedia", "Data unavailable");
    $("detail-source").textContent = quotesPanel.meta?.provider || "—";
    $("detail-price").textContent = money(q?.price);
    $("detail-change").textContent = quoteChange(q?.change, q?.change_pct);
    $("detail-change").className = cls(q?.change_pct);
    $("detail-volume").textContent = number(q?.volume);
    $("detail-time").textContent = date(q?.market_time);
  }
  function render() {
    renderList();
    renderDetail();
    $("retry-quotes").hidden = !quotesPanel.error;
    const missing = quotesPanel.meta && !quotesPanel.loading && !quotesPanel.error ? symbols.filter(s => !rows.some(q => q.symbol === s)) : [];
    $("notice").textContent = metaState(quotesPanel) + (missing.length ? tr(" · Tidak ditemukan: ", " · Not found: ") + missing.join(", ") : "");
  }
  function refresh() {
    render();
    onStatusChange();
  }
  function loadQuotes() {
    return loadPanel(api, quotesPanel, "/api/quote?symbols=" + encodeURIComponent(symbols.join(",")),
      "idx.quotes.v1", Array.isArray, data => {
        rows = (data ?? []).filter(x => x && typeof x.symbol === "string")
          .map(x => ({ ...x, symbol: normalizeSymbol(x.symbol) }));
      }, refresh);
  }

  let issuerCatalog;
  let issuerSearchId = 0;
  function loadIssuerCatalog() {
    issuerCatalog ??= api.get("./issuer-catalog.json?v=" + encodeURIComponent(document.querySelector('meta[name="idx-build"]')?.content || ""), undefined, "")
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
    onSelect();
    input.value = "";
    input.removeAttribute("aria-invalid");
    setLocalizedMessage(feedback, () => "");
    loadQuotes();
  });
  $("explorer-search").addEventListener("input", e => { filter = e.target.value.trim().toUpperCase(); renderList(); });
  $("explorer-sort").addEventListener("change", e => { sort = allowedSorts.has(e.target.value) ? e.target.value : "symbol"; renderList(); });
  return { render, load: loadQuotes, selected: () => selected, isLoading: () => quotesPanel.loading };
}
