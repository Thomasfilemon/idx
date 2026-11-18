import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const script = readFileSync(new URL("../public/dashboard.js", import.meta.url), "utf8");

test("dashboard starts in Demo and uses the configured API origin in Live", async () => {
  const elements = new Map();
  const element = () => ({
    textContent: "", classList: { toggle() {} }, append() {}, replaceChildren() {},
    addEventListener(name, handler) { this[name] = handler; },
  });
  const calls = [];
  let fail = false;
  runInNewContext(script, {
    document: {
      querySelector: () => ({ content: "https://api.example.test/" }),
      createElement: element,
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, element());
        return elements.get(id);
      },
    },
    AbortController, setTimeout, clearTimeout,
    async fetch(url) {
      calls.push(url);
      return { ok: !fail, status: 503, async json() {
        const data = url.endsWith("/market")
          ? { index: null, market_open: null, as_of: null }
          : [{ symbol: "BBCA", price: 123 }];
        return { provider: "fixture", stale: true, data };
      } };
    },
  });
  assert.equal(calls.length, 0);
  elements.get("live").click();
  await new Promise(setImmediate);
  assert.deepEqual(calls, [
    "https://api.example.test/api/market",
    "https://api.example.test/api/quote?symbols=BBCA%2CBBRI%2CTLKM",
  ]);
  assert.match(elements.get("notice").textContent, /fixture.*STALE/);
  assert.match(elements.get("market-status").textContent, /belum tersedia/);

  fail = true;
  await elements.get("refresh").click();
  assert.match(elements.get("notice").textContent, /HTTP 503/);
  assert.equal(elements.get("detail-price").textContent, "—");
});
