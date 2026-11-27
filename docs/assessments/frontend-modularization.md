# Phase 3.6 — Frontend modularization and next-phase proposals

Decision approved: keep Modular Vanilla JS. Branch: `development`.
Baseline: `3bd7b90` (runtime assets from `d3d57e1`). 26 November 2026.

## Architecture decision

The HTML, CSS, native controls, API contracts, and both current Pages entry URLs
remain. `web/public/dashboard.js` initializes a native ES module graph:

- `app.mjs`: composition, refresh and retry actions, and inter-panel coordination.
- `api.mjs`: shared fetch transport, per-request cancellation and deadline,
  envelope validation, and independent request lifecycle.
- `format.mjs`: numeric, currency, and Jakarta-time formatters.
- `i18n.mjs`: locale, static labels, status text, and stored language preference.
- `status.mjs`: provider freshness and failure messages.
- `market.mjs`: market overview, breadth and movers state/rendering.
- `watchlist.mjs`: watchlist, issuer search, selected quote and filter state.
- `history-data.mjs`: DOM-independent validation and chart geometry.
- `history.mjs`: history request, selected observation, and lazy records table.

Factories receive dependencies explicitly and can be initialized with an isolated
document/fetch in tests. Market updates target the market panel. Watchlist filter
and sort target the watchlist only. Locale changes refresh localized data without
new provider requests. History geometry is computed once per response. Historical
table rows are generated only when expanded; repeated expand/collapse reuses them
until the dataset or locale changes. Changing the selected ticker still updates
the history request when its panel is open. Existing stale/partial data behavior
and request guards are retained.

Pages packages both HTML entry names and a release-specific module directory.
The versioned entry script imports that directory. Native relative imports
remain within a single release and require no new build tool. Module paths
and deployment triggers cover the source directory. A stale HTML document
around a release may need a refresh if it references a retired module path.

## Measurements

Identical deterministic DOM/fetch fixture, two watchlist quotes and a
712-point daily history. Existing source measured before refactor; new behavior
is asserted in `web/test/dashboard.test.mjs`. These are work counts, not
browser elapsed-time or LCP measurements.

| Metric | Before | After |
| --- | ---: | ---: |
| Market list replacements per watchlist filter | 3 | 0 |
| Element creations per watchlist filter | 10 | 7 |
| Historical table elements created while closed (712 rows) | 3,560 | 0 |
| Table elements on first expansion (712 rows) | 3,560 already created | 3,560 on demand |
| Requests after initial market/quote load, filter, then history | 3 | 3 |
| HTML/CSS/JS source bytes | 64,987 | 70,200 |
| Sum of individual gzip files (local gzip, approximate) | 19,036 B | 22,384 B |
| Javascript files in first module graph | 1 | 10 |

The extra modules trade static bytes and requests for isolated ownership and
less DOM work. No claim of improved page-load latency is made. Cold-start
backend latency is unchanged by this frontend refactor. Measure actual
browser startup and interaction times on physical devices before further
bundling or framework decisions.

Revisit a framework only after evidence that shared state and repeated
components across independent screens, or the experiment UI, make native
modules difficult to evolve. Measure review effort, regression frequency,
first-load cost, and interaction responsiveness; require a feature-parity
preview before adopting React or Vue. Type checks and runtime payload
validation are separate concerns.

## MPA implementation proposal (pending approval)

Objective: make the market view and individual stock research independently
accessible, preserve language and a responsive navigation bar, and keep
Pages as a static host. Proposed explicit file routes:

| URL under /idx/ | Responsibility |
| --- | --- |
| index.html or / | Portfolio landing and navigation to analysis |
| market.html | IHSG, market breadth, gainers, losers, most active |
| stock.html?symbol=BBCA&range=1mo | Issuer search, watchlist, quote, history; later indicators |
| dashboard.html | Existing combined view retained as a compatibility entry during transition |

Keep legacy /idx/#dashboard, #about and #architecture links valid during
transition; explicitly map the dashboard anchor to the compatibility view
or market navigation before replacing the landing content. No client router
required. Browser back/forward and direct reload use real HTML files on Pages.
When the stock symbol/range changes, update validated URLSearchParams using
replaceState for initial normalization and pushState for user selection;
handle popstate without duplicate fetches. Default unknown/invalid symbols to
BBCA only for malformed syntax and absent input; valid tickers without records
show an explicit empty state. Allow exactly 3w, 1mo, 3mo, ytd, 1y, 3y.
Do not include provider credentials or bulky data in URLs.

Use shared CSS, native linked navigation with aria-current and accessible
mobile layout, the existing `idx-language` localStorage key, and shared
API/format/i18n modules. Page entry modules mount only their owned panels;
landing sends zero market/history requests, market requests only market data,
stock requests quotes and on-demand history. Keep existing watchlist behavior
for the compatibility view; persistence across separate pages is a separate
design decision. Explicit build-time asset copies/entry stamping keep static
deployment simple. No routing library, framework or new backend service.

Estimated effort (relative): low for page shells/navigation, medium for
splitting app composition and URL state, medium for compatibility and
cross-page browser regression. Suggested delivery:
1. Agree on URL and compatibility navigation behavior.
2. Create shared shell and page entry modules in a preview branch; verify
   language, keyboard focus, viewport widths, direct links and back/forward.
3. Verify request isolation, native links and both existing entry URLs. Extend
   Pages artifact checks for every new HTML entry and versioned module.
4. Publish only after review and use the previous Pages commit as rollback
   if regressions are observed.

The module boundaries allow future independent stock screener, stock comparison,
and ML Sandbox entry modules sharing navigation, API and localization. Do not
create empty feature routes or add ML dependencies yet. The Sandbox's computation,
job lifecycle and dataset boundary need their own requirements.

## Phase 4.1 implementation proposal — Technical indicators (pending approval)

Start with a single selected stock and daily history. Reuse Rust's existing
pure helpers in `src/analysis/technical.rs` after verifying the precise
methodology. Expose an additive versioned endpoint (proposed `/api/indicators`
with validated symbol/range/basis), calculate in Rust so CLI/MCP/REST can share
consistent math, and use the existing chart module for presentation. Preserve
existing history and quote contracts. No buy/sell signals, model fitting,
historical simulation or multi-stock comparison in this milestone.

### Data rules

- Default basis `close` matches the currently plotted provider closing price.
  Optional `adjusted_close` mode must be explicit and label both the chart and
  indicator output with that basis. Do not substitute ordinary close into an
  adjusted series. Preserve provider, reported currency, fetched_at and stale
  flags. Reject invalid or incompatible currency and do not combine providers
  within a calculation.
- Only finalized daily observations by the API session rule: exclude
  `provisional: true`, and treat absent/unknown status conservatively. Provider
  finalization after the session can still lag. The history chart may show
  intraday points, but indicators end at the most recent eligible day.
- Require positive finite prices, unique ascending WIB dates, and a sufficient
  continuous segment of expected exchange trading sessions. Skip scheduled
  holidays/weekends via the existing calendar. For missing expected trading
  dates, do not fill/interpolate; mark unavailable and restart rolling/recursive
  windows from the next continuous observation. If calendar coverage is unknown,
  report coverage uncertainty rather than certify a complete window.
- Request bounded warm-up data beyond the visible range through the provider
  cache. Define the warm-up anchor consistently for the selected basis, symbol
  and provider, then crop output to the displayed window. Recursive indicators
  are seeded at that documented anchor; insufficient observations produce null
  with a reason, never zeros or invented points. Record eligible observation
  count and first/last dates. Do not infer adjusted close from missing data.

| Indicator | Method | Minimum continuous observations |
| --- | --- | ---: |
| SMA20/50/200 | Sum of last N eligible closes / N | 20/50/200 |
| EMA20 | SMA20 seed, then alpha = 2/(20+1) | 20 |
| RSI14 | Wilder-smoothed gains/losses on 14 changes | 15 |
| MACD (12,26,9) | EMA12 minus EMA26; EMA9 of the line and difference histogram | 35 per current Rust helper |

For RSI specify flat series = 50, rising with zero losses = 100, falling with
zero gains = 0. Existing helper returns 100 for a flat series, so compare
existing callers and either add a versioned implementation or revise the
shared policy with explicit compatibility review before release. A MACD signal
can mathematically start at observation 34 under SMA seeds; the existing helper
requires 35, so preserve that threshold initially and document it. Periods are
trading observations, not calendar days. Test exact thresholds and expected
series alignment with hand-computed fixtures.

### Delivery and acceptance

1. Approve indicator set and endpoint/methodology. Build deterministic Rust
   tests for numeric values, flat series, missing days, adjusted missing values,
   calendar coverage, provisional exclusion, and bounds; reuse existing cache
   and timeout protections.
2. Add endpoint and run API contract tests independently before UI.
3. Present overlays and separate RSI/MACD panels with ID/EN labels, units,
   sufficient-data status, latest eligible date, and accessible data records.
4. Verify production HTTP/CORS, native Pages assets, mobile/desktop Playwright,
   no demo values, and regression tests. Keep ML Sandbox and further analytics
   outside scope until approved.

This is an implementation plan only. No pages were separated and no technical
indicator computation or framework migration was performed in Phase 3.6.

## Phase 3.7 and 3.8 decisions

Pages generates four real HTML documents from one shell and shared panel markup
using Python's standard library at packaging time. Navigation works with native
links. Each analysis page starts only its own API requests. The stock query
stores the selected symbol and range and supports browser history.

The interactive price and volume chart uses the self-hosted standalone ES module
from the lightweight-charts 5.0.9 npm release. The version, license and upstream
NOTICE are kept alongside the module. Its 182,216 uncompressed JS bytes are
requested only after history returns data. Users incur no runtime CDN request.
Keeping the existing SVG alone would require maintaining touch tracking, scales,
crosshair and viewport interaction ourselves. The accessible slider and records
remain available independently of canvas. The static price/volume plots also
remain available if the interactive module fails to initialize. Updating the
vendored dependency requires repeating browser and licensing checks.

### Phase 4.1 acceptance criteria for approval

For a fixed symbol, basis, provider, fetch and as-of session, propose fetching
five years of daily source history once for calculation. This covers the longest
three-year view with up to two years of preceding observations. Seed recursive
methods from the first eligible contiguous segment in that same source window.
Calculate each session using only data available through that session, then
crop the series for display. Switching range or zoom must leave all overlapping
values identical. Expose the calculation start, as-of date, provider, basis,
eligible count and method version so values can be reproduced.

Use the existing Rust functions in `src/analysis/technical.rs` and the shared
technical service used by CLI and MCP. Preserve current semantics for parity:
SMA20/50/200, SMA-seeded EMA20, Wilder RSI14 from 15 closes (including flat
series = 100 under the existing zero-loss branch), and MACD(12,26,9) from 35.
This supersedes the earlier suggested flat-series value of 50. Compare results
on identical eligible inputs and the same seed, as CLI callers can request a
different lookback. Require parity fixtures for all three interfaces before
release. Any change to flat RSI or default CLI/MCP filtering needs separate review.

Default to provider close. Keep adjusted values a separately specified basis
and never mix bases. Exclude provisional or unknown finality, reset on an
expected session with missing/invalid price, and surface unknown calendar
coverage. Return null and a reason until the full minimum is available after
a reset. Test insufficient IPO history, missing/provisional points, range
invariance, and no future leakage. This section is an implementation proposal.
