# Thomas IDX Lab frontend architecture assessment

**Phase 3.5 · 26 November 2026 · Audited release `d3d57e1`**

## Phase 3.4 release verification

GitHub Pages served the HTML and versioned assets for the audited commit. The
Render deploy was live on the same commit. `/healthz`, `/api/market`, and all six
BBCA history requests returned HTTP 200 with CORS for Pages. The preceding
[CI run](https://github.com/Thomasfilemon/idx/actions/runs/45561662228) passed
Rust lint, tests on Linux/macOS/Windows, container liveness, Node tests, and
browser smoke tests at 320, 390, and 1440 px. A local Node rerun passed 355 tests
with two skips. Rust results come from Actions.

| Range | BBCA daily observations | First to last observed date (WIB) |
| --- | ---: | --- |
| 3 weeks | 14 | 6 Nov–25 Nov 2026 |
| 1 month | 23 | 26 Oct–25 Nov 2026 |
| 3 months | 66 | 26 Aug–25 Nov 2026 |
| YTD | 216 | 2 Jan–25 Nov 2026 |
| 1 year | 239 | 26 Nov 2025–25 Nov 2026 |
| 3 years | 712 | 27 Nov 2023–25 Nov 2026 |

The sample reported Yahoo and IDR. Dates were unique and ordered, bar timestamps
had a +07:00 offset with matching dates, prices were finite and positive, and
nullable fields stayed nullable. The 3-year response had 649 adjusted closes
that differed from provider close by more than Rp0.01. The observed candles
were marked complete by the session rule. Provider finalization can lag the
exchange close. Deterministic tests cover provisional candles and missing
values independently of the time this smoke check ran.

The Yahoo market snapshot as of 25 Nov 2026 16:14:59 WIB returned ten gainers and
ten losers. Both fallback flags were true. Every row had positive volume,
unique ticker, the correct price-change sign, and the expected rank order.
The browser tests cover fallback copy in both languages and keep the regular
ranking label on the side that did not fall back.

## Current frontend

- One static page. The 490-line dashboard script owns transport, runtime
  envelope validation, independent market/quote request state, issuer search,
  watchlist, the chart inspector, and localization. HTML/CSS/JS total 64,987
  source bytes. The same files compressed individually with local gzip total
  about 16.6 KiB. This excludes network headers, fonts, and API responses.
- The main render path rerenders breadth, movers, and watchlist on a watchlist
  filter change and rebuilds stock buttons while restoring focus. History has
  its own request guard and rendering path. Opening a long range builds all
  daily table rows even while the table is collapsed. These are concrete
  places to measure before optimizing.
- Node tests execute the script with a DOM test double. Playwright supplies
  browser coverage across error/retry, navigation and focus, locale
  persistence, issuer discovery, history, and mover fallback. Preserve those
  behaviors as acceptance tests across any refactor.
- Pages copies a small static artifact, emits both entry URLs, generates the
  issuer catalog, and stamps asset references with the release SHA. Render
  serves a separately versioned API over CORS.

## Options

| Option | Migration and maintainability | Testing | Performance and Pages |
| --- | --- | --- | --- |
| Modular Vanilla JS | Low. Extract pure data and chart helpers and isolate panel state; reuse markup, native controls, and CSS. Module boundaries must remain explicit as shared state grows. | Add direct Node tests for helpers and keep browser regression coverage. | No new UI runtime. Measure narrower renders, deferred table rows, and module requests. Extend Pages packaging and cache versioning to cover imported modules. |
| React + TypeScript + Vite | High. Rebuild component ownership and side effects, port locale and focus behavior, and add a locked build. Typed props help with complex reusable interactive panels. Network payloads still need runtime validation. | Keep Playwright parity, add a separate TypeScript check and targeted component tests for state and requests. | Adds a runtime and build output. Measure bundle size, render cost and API latency before choosing. Build static output for `/idx/` and preserve both published entry URLs and the issuer catalog. |
| Vue + TypeScript + Vite | Medium to high. Vue templates can reuse more of the markup structure. State, lifecycle and accessibility still need migration. Composables suit shared panel logic with explicit ownership. | Keep Playwright parity, use `vue-tsc` for component/template type checks and add targeted component tests. | Adds a runtime and build output. Use the same static Pages and bundle measurement requirements as React. |

See [React's setup guide](https://react.dev/learn/build-a-react-app-from-scratch),
[Vue's TypeScript guide](https://vuejs.org/guide/typescript/overview.html), and
[Vite's Pages deployment guide](https://vite.dev/guide/static-deploy.html).
For either Vite option, set the repository base path to `/idx/`, publish the
build output via Actions, verify catalog/versioned assets, and preserve
`/idx/` plus `/idx/dashboard.html`. Retain hash navigation or explicitly
verify deep-link reloads if a router is introduced.

## Decision and migration plan

Use modular Vanilla JS for the current dashboard. A small refactor can cut
coupling before adding analytics, with no framework migration required for
Phase 4's returns, moving averages, volatility, and portfolio case study.

1. After approval for implementation, lock in measurable baselines for JS bytes,
   market/history request time, and watchlist/chart interactions at small and
   desktop widths. Keep current browser acceptance tests.
2. Extract transport and response validation, history transforms, and formatting
   as pure modules. Move rendering and state to panel boundaries incrementally.
   Keep the published URLs, issuer catalog, and release cache behavior covered
   by CI and post-deploy checks.
3. Define analytics methodology with fixtures before building UI. Specify price
   basis, excluded provisional sessions, window and units, treatment of missing
   values, minimum observations, and provider attribution. The sample above
   confirms close and adjusted close cannot be substituted for each other.
4. Revisit a framework when multiple screens need shared reactive state or
   repeated interactions become expensive to maintain. For an approved
   migration, prototype one historical panel in a preview branch, compare
   parity and measured performance with the baseline, then migrate screen by
   screen. Preserve the current Pages artifact as a rollback target.

ML Sandbox is a future, separate decision. A multi-screen experiment UI with
reusable forms, job progress, and result comparison may justify React/TS or
Vue/TS. First determine whether training is sufficiently small for browser
workers or requires a separate compute boundary plus durable jobs and data.
Pages remains suitable for the static UI in either case. Choose the execution
boundary, dataset versioning, and validation workflow before choosing the UI
framework.

**Readiness:** Ready to scope Phase 4 after owner approval. No release-blocking
regression was observed in the audited sample. Physical-device behavior and
cross-provider reconciliation remain outside this release check. Runtime
behavior on the current deployed application is the reference for future
work. This assessment changes documentation only.
