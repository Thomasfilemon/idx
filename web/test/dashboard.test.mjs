import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const script = readFileSync(new URL("../public/dashboard.js", import.meta.url), "utf8");
function setup({ fail = false, invalid = false, fetchOverride } = {}) {
  const elements = new Map(), calls = [];
  const element = () => ({
    textContent: "", value: "", disabled: false, children: [], style: {},
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
          fetched_at: "2026-11-18T04:00:00Z",
          data: { index: { price: 7000, change_pct: 1 }, market_open: false,
            as_of: "2026-11-18T10:00:00+07:00", gainers: [], losers: [], behind_session: true }
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
  assert.match(elements.get("market-notice").textContent, /STALE/);
  assert.match(elements.get("mode").textContent, /Stale data/);
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
  assert.equal(elements.get("refresh").disabled, false);
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
  assert.equal(elements.get("refresh").disabled, true);
  elements.get("symbol").value = "asii.jk";
  elements.get("add").click();
  await tick();
  assert.equal(calls.filter(url => url.endsWith("/market")).length, 1);
  assert.match(calls.at(-1), /%2CASII$/);
  assert.match(elements.get("notice").textContent, /Tidak ditemukan: .*ASII/);
  resolveOldQuotes({ ok: false, status: 503 });
  await tick();
  assert.equal(elements.get("stocks").children.length, 2);
  assert.equal(elements.get("refresh").disabled, false);
  assert.doesNotMatch(elements.get("notice").textContent, /503/);
});
