"""Run with Python Playwright and Chrome to check the dashboard and capture review screenshots."""

import argparse
import subprocess
import tempfile
from urllib.parse import urlsplit, parse_qs
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
        "gainers": [{"symbol": "ASII", "change_pct": 2.5}], "losers": [BBCA],
        "gainers_fallback": True, "losers_fallback": False,
        "most_active": [{**BBCA, "value": 819_385_905_000}],
    },
}
ASSETS = {

    "/dashboard.css": ("dashboard.css", "text/css; charset=utf-8"),
    "/dashboard.js": ("dashboard.js", "application/javascript; charset=utf-8"),
}


def smoke(browser, name, width, screenshots):
    mobile = width <= 620
    page = browser.new_page(
        viewport={"width": width, "height": 568 if width == 320 else 900}, locale="id-ID",
        has_touch=mobile, is_mobile=mobile, reduced_motion="reduce",
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
        elif url.startswith(f"{API}/api/history?"):
            params = parse_qs(urlsplit(url).query)
            range_code = params["range"][0]
            symbol = params["symbol"][0]
            if symbol == "TLKM":
                route.fulfill(status=503, json={"error": {"code": "unavailable"}}, headers=cors)
                return
            if symbol == "BBCA":
                route.fulfill(headers=cors, json={"schema": "idx.daily-history.v1", **OPTIONS,
                    "data": {"symbol": symbol, "range": range_code, "currency": "IDR", "points": []}})
                return
            if range_code == "all":
                older = "before" in params
                days = ["2016-11-21", "2021-11-15"] if older else ["2021-11-22", "2026-11-16"]
                payload = {"symbol": symbol, "range": "all", "interval": "1wk", "currency": "IDR",
                           "calculation": {"method": "idx.technical.weekly.v1"},
                           "points": [{"date": day, "open": 3700, "high": 3800, "low": 3650,
                                       "close": 3750, "volume": 1200} for day in days]}
                if not older:
                    payload["next_before"] = "2021-11-21"
                route.fulfill(headers=cors, json={"schema": "idx.daily-history.v1", **OPTIONS, "data": payload})
                return
            if range_code == "3w" and "before" in params:
                assert params["before"] == ["2026-11-19"]
                assert params["indicators"] == ["true"]
                route.fulfill(headers=cors, json={"schema": "idx.daily-history.v1", **OPTIONS,
                    "data": {"symbol": symbol, "range": "3w", "currency": "IDR",
                             "calculation": {"method": "idx.technical.v2", "basis": "close"},
                             "points": [{"date": "2026-10-01", "close": 3500, "volume": 1000,
                                         "indicators": {"observations": 214, "sma20": 3500, "ema20": 3500}}]}})
                return
            ohl = {"open": 3700, "high": 3800, "low": 3650} if range_code == "3mo" else {}
            calculation = {"calculation": {"method": "idx.technical.v2", "basis": "close"}} if "indicators" in params else {}
            if range_code == "3w" and "indicators" in params:
                calculation["next_before"] = "2026-11-19"
            study = {"indicators": {"observations": 215, "sma20": 3610, "rsi14": 60,
                                   "macd": {"line": 5, "signal": 2, "histogram": 3}}}
            route.fulfill(headers=cors, json={
                "schema": "idx.daily-history.v1", **OPTIONS, "stale": "indicators" in params,
                "data": {**calculation, "symbol": "BBRI", "range": range_code, "currency": "IDR", "points": [
                    {**ohl, **study, "date": "2026-11-19", "close": 3700, "volume": None, "adjusted_close": 3650},
                    {**ohl, "date": "2026-11-20", "close": 3750, "volume": 1200, "provisional": True},
                ]},
            })
        elif url.startswith(f"{SITE}/issuer-catalog.json?"):
            route.fulfill(body=CATALOG, content_type="application/json")
        elif url.startswith(f"{SITE}/dashboard/") and url.endswith(".mjs"):
            module_name = url.removeprefix(f"{SITE}/dashboard/")
            route.fulfill(body=(PUBLIC / "dashboard" / module_name).read_text(encoding="utf-8"),
                          content_type="application/javascript; charset=utf-8")
        elif url.startswith(f"{SITE}/") and urlsplit(url).path in (
            "/", "/dashboard.html", "/stock.html", "/market.html"
        ):
            path = urlsplit(url).path.lstrip("/") or "index.html"
            route.fulfill(body=(PAGES / path).read_bytes(), content_type="text/html")
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
    expect(page.locator("html")).to_have_attribute("lang", "en")
    page.get_by_role("combobox", name="Language").select_option("id")
    expect(page.locator("#quoted")).to_have_text("911")
    expect(page.get_by_text("Pasar tutup")).to_be_visible()
    expect(page.locator("#gainers-list")).to_contain_text("ASII")
    expect(page.locator("#gainers-list")).to_contain_text("tanpa filter kapitalisasi pasar")
    expect(page.locator("#losers-list")).not_to_contain_text("tanpa filter kapitalisasi pasar")
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
    watchlist = page.get_by_role("region", name="Daftar pantau saham")
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
    page.get_by_role("button", name="Perbarui data").press("Enter")
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
    ) == (2 if mobile else 4)
    assert page.locator(".movers-grid").evaluate(
        "(el) => getComputedStyle(el).gridTemplateColumns.split(' ').length"
    ) == (1 if mobile else 3)
    assert page.locator("#refresh").evaluate("(el) => el.getBoundingClientRect().height") >= 44
    page.get_by_text("Grafik historis", exact=True).click()
    expect(page.get_by_text("Volume tertinggi · 1.200 saham")).to_be_visible()
    period = page.get_by_label("Rentang waktu")
    expect(period.locator("option")).to_have_count(6)
    period.select_option("3y")
    expect(page.get_by_text("Volume tertinggi · 1.200 saham")).to_be_visible()
    expect(page.locator("#history-rows tr")).to_have_count(0)
    page.get_by_text("Lihat data historis", exact=True).click()
    expect(page.get_by_role("table", name="Data historis").get_by_role("row")).to_have_count(3)
    observation = page.get_by_role("slider", name="Lihat observasi")
    expect(observation).to_have_attribute("aria-valuetext", "2026-11-20 · Penutupan Rp3.750 · Volume 1.200 · Sementara saat data diambil (*)")
    observation.press("Home")
    expect(observation).to_have_attribute("aria-valuetext", "2026-11-19 · Penutupan Rp3.700 · Volume —")
    assert page.locator(".dashboard-shell").evaluate("(el) => el.scrollWidth <= el.clientWidth")
    assert page.locator(".site-header").evaluate("(el) => el.scrollWidth <= el.clientWidth")
    language = page.get_by_role("combobox", name="Bahasa")
    expect(language.locator("option")).to_have_text(["ID", "EN"])
    language.select_option("en")
    expect(page.locator("html")).to_have_attribute("lang", "en")
    expect(page.get_by_text("Historical chart", exact=True)).to_be_visible()
    expect(page.locator("#gainers-list")).to_contain_text("without a market-cap filter")
    expect(page.get_by_text("Highest volume · 1,200 shares")).to_be_visible()
    expect(page.get_by_role("table", name="Historical records")).to_be_visible()
    assert quote_requests == 3
    expect(page.get_by_role("slider", name="Inspect an observation")).to_have_attribute(
        "aria-valuetext", "2026-11-19 · Close Rp3,700 · Volume —"
    )
    page.locator(".dashboard-shell").screenshot(path=screenshots / f"dashboard-{name}.png")
    page.reload()
    expect(page.get_by_role("combobox", name="Language")).to_have_value("en")
    page.get_by_role("combobox", name="Language").select_option("id")
    expect(page.get_by_text("Grafik historis", exact=True)).to_be_visible()
    page.goto(SITE)
    expect(page.locator('nav [aria-current="page"]')).to_have_text("Beranda")
    assert page.locator("#refresh").count() == 0
    counts = (market_requests, quote_requests)
    page.get_by_role("link", name="Pasar", exact=True).click()
    expect(page.locator("#quoted")).to_have_text("911")
    assert (market_requests, quote_requests) == (counts[0] + 1, counts[1])
    page.goto(SITE + "/stock.html?symbol=bbri.jk&range=3y")
    expect(page.locator("#detail-title")).to_contain_text("BBRI")
    expect(page.locator("#history-range")).to_have_value("3y")
    assert (market_requests, quote_requests) == (counts[0] + 1, counts[1] + 1)
    expect(page.locator("section#history-panel")).to_be_visible()
    expect(page.locator("#chart-symbol")).to_have_text("BBRI")
    expect(page.locator("#financial-chart canvas").first).to_be_visible()
    expect(page.locator("#history-rows tr")).to_have_count(0)
    assert page.locator("#issuer-search").bounding_box()["y"] < page.locator("#history-panel").bounding_box()["y"]
    if mobile:
        assert page.locator(".dashboard-list").bounding_box()["y"] >= page.locator("#history-panel").bounding_box()["y"]
    else:
        assert page.locator(".dashboard-list").bounding_box()["x"] > page.locator("#history-panel").bounding_box()["x"]
    expect(page.locator("#history-loading")).to_be_hidden()
    period.select_option("3w")
    assert "symbol=BBRI&range=3w" in page.url
    page.go_back()
    expect(period).to_have_value("3y")
    expect(page.locator("#history-style")).to_have_value("line")
    expect(page.locator("#history-style")).to_be_disabled()
    expect(page.locator("#financial-chart canvas").first).to_be_visible()
    period.select_option("3mo")
    expect(page.locator("#history-style")).to_have_value("candlestick")
    expect(page.locator("#history-style")).to_be_enabled()
    canvas = page.locator("#financial-chart canvas").first
    expect(canvas).to_be_visible()
    if mobile:
        page.locator("#financial-chart").tap()
    page.locator("#financial-chart").hover()
    page.mouse.wheel(0, -120)
    page.locator("#history-style").select_option("line")
    expect(page.locator("#history-data")).to_have_class("interactive")
    expect(page.locator("#history-observation")).to_contain_text("Tertinggi")
    controls = page.locator("#indicator-controls")
    baseline = page.locator("#financial-chart canvas").count()
    controls.get_by_label("RSI14").check()
    controls.get_by_label("MACD").check()
    assert page.locator("#financial-chart canvas").count() > baseline
    page.locator("#history-point").press("Home")
    expect(page.locator("#indicator-readout")).to_contain_text("RSI14 60")
    controls.get_by_label("RSI14").uncheck()
    controls.get_by_label("MACD").uncheck()
    expect(page.locator("#financial-chart canvas")).to_have_count(baseline)
    expect(page.locator("#history-status")).to_contain_text("Data lama")
    period.select_option("3w")
    expect(page.locator("#history-older")).to_be_visible()
    expect(page.locator("#history-dates")).to_contain_text("2026-11-19")
    if mobile:
        page.locator("#history-older").click()
    else:
        canvas = page.locator("#financial-chart canvas").first
        expect(canvas).to_be_visible()
        canvas.scroll_into_view_if_needed()
        rect = canvas.bounding_box()
        page.mouse.move(rect["x"] + rect["width"] * 0.25, rect["y"] + rect["height"] * 0.5)
        page.mouse.down()
        page.mouse.move(rect["x"] + rect["width"] * 0.75, rect["y"] + rect["height"] * 0.5, steps=12)
        page.mouse.up()
    expect(page.locator("#history-dates")).to_contain_text("2026-10-01")
    expect(page.locator("#history-older")).to_be_hidden()
    expect(period).to_have_value("3w")
    assert "range=3w" in page.url
    page.locator("#history-point").press("Home")
    expect(page.locator("#indicator-readout")).to_contain_text("SMA20 3.500")
    period.select_option("all")
    expect(page.locator("#weekly-notice")).to_be_visible()
    page.locator("#history-style").select_option("candlestick")
    expect(page.locator("#history-style")).to_have_value("candlestick")
    expect(page.locator("#history-older")).to_be_visible()
    page.locator("#history-older").click()
    expect(page.locator("#history-dates")).to_contain_text("2016-11-21")
    expect(page.locator("#history-older")).to_be_hidden()
    period.select_option("3mo")
    page.locator("#symbol").fill("BBCA")
    page.locator("#add").click()
    expect(page.locator("#history-status")).to_contain_text("Belum ada data historis BBCA")
    expect(page.locator("#financial-chart")).to_be_hidden()
    page.locator("#symbol").fill("TLKM")
    page.locator("#add").click()
    expect(page.locator("#history-retry")).to_be_visible()
    expect(page.locator("#history-status")).to_contain_text("Histori TLKM belum dapat dimuat")
    assert not errors, errors
    page.close()
    print(f"{name}: layout, keyboard interaction and recovery passed", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--chrome", help="Chrome executable (defaults to Playwright Chromium)")
    parser.add_argument("--screenshots", type=Path, required=True)
    args = parser.parse_args()
    args.screenshots.mkdir(parents=True, exist_ok=True)
    generated = tempfile.TemporaryDirectory()
    PAGES = Path(generated.name)
    subprocess.run([sys.executable, PUBLIC.parent / "scripts/dashboard-pages.py", PAGES], check=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=args.chrome)
        smoke(browser, "mobile-compact", 320, args.screenshots)
        smoke(browser, "mobile", 390, args.screenshots)
        smoke(browser, "desktop", 1440, args.screenshots)
        browser.close()
