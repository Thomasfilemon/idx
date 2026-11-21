import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const script = readFileSync(new URL("../public/dashboard.js", import.meta.url), "utf8");
function setup({ fail = false, invalid = false } = {}) {
  const elements = new Map(), calls = [];
  const element = () => ({
    textContent: "", value: "", disabled: false, children: [],
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    addEventListener(name, handler) { this[name] = handler; },
    click() { return this.click?.(); },
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
  assert.match(elements.get("notice").textContent, /STALE/);
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
  assert.match(elements.get("notice").textContent, /Format respons API tidak sesuai/);
  assert.equal(elements.get("ihsg").textContent, "—");
});
