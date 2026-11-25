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
- History returns `idx.daily-history.v1` for a single IDX stock, with `data.symbol`,
  `data.range`, and `data.points` (oldest first). Each point has a WIB `date`,
  provider `close` in IDR, and nullable `volume` in shares. Provider adjustments
  may vary. Zero volume is exposed as unavailable because some providers use it
  for missing values. The latest daily bar can still be in progress.
  Supported ranges are `3w` (21 calendar dates including today), `1mo`, `3mo`,
  `ytd` (from January 1), `1y`, and `3y`. The API clips provider candles to the
  requested date window. An empty `points` list means no observations in that
  window. Malformed queries return 400 `invalid_history_query`. The API allows
  two concurrent history calls and reuses the provider's history cache.
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
API deadline, in addition to the existing network timeout. Before public
exposure, configure reverse proxy rate limits that return 429, including a
global request cap and stricter limits for the market route. Use HTTPS and set
`IDX_API_CORS_ORIGINS=https://thomasfilemon.github.io` for Pages.

### Dashboard and container

Set the `idx-api-base` meta tag in `web/public/dashboard.html` to the HTTPS
origin of the independently hosted API. An empty value retains relative
`/api/*` requests. The dashboard loads market and watchlist data on entry. Open
Grafik historis in the stock detail panel to request daily history. The chart
keeps unreported dates blank and offers the underlying records in a table.

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

Clone this fork with `git clone https://github.com/Thomasfilemon/idx.git`, check out `development`, and follow [CONTRIBUTING.md](../CONTRIBUTING.md) for local tests. For original CLI/API behavior and data-provider details, consult [the upstream repository](https://github.com/fzn0x/idx). The code remains subject to the existing [LICENSE](../LICENSE). This is a learning project, not financial advice.
