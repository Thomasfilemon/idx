# Thomas IDX Lab — experimental fork

## Purpose and ownership

This is Thomas's personal learning/portfolio fork of [fzn0x/idx](https://github.com/fzn0x/idx). The original project and its authors retain attribution under the repository's existing LICENSE. This fork is **not affiliated with or operated by the upstream maintainers**.

The upstream service at `https://ihsg.midoriresearch.com`, its Cloudflare account, D1 database, domain, release artifacts, and ownership-data mirror are **not controlled by this fork**. Upstream URLs elsewhere in this repository document the original software, examples, or dependencies; they are not a live backend for Thomas's dashboard. Do not remove source attribution or silently rebrand upstream examples as this fork's results.

## Current status (development branch)

| Component | Status |
| --- | --- |
| Mobile dashboard | Published at https://thomasfilemon.github.io/idx/ using GitHub Pages |
| Dashboard prices | Demo/sample only; **not current market prices** |
| Rust CLI and tests | Run in GitHub Actions; smoke test previously fetched sample stock data |
| Thomas-managed API | **Not deployed** |
| Thomas-managed database | **Not provisioned** |
| Live market refresh | **Not implemented** |

GitHub Pages hosts static files, not a Rust server. The dashboard's existing `/api/market` and `/api/quote` calls are not served by GitHub Pages; live mode is not expected to work until an independently deployed backend and cross-origin access are configured.

## Backend deployment plan

1. **Choose the MVP data contract:** start with `GET /api/market`, `GET /api/quote?symbols=BBCA,BBRI,TLKM`, and `GET /healthz`. Define response examples, freshness timestamps, errors, and stale flags. Do not label delayed or cached data as real-time.
2. **Own the infrastructure:** create a separate Cloudflare account/project or other free-tier hosting controlled by Thomas. Never reuse upstream `account_id`, `database_id`, `PUBLIC_HOST`, custom domain, or privileged tokens. Keep credentials in the provider's secret store, never Git.
3. **Start small:** evaluate deploying a minimal API that fetches from permitted data providers and caches responses. Reuse the existing Rust CLI/provider code where practical, but do not assume the existing JavaScript Cloudflare Worker runs Rust directly. If deploying the existing Worker, independently provision its D1 database, apply migrations, review scheduled jobs and upstream mirror dependencies, and update the hostname restriction.
4. **Connect GitHub Pages:** set an explicit Thomas-owned API base URL in the frontend, restrict CORS to `https://thomasfilemon.github.io`, validate ticker inputs, and handle timeouts, provider failures, rate limits, and stale data. Do not proxy arbitrary URLs.
5. **Verify:** run automated API contract tests, a live smoke test with no secrets in logs, and mobile-browser checks. Confirm provider terms and rate limits before enabling automatic refresh.

### What not to do

- Do not point the dashboard at `ihsg.midoriresearch.com` as though it were our own backend.
- Do not deploy `web/wrangler.toml` unchanged: it contains upstream Cloudflare account, domain, and D1 identifiers.
- Do not publish demo values as live quotes or fabricate timestamps.
- Do not add a new database, cron schedule, or full Rust HTTP server until the minimal read-only API requirements justify them.

## Existing source-code caveats

- `web/src/worker.js` rejects requests whose hostname does not equal `PUBLIC_HOST`.
- `web/src/headers.js` currently restricts `connect-src` to `'self'`, which is appropriate for the upstream same-origin site but needs deliberate review for a cross-origin frontend deployment.
- `web/wrangler.toml` is an upstream deployment example, **not ready for this fork's production use**.
- `web/public/dashboard.js` currently calls same-origin `/api/*`; do not change it to an upstream domain as a shortcut.

## Development and attribution

Clone this fork with `git clone https://github.com/Thomasfilemon/idx.git`, check out `development`, and follow [CONTRIBUTING.md](../CONTRIBUTING.md) for local tests. For original CLI/API behavior and data-provider details, consult [the upstream repository](https://github.com/fzn0x/idx). The code remains subject to the existing [LICENSE](../LICENSE). This is a learning project, not financial advice.
