import assert from "node:assert/strict";
import test from "node:test";
import { createApi, ensureEnvelope } from "../public/dashboard/api.mjs";
import { createFormatting } from "../public/dashboard/format.mjs";
import { calendarDay, validHistory, historyGeometry, historyPosition } from "../public/dashboard/history-data.mjs";

test("formatting changes locale without changing Jakarta timezone or null handling", () => {
  const f = createFormatting();
  assert.equal(f.money(1234.5), "Rp1.234,5");
  f.setLocale("en-GB");
  assert.equal(f.money(1234.5), "Rp1,234.5");
  assert.equal(f.money(null), "—");
  assert.match(f.date("2026-11-25T02:00:00Z"), /09:00 WIB/);
});

test("history transforms are pure and preserve calendar gaps and absent volume", () => {
  const points = [
    { date: "2026-02-27", close: 100, volume: null },
    { date: "2026-03-02", close: 110, volume: 100 },
  ];
  assert.equal(calendarDay("2026-02-30"), null);
  assert.equal(validHistory({ symbol: "BBCA", range: "1mo", points }, "BBCA", "1mo"), true);
  assert.equal(validHistory({ symbol: "BBCA", range: "1mo", points: [...points].reverse() }, "BBCA", "1mo"), false);
  assert.equal(validHistory({ symbol: "BBCA", range: "1mo", points: [{ ...points[0], volume: -1 }] }, "BBCA", "1mo"), false);
  const geometry = historyGeometry(points);
  assert.equal(geometry.low, 100);
  assert.equal(geometry.high, 110);
  assert.equal(geometry.pricePath, "M3 110h0.1 M397 6h0.1");
  assert.equal(geometry.volumePath.trim().split("M").length, 2);
  assert.equal(historyPosition(points, points[1]), 397);
});

test("API transport forwards cancellation, including a request aborted before start", async () => {
  const controller = new AbortController();
  controller.abort();
  const api = createApi({ querySelector: () => ({ content: "https://example.test/" }) }, async (url, { signal }) => {
    assert.equal(url, "https://example.test/api/market");
    assert.equal(signal.aborted, true);
    throw signal.reason;
  });
  await assert.rejects(api.get("/api/market", controller.signal), { name: "AbortError" });
  assert.throws(() => ensureEnvelope({ schema: "wrong" }, "idx.market.v1", () => true), /Schema mismatch/);
});
