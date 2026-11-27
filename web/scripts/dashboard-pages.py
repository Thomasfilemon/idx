"""Emit standalone Pages documents from the shared dashboard shell and panel markup."""
from pathlib import Path
import sys

PUBLIC = Path(__file__).resolve().parents[1] / "public"
ROUTES = {
    "landing": ("index.html", "Beranda", "Home"),
    "market": ("market.html", "Ringkasan pasar", "Market Overview"),
    "stock": ("stock.html", "Eksplorasi saham", "Stock Explorer"),
    "dashboard": ("dashboard.html", "", ""),
}


def pages(destination):
    destination.mkdir(parents=True, exist_ok=True)
    source = (PUBLIC / "dashboard.html").read_text(encoding="utf-8")
    for page, (file, title, english) in ROUTES.items():
        active = [True]
        lines = []
        for line in source.splitlines(keepends=True):
            if line.startswith("<!-- pages "):
                active.append(active[-1] and page in line.split()[2:-1])
            elif line.startswith("<!-- end pages -->"):
                active.pop()
            elif active[-1]:
                lines.append(line)
        assert active == [True]
        html = "".join(lines).replace('data-page="dashboard"', f'data-page="{page}"')
        html = html.replace(f'data-route="{page}"', f'data-route="{page}" aria-current="page"')
        if page == "landing":
            html = html.replace('href="#dashboard"', 'href="./market.html"')
        if page in ("market", "stock"):
            html = html.replace('<h2 data-en="Explore the market.">Jelajahi pasar.</h2>',
                                f'<h1 data-en="{english}">{title}</h1>')
            html = html.replace("Indonesian Market Data</title>", english + "</title>").replace(
                'Indonesian Market Data">Thomas IDX Lab — Data Saham Indonesia',
                f'{english}">Thomas IDX Lab — {title}')
        if page == "stock":
            before, chart_and_after = html.split("<!-- history start -->")
            chart, after = chart_and_after.split("<!-- history end -->")
            chart = chart.strip().removeprefix('<details id="history-panel" class="history-panel">').removesuffix("</details>")
            chart = chart.replace('<summary data-en="Historical chart">Grafik historis</summary>',
                                  '<h2 id="chart-heading"><span id="chart-symbol"></span> · <span data-en="Historical chart">Grafik historis</span></h2>')
            chart = chart.replace('aria-describedby="history-observation"',
                                  'aria-describedby="history-observation indicator-readout"')
            panel = '<section id="history-panel" class="history-panel" aria-labelledby="chart-heading">' + chart + '</section>'
            html = before + after
            search_start = html.index('<form id="issuer-search"')
            search_end = html.index('</form>', search_start) + len('</form>')
            search = html[search_start:search_end]
            html = html[:search_start] + html[search_end:]
            html = html.replace('<div class="dashboard-body">',
                                '<div class="stock-search">' + search + '</div>\n'
                                '<div class="dashboard-body">' + panel)

            html = html.replace('<span id="mode" class="mode" data-en="Loading market data…">Memuat data pasar…</span>', '')
        (destination / file).write_text(html, encoding="utf-8")


if __name__ == "__main__":
    pages(Path(sys.argv[1]))
