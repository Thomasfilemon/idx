"""Run with Python Playwright and Chrome to check the dashboard and capture review screenshots."""

import argparse
import subprocess
import sys
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


PUBLIC = Path(__file__).resolve().parents[1] / "public"
SITE = "https://idx-dashboard.test"
NOW = "2026-11-20T09:14:59Z"
API = "https://idx-api-1bd1.onrender.com"
CATALOG = subprocess.check_output([sys.executable, str(PUBLIC.parent / "scripts/issuer-catalog.py")])
OPTIONS = {"provider": "fixture", "fetched_at": NOW, "cached": False, "stale": False}
BBCA = {
    "symbol": "BBCA", "name": "PT Bank Central Asia Tbk", "price": 5550,
    "change": -100, "change_pct": -1.77, "volume": 147_637_100, "market_time": NOW,
}
QUOTES = {
    "schema": "idx.quotes.v1", **OPTIONS,
    "data": [BBCA, {"symbol": "BBRI", "name": "PT Bank Rakyat Indonesia Tbk", "price": None}],
}
MARKET = {
    "schema": "idx.market.v1", **OPTIONS,
    "cached": True,
    "data": {
        "index": {"price": 8354.74, "change_pct": -0.63},
        "as_of": NOW, "market_open": False, "behind_session": False,
        "advancing": 220, "declining": 456, "unchanged": 235, "quoted": 911, "universe": 955,
        "gainers": [], "losers": [BBCA],
        "most_active": [{**BBCA, "value": 819_385_905_000}],
    },
}
ASSETS = {
    "/": ("dashboard.html", "text/html; charset=utf-8"),
    "/dashboard.css": ("dashboard.css", "text/css; charset=utf-8"),
    "/dashboard.js": ("dashboard.js", "application/javascript; charset=utf-8"),
}


def smoke(browser, name, width, screenshots):
    page = browser.new_page(
        viewport={"width": width, "height": 900}, locale="id-ID",
        has_touch=name == "mobile", is_mobile=name == "mobile", reduced_motion="reduce",
    )
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    market_requests = 0
    quote_requests = 0

    def serve(route):
        nonlocal market_requests, quote_requests
        url = route.request.url
        cors = {"Access-Control-Allow-Origin": SITE}
        if url == f"{API}/api/market":
            market_requests += 1
            route.fulfill(json=MARKET, headers=cors)
        elif url.startswith(f"{API}/api/quote?"):
            quote_requests += 1
            if quote_requests == 1:
                route.fulfill(status=503, json={"error": {"code": "unavailable"}}, headers=cors)
            else:
                route.fulfill(json=QUOTES, headers=cors)
        elif url.startswith(f"{SITE}/issuer-catalog.json?"):
            route.fulfill(body=CATALOG, content_type="application/json")
        elif url.startswith(f"{SITE}/") and url[len(SITE):] in ASSETS:
            path, content_type = ASSETS[url[len(SITE):]]
            body = (PUBLIC / path).read_text(encoding="utf-8")
            if path == "dashboard.css" and body.startswith("@import "):
                body = body.partition("\n")[2]
            route.fulfill(body=body, content_type=content_type)
        else:
            route.abort()

    page.route("**/*", serve)
    page.goto(f"{SITE}/#dashboard")
    expect(page.locator("#quoted")).to_have_text("911")
    expect(page.get_by_text("Pasar tutup")).to_be_visible()
    expect(page.get_by_text("Rp819.385.905.000")).to_be_visible()
    expect(page.get_by_role("status").filter(has_text="HTTP 503")).to_be_visible()
    page.get_by_role("button", name="Muat ulang watchlist").press("Enter")
    expect(page.locator("#detail-price")).to_have_text("Rp5.550")
    assert market_requests == 1 and quote_requests == 2

    ticker = page.get_by_role("textbox", name="Tambah ticker saham")
    ticker.fill("INVALID.US")
    ticker.press("Enter")
    expect(ticker).to_have_attribute("aria-invalid", "true")
    expect(ticker).to_be_focused()
    ticker.fill("")
    watchlist = page.get_by_role("region", name="Stock watchlist")
    search = watchlist.get_by_role("textbox", name="Cari di watchlist")
    search.fill("Tidak ada")
    expect(page.get_by_text("Tidak ada saham yang cocok dengan pencarian.")).to_be_visible()
    search.fill("")
    watchlist.get_by_role("combobox", name="Urutkan").select_option("volume")
    bbri = watchlist.get_by_role("button", name="BBRI PT Bank Rakyat Indonesia Tbk", exact=False)
    bbri.press("Enter")
    expect(bbri).to_have_attribute("aria-pressed", "true")
    expect(bbri).to_be_focused()
    expect(page.locator("#detail-price")).to_have_text("—")

    expect(page.locator("#refresh")).to_have_attribute("aria-disabled", "false")
    page.get_by_role("button", name="Refresh data").press("Enter")
    expect(page.locator("#refresh")).to_have_attribute("aria-disabled", "false")
    assert market_requests == 2 and quote_requests == 3
    issuer_query = page.get_by_role("textbox", name="Cari di katalog emiten IDX")
    issuer_query.fill("Astra International")
    issuer_query.press("Enter")
    page.get_by_role("button", name="ASII · ASTRA INTERNATIONAL Tbk").press("Enter")
    expect(ticker).to_have_value("ASII")
    expect(ticker).to_be_focused()
    assert quote_requests == 3
    assert page.evaluate("document.documentElement.scrollWidth === innerWidth")
    assert page.locator(".dashboard-shell").evaluate("(el) => el.scrollWidth <= el.clientWidth")
    assert page.locator(".explorer-controls").evaluate("(el) => el.scrollWidth <= el.clientWidth")
    assert page.locator(".insights-grid").evaluate(
        "(el) => getComputedStyle(el).gridTemplateColumns.split(' ').length"
    ) == (2 if name == "mobile" else 4)
    assert page.locator(".movers-grid").evaluate(
        "(el) => getComputedStyle(el).gridTemplateColumns.split(' ').length"
    ) == (1 if name == "mobile" else 3)
    assert page.locator("#refresh").evaluate("(el) => el.getBoundingClientRect().height") >= 44
    assert not errors, errors
    page.locator(".dashboard-shell").screenshot(path=screenshots / f"dashboard-{name}.png")
    page.close()
    print(f"{name}: layout, keyboard interaction and recovery passed", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--chrome", help="Chrome executable (defaults to Playwright Chromium)")
    parser.add_argument("--screenshots", type=Path, required=True)
    args = parser.parse_args()
    args.screenshots.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=args.chrome)
        smoke(browser, "mobile", 390, args.screenshots)
        smoke(browser, "desktop", 1440, args.screenshots)
        browser.close()
