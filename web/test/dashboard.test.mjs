import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const script = readFileSync(new URL("../public/dashboard.js", import.meta.url), "utf8");
function setup({ fail = false, invalid = false, fetchOverride, marketData = {}, marketMeta = {} } = {}) {
  const elements = new Map(), calls = [];
  const element = () => ({
    textContent: "", value: "", disabled: false, children: [], style: {}, dataset: {}, attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; },
    focus() { document.activeElement = this; this.focused = true; },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    addEventListener(name, handler) { this[name] = handler; },

  });
  const document = {
    querySelector: () => ({ content: "https://api.example.test/" }),
    createElement: element,
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id);
    },
  };
  runInNewContext(script, {
    document, AbortController, setTimeout, clearTimeout,
    async fetch(url) {
      calls.push(url);
      const override = fetchOverride?.(url);
      if (override) return override;
      if (fail) return { ok: false, status: 503 };
      return { ok: true, async json() {
        if (url.endsWith("/market")) return {
          schema: invalid ? "invalid" : "idx.market.v1", provider: "fixture", stale: true,
          fetched_at: "2026-11-18T04:00:00Z", ...marketMeta,
          data: { index: { price: 7000, change_pct: 1 }, market_open: false,
            as_of: "2026-11-18T10:00:00+07:00", gainers: [], losers: [], behind_session: true, ...marketData }
        };
        return { schema: "idx.quotes.v1", provider: "fixture", stale: false,
          fetched_at: "2026-11-18T04:00:00Z",
          data: [{ symbol: "BBCA", name: "Bank Central Asia", price: 123, change_pct: 1, volume: 20 },
                 { symbol: "BBRI", name: "Bank Rakyat Indonesia", price: 120, change_pct: -2, volume: 40 }] };
      } };
    }
  });
  return { elements, calls };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test("live API loads automatically, no demo mode, stale metadata is visible", async () => {
  const { elements, calls } = setup();
  await tick();
  assert.deepEqual(calls, [
    "https://api.example.test/api/market",
    "https://api.example.test/api/quote?symbols=BBCA%2CBBRI%2CTLKM",
  ]);
  assert.match(elements.get("market-notice").textContent, /tertinggal/);
  assert.match(elements.get("mode").textContent, /tertunda/);
  assert.equal(elements.get("detail-price").textContent, "Rp123");
  assert.equal(elements.get("stocks").children.length, 2);
});

test("filter and sort operate on returned live quotes", async () => {
  const { elements } = setup();
  await tick();
  elements.get("explorer-sort").value = "volume";
  elements.get("explorer-sort").change({ target: elements.get("explorer-sort") });
  assert.equal(elements.get("stocks").children[0].children[0].children[0].textContent, "BBRI");
  elements.get("explorer-search").input({ target: { value: "BBCA" } });
  assert.equal(elements.get("stocks").children.length, 1);
});

test("provider errors do not fall back to fabricated sample prices", async () => {
  const { elements } = setup({ fail: true });
  await tick();
  assert.match(elements.get("notice").textContent, /HTTP 503/);
  assert.equal(elements.get("detail-price").textContent, "—");
  assert.equal(elements.get("stocks").children.length, 0);
});

test("API schema mismatch is rejected rather than silently displayed", async () => {
  const { elements } = setup({ invalid: true });
  await tick();
  assert.match(elements.get("market-notice").textContent, /Format respons API tidak sesuai/);
  assert.equal(elements.get("ihsg").textContent, "—");
});

test("market insight visualizations use only API breadth and movers", async () => {
  const { elements } = setup();
  await tick();
  assert.equal(elements.get("advancing").textContent, "—");
  assert.equal(elements.get("gainers-list").children.length, 1);
  assert.match(elements.get("gainers-list").children[0].textContent, /Data belum tersedia/);
});


test("market remains visible when quote request fails", async () => {
  const { elements } = setup({
    fetchOverride: url => url.includes("/quote?") && { ok: false, status: 503 },
  });
  await tick();
  assert.equal(elements.get("ihsg").textContent, "7.000");
  assert.match(elements.get("notice").textContent, /HTTP 503/);
  assert.equal(elements.get("detail-price").textContent, "—");
  assert.equal(elements.get("refresh").attributes["aria-disabled"], "false");
});

test("an invalid market response leaves watchlist quotes usable", async () => {
  const { elements } = setup({ invalid: true });
  await tick();
  assert.equal(elements.get("ihsg").textContent, "—");
  assert.equal(elements.get("stocks").children.length, 2);
  assert.equal(elements.get("detail-price").textContent, "Rp123");
});

test("market renders while quotes load, and only the latest watchlist request wins", async () => {
  let resolveOldQuotes;
  const oldQuotes = new Promise(resolve => { resolveOldQuotes = resolve; });
  const { elements, calls } = setup({
    fetchOverride: url => url.endsWith("BBCA%2CBBRI%2CTLKM") && oldQuotes,
  });
  await tick();
  assert.equal(elements.get("ihsg").textContent, "7.000");
  assert.equal(elements.get("refresh").attributes["aria-disabled"], "true");
  elements.get("symbol").value = "asii.jk";
  elements.get("add-stock").submit({ preventDefault() {} });
  await tick();
  assert.equal(calls.filter(url => url.endsWith("/market")).length, 1);
  assert.match(calls.at(-1), /%2CASII$/);
  assert.match(elements.get("notice").textContent, /Tidak ditemukan: .*ASII/);
  resolveOldQuotes({ ok: false, status: 503 });
  await tick();
  assert.equal(elements.get("stocks").children.length, 2);
  assert.equal(elements.get("refresh").attributes["aria-disabled"], "false");
  assert.doesNotMatch(elements.get("notice").textContent, /503/);
});


test("breadth visual and most active values reflect the snapshot payload", async () => {
  const { elements } = setup({
    marketData: {
      advancing: 2, declining: 1, unchanged: 1, quoted: 4, universe: 6,
      most_active: [{ symbol: "BBCA", value: 18000, volume: 9, price: 2000 },
                    { symbol: "BBRI", value: null, volume: null, price: 1000 }],
    },
  });
  await tick();
  assert.match(elements.get("breadth-caption").textContent, /4 dari 6/);
  assert.equal(elements.get("breadth-track").hidden, false);
  assert.deepEqual(["up", "down", "flat"].map(key => elements.get("breadth-" + key).style.width), ["50%", "25%", "25%"]);
  const [first, second] = elements.get("most_active-list").children;
  assert.equal(first.children[1].children[0], "Rp18.000");
  assert.equal(first.children[1].children[1].textContent, "9 saham");
  assert.equal(second.children[1].children[0], "—");
  assert.equal(second.children[1].children[1].textContent, "—");
});

test("missing breadth categories leave the distribution hidden", async () => {
  const { elements } = setup({ marketData: { advancing: 3, declining: null, unchanged: 1 } });
  await tick();
  assert.equal(elements.get("breadth-track").hidden, true);
  assert.equal(elements.get("declining").textContent, "—");
});

test("cached responses, session closure, and provider lag have distinct labels", async () => {
  const { elements } = setup({
    marketMeta: { cached: true, stale: false },
    marketData: { behind_session: false },
  });
  await tick();
  assert.match(elements.get("market-notice").textContent, /cache/);
  assert.doesNotMatch(elements.get("market-notice").textContent, /tertinggal|lama/);
  assert.equal(elements.get("market-status").textContent, "Pasar tutup");
  assert.match(elements.get("updated").textContent, /Waktu data pasar.*WIB/);
});

test("contextual retry fetches only the failed panel and shows refresh feedback", async () => {
  let quoteAttempts = 0;
  const { elements, calls } = setup({
    fetchOverride: url => url.includes("/quote?") && ++quoteAttempts === 1 && { ok: false, status: 503 },
  });
  await tick();
  assert.equal(elements.get("retry-quotes").hidden, false);
  assert.equal(elements.get("retry-market").hidden, true);
  elements.get("retry-quotes").click();
  assert.equal(elements.get("refresh-label").textContent, "Memuat data…");
  assert.equal(elements.get("retry-quotes").hidden, true);
  await tick();
  assert.equal(elements.get("refresh-label").textContent, "Refresh data");
  assert.equal(elements.get("detail-price").textContent, "Rp123");
  assert.equal(calls.filter(url => url.endsWith("/market")).length, 1);
});

test("invalid ticker feedback is attached to its field and triggers no API request", async () => {
  const { elements, calls } = setup();
  await tick();
  const input = elements.get("symbol");
  input.value = "AAPL.US";
  elements.get("add-stock").submit({ preventDefault() {} });
  assert.equal(input.attributes["aria-invalid"], "true");
  assert.match(elements.get("symbol-feedback").textContent, /ticker IDX yang valid/);
  assert.equal(calls.length, 2);
  input.input();
  assert.equal(input.attributes["aria-invalid"], undefined);
});

test("selecting a watchlist row preserves keyboard focus and updates its pressed state", async () => {
  const { elements } = setup();
  await tick();
  const stockList = elements.get("stocks");
  const oldButton = stockList.children[1];
  oldButton.focus();
  oldButton.click();
  const [bbca, bbri] = stockList.children;
  assert.equal(bbca.attributes["aria-pressed"], "false");
  assert.equal(bbri.attributes["aria-pressed"], "true");
  assert.equal(bbri.focused, true);
  assert.match(elements.get("detail-title").textContent, /^BBRI/);
});
