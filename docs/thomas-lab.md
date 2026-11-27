# Thomas IDX Lab — experimental fork

## Purpose and ownership

This is Thomas's personal learning/portfolio fork of [fzn0x/idx](https://github.com/fzn0x/idx). The original project and its authors retain attribution under the repository's existing LICENSE. This fork is **not affiliated with or operated by the upstream maintainers**.

The upstream service at `https://ihsg.midoriresearch.com`, its Cloudflare account, D1 database, domain, release artifacts, and ownership-data mirror are **not controlled by this fork**. Upstream URLs elsewhere in this repository document the original software, examples, or dependencies; they are not a live backend for Thomas's dashboard. Do not remove source attribution or silently rebrand upstream examples as this fork's results.

## Standalone Rust REST API

Run locally with `cargo run --locked --bin idx-api`. The server uses the
existing Rust provider configuration and cache. It listens on
`127.0.0.1:8000` by default.

| Variable | Behavior |
| --- | --- |
| `IDX_API_BIND` | IP and port. Takes precedence over `PORT`. |
| `PORT` | Port on loopback when `IDX_API_BIND` is unset. |
| `IDX_API_CORS_ORIGINS` | Comma-separated canonical HTTP(S) origins. Empty by default. |
| `RUST_LOG` | API log level, such as `info` or `debug`. Defaults to `info`. |
| `IDX_CONFIG` | Existing CLI configuration file path. |

### HTTP contract

```sh
curl -fsS http://127.0.0.1:8000/healthz
curl -fsS 'http://127.0.0.1:8000/api/quote?symbols=BBCA,BBRI'
curl -fsS http://127.0.0.1:8000/api/market
curl -fsS 'http://127.0.0.1:8000/api/history?symbol=BBCA&range=3w'
```

- Health returns `{"ok":true,"service":"idx-api"}` without a provider call.
- Quote returns `idx.quotes.v1` and the existing Rust Quote objects. Supply
  1–20 comma-separated entries before deduplication. Whitespace around entries
  is trimmed and normalized duplicates are removed in input order.
- Market returns `idx.market.v1` using the full configured issuer universe and
  the `^JKSE` benchmark. The REST response adds nullable `data.market_open`
  to the Rust MarketOverview. A missing benchmark is `data.index: null`.
  Unlike the Worker snapshot, the status uses regular WIB sessions, including
  the midday break, weekends, and bundled holiday dates. Status is unknown
  outside calendar coverage. `data.market_state` is the provider's reported
  index state. `data.as_of` is the latest stock trade timestamp in the overview.
  Gainers and losers normally require positive volume and the market-cap
  floor. If either direction has no qualifying stock and market cap is
  missing for traded stocks on that side, REST ranks that side by percentage
  change among the traded stocks in the same snapshot, without the cap floor.
  `data.gainers_fallback` and `data.losers_fallback` identify the fallback
  independently. This makes no additional provider requests.
- History returns `idx.daily-history.v1` with `data.symbol`, `data.range`, nullable
  provider `data.currency`, and `data.points` (oldest first). Each point has a
  trading `date` in WIB, a WIB `bar_time` (bar timestamp, not closing time),
  provider `close`, optional provider `adjusted_close`, nullable `volume` in shares,
  and `provisional`. Additive `open`, `high`, and `low` fields contain provider prices.
  All three are null for incomplete or inconsistent bars. A valid close survives
  and the entire selected range can be displayed as a line. The chart labels its currency only if
  reported. For Yahoo's adjustments see [Yahoo Help](https://help.yahoo.com/kb/SLN28256.html).
  Adjusted values are never inferred from another field. Zero volume remains
  unavailable because some providers use it to represent missing volume.
- The API keeps the latest timestamp per WIB trading date and excludes rows
  outside the requested window or after the provider fetch date. A point is
  provisional if its session had not ended at the source fetch time according
  to the bundled IDX calendar. Outside calendar coverage, same-day data is
  marked conservatively. This flag cannot confirm the provider has finalized or
  validated its data after the session ends. Missing days remain blank.
- History ranges are `3w` (21 calendar dates including today), `1mo`, `3mo`,
  `ytd` (from January 1), `1y`, and `3y`. An empty point list means no
  observations. Malformed requests return 400 `invalid_history_query`.
  History has two concurrent provider slots and reuses the provider cache.
- All data envelopes preserve provider attribution, original fetch time, cache
  flags, stale reason, and null values. The REST API replaces free-form
  upstream warning strings with public-safe warnings. A recent fetch can
  contain earlier trade data. The session status describes the current
  scheduled session.

Example market response (illustrative, other overview fields omitted):

```json
{"schema":"idx.market.v1","provider":"yahoo","fetched_at":"2026-11-18T09:00:00Z","cached":false,"stale":false,"data":{"index":null,"market_open":false,"as_of":"2026-11-18T08:55:00Z"}}
```

Invalid quote input returns HTTP 400 with
`{"error":{"code":"invalid_symbols","message":"Provide 1 to 20 valid stock symbols."}}`.
Missing records return 404 `not_found`. Network/provider failures return
502 `provider`. Blocked or unsupported providers, offline cache misses and
concurrency saturation return 503 `unavailable`. API operation deadlines
return 504 `timeout`. Internal/configuration errors during requests return 500
`internal`.

The API allows four concurrent quote calls and one full market refresh. It
reuses the provider cache and holds the assembled market result for 60 seconds,
or a refresh error for five seconds. Each provider operation has a 25-second
API deadline, in addition to the existing network timeout. The single instance shares a 120-request/60-second fixed window across API callers.
Exhaustion returns 429 with Retry-After. Up to 12 API calls are admitted at once,
including market waiters. History allows two concurrent provider calls.
Query strings longer than 2048 bytes receive 414. Health is independent of these budgets.
The browser deadline is 90 seconds to accommodate a sleeping free instance.
Use HTTPS and set
`IDX_API_CORS_ORIGINS=https://thomasfilemon.github.io` for Pages.

### Dashboard and container

Set the `idx-api-base` meta tag in `web/public/dashboard.html` to the HTTPS
origin of the independently hosted API. An empty value retains relative
`/api/*` requests. Pages serves the landing page at `/idx/`, the market panel at
`/idx/market.html`, and the watchlist and history at
`/idx/stock.html?symbol=BBCA&range=1mo`. The combined view remains available
at `/idx/dashboard.html`; the old landing dashboard fragment opens that view.
Stock Explorer loads the selected stock’s chart on entry and updates it on selection. The combined dashboard loads history when expanded. Candlestick is the default for complete
OHLC, and Line uses raw provider closes. The time axis spaces reported sessions
in order. The volume overlay uses shares. Crosshair, pan, pinch/wheel zoom,
the keyboard observation slider and the on-demand records table support inspection.
Use the ID / EN selector in the header to switch the dashboard between Indonesian
and English. Number and timestamp formatting follow the selected language,
while market timestamps remain in Jakarta time. The browser remembers the
preference when local storage is available.

```sh
docker build -t thomas-idx-api .
docker run --rm -p 127.0.0.1:8000:8000 -e IDX_API_BIND=0.0.0.0:8000 thomas-idx-api
curl -fsS http://127.0.0.1:8000/healthz
```

The runtime runs as a non-root user. Bundled issuer and holiday files are
compiled into the binary. Mount any optional `IDX_UNIVERSE`, `IDX_HOLIDAYS`,
or `IDX_CONFIG` files separately. This fork's API requires no Worker or D1
deployment. The upstream Worker configuration belongs to the original project.

## Development and attribution

See the [frontend architecture assessment](https://github.com/Thomasfilemon/idx/blob/development/docs/assessments/frontend-architecture.md) for the
Phase 3.4 release verification and Phase 3.5 recommendation.
The [Phase 3.6 modularization decision and MPA/indicators proposals](https://github.com/Thomasfilemon/idx/blob/development/docs/assessments/frontend-modularization.md)
record the new module boundaries and approval gates.

Clone this fork with `git clone https://github.com/Thomasfilemon/idx.git`, check out `development`, and follow [CONTRIBUTING.md](../CONTRIBUTING.md) for local tests. For original CLI/API behavior and data-provider details, consult [the upstream repository](https://github.com/fzn0x/idx). The code remains subject to the existing [LICENSE](../LICENSE). This is a learning project, not financial advice.

### Technical indicators in Stock Explorer

Stock Explorer requests `GET /api/history?symbol=BBCA&range=3w&indicators=true`.
The opt-in returns prices and studies from one cached provider response, with
the original currency, fetch time and stale flags. A client omitting the flag
uses the existing range-specific history contract. If five-year history fails
the explorer retries price history alone and labels the unavailable indicators.

The calculation requests five years of daily observations regardless of the
visible range. The server normalizes WIB dates, takes the latest observation
per session, computes oldest first, then trims to the requested chart window.
`data.calculation` specifies the version, price basis, calendar coverage, as-of
date and window start. Identical source snapshot and session rules produce
identical values on overlapping dates. Provider revisions or a new seed window
can change values across fetches.

All studies use finite, positive **provider close**. Adjusted close is a
separate historical field. A valid close without full OHLC qualifies for these
close-based studies. Skip provisional candles, holidays and sessions outside
the verified calendar. A missing expected trading session or invalid close
restarts the warm-up. No interpolation or carried-forward outputs. For
eligible points `indicators.observations` counts the continuous segment.
Insufficient history yields null per study. Ineligible points omit
`indicators`. A provisional candle on the chart can therefore have a price
and no indicator values.

| Study | Minimum consecutive closes | Convention |
| --- | ---: | --- |
| SMA20, SMA50, SMA200 | 20, 50, 200 | Arithmetic mean of the most recent N closes |
| EMA20 | 20 | First 20-close SMA seeds the series, then alpha 2/21 |
| RSI14 | 15 | Wilder smoothing over 14 changes. Zero average loss gives 100, including a flat series. Zero gain with losses gives 0. |
| MACD(12,26,9) | 35 | SMA-seeded EMA12 minus EMA26, EMA9 signal, histogram = line minus signal. The first published result retains the CLI threshold. |

CLI and MCP use the same Rust EMA, RSI, SMA and MACD methods. Comparing
outputs requires the same dates, seed and eligible inputs. Stock Explorer
starts with SMA20 enabled. Optional price overlays and independent RSI/MACD
panes share the price chart's time scale, zoom, pan and crosshair. The
keyboard date slider and numeric readout provide the values without a mouse.

### All-history weekly mode

Stock Explorer supports `range=all&indicators=true`. This returns up to five
calendar years of provider weekly bars (`interval: "1wk"`) and a
`next_before` exclusive date cursor when older observations exist. Pass the
cursor as `before` with the same symbol and range to retrieve the previous
five years. The backend requests the provider's maximum weekly history and
reuses its existing history cache. It computes indicators before slicing
pages, using unadjusted weekly closes and the existing SMA, EMA, RSI and MACD
math. The current week is treated as provisional until the next Monday;
missing calendar weeks reset the indicator window. Minimum observation counts
are measured in weeks. Historical weekly completeness is based on provider
bars, since the verified exchange calendar only covers 2026–2027. The
provider's coverage and listing history bound available pages.
