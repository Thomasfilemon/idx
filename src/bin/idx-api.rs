//! Standalone HTTP API for Thomas IDX Lab.
use std::{
    net::SocketAddr,
    sync::Arc,
    time::{Duration, Instant},
};

use axum::{
    extract::{rejection::QueryRejection, Query, Request, State},
    http::{header, HeaderValue, StatusCode},
    middleware::{self, Next},
    response::Response,
    routing::get,
    Json, Router,
};
use chrono::{DateTime, Datelike, Months, NaiveDate, Timelike, Utc, Weekday};
use idx::{
    cli::{build_context, GlobalOpts},
    error::IdxError,
    holidays,
    model::{Interval, MarketOverview, Period, Symbol},
    output::json::{Envelope, SCHEMA_MARKET, SCHEMA_QUOTES},
    providers::Provider,
    service,
    universe::{self, Issuer},
};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::{Mutex, Semaphore};

const TIMEOUT: Duration = Duration::from_secs(25);
const MARKET_TTL: Duration = Duration::from_secs(60);
const FAILURE_TTL: Duration = Duration::from_secs(5);
type ApiError = (StatusCode, Json<Value>);
type MarketResult = Result<Envelope<MarketOverview>, ApiError>;

#[derive(Clone)]
struct AppState {
    provider: Arc<dyn Provider>,
    universe: Arc<[Issuer]>,
    index: Symbol,
    quote_slots: Arc<Semaphore>,
    history_slots: Arc<Semaphore>,
    market: Arc<Mutex<Option<(Instant, MarketResult)>>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct QuoteQuery {
    symbols: String,
}

fn invalid_symbols() -> ApiError {
    error(
        StatusCode::BAD_REQUEST,
        "invalid_symbols",
        "Provide 1 to 20 valid stock symbols.",
    )
}

fn parse_symbols(raw: &str) -> Result<Vec<Symbol>, ApiError> {
    let mut symbols = Vec::new();
    for (i, part) in raw.split(',').enumerate() {
        let part = part.trim();
        if i >= 20 || part.is_empty() || part.chars().any(char::is_whitespace) {
            return Err(invalid_symbols());
        }
        let symbol = Symbol::parse(part).map_err(|_| invalid_symbols())?;
        if !symbols.contains(&symbol) {
            symbols.push(symbol);
        }
    }
    Ok(symbols)
}

fn error(status: StatusCode, code: &str, message: &str) -> ApiError {
    (
        status,
        Json(json!({ "error": { "code": code, "message": message } })),
    )
}

fn provider_error(err: IdxError) -> ApiError {
    tracing::warn!(kind = err.code(), "market data operation failed");
    match err {
        IdxError::NotFound(_) => error(StatusCode::NOT_FOUND, "not_found", "No data found."),
        IdxError::Blocked { .. } | IdxError::OfflineMiss(_) | IdxError::Unsupported { .. } => {
            unavailable()
        }
        IdxError::Network(_) | IdxError::Provider { .. } => error(
            StatusCode::BAD_GATEWAY,
            "provider",
            "Market data provider failed.",
        ),
        _ => internal(),
    }
}

fn internal() -> ApiError {
    error(
        StatusCode::INTERNAL_SERVER_ERROR,
        "internal",
        "Internal server error.",
    )
}

fn unavailable() -> ApiError {
    error(
        StatusCode::SERVICE_UNAVAILABLE,
        "unavailable",
        "Market data temporarily unavailable.",
    )
}

fn timed_out() -> ApiError {
    error(
        StatusCode::GATEWAY_TIMEOUT,
        "timeout",
        "Market data operation timed out.",
    )
}

// Some provider warnings contain raw upstream errors. Keep their presence and
// count in the HTTP contract while keeping internal strings out of responses.
fn public_envelope<T>(schema: &str, mut data: idx::providers::Sourced<T>) -> Envelope<T> {
    for warning in &mut data.warnings {
        *warning = "Some provider data may be incomplete or stale.".into();
    }
    Envelope::from_sourced(schema, data)
}

async fn health() -> Json<Value> {
    Json(json!({ "ok": true, "service": "idx-api" }))
}

async fn quote(
    State(state): State<AppState>,
    query: Result<Query<QuoteQuery>, QueryRejection>,
) -> Result<Json<Envelope<Vec<idx::model::Quote>>>, ApiError> {
    let Query(query) = query.map_err(|_| invalid_symbols())?;
    let symbols = parse_symbols(&query.symbols)?;
    let _slot = state.quote_slots.try_acquire().map_err(|_| unavailable())?;
    let result = tokio::time::timeout(TIMEOUT, state.provider.quotes(&symbols))
        .await
        .map_err(|_| timed_out())?
        .map_err(provider_error)?;
    Ok(Json(public_envelope(SCHEMA_QUOTES, result)))
}

const SCHEMA_DAILY_HISTORY: &str = "idx.daily-history.v1";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct HistoryQuery {
    symbol: String,
    range: String,
}

#[derive(serde::Serialize)]
struct DailyHistory {
    symbol: Symbol,
    range: String,
    points: Vec<DailyPoint>,
}

#[derive(serde::Serialize)]
struct DailyPoint {
    date: NaiveDate,
    close: f64,
    volume: Option<u64>,
}

fn history_window(range: &str, today: NaiveDate) -> Option<(Period, NaiveDate)> {
    let (period, months) = match range {
        "3w" => return Some((Period::M1, today - chrono::Days::new(20))),
        "1mo" => (Period::M1, 1),
        "3mo" => (Period::M3, 3),
        "ytd" => return Some((Period::Ytd, today.with_ordinal(1)?)),
        "1y" => (Period::Y1, 12),
        "3y" => (Period::Y5, 36),
        _ => return None,
    };
    Some((period, today.checked_sub_months(Months::new(months))?))
}

async fn history(
    State(state): State<AppState>,
    query: Result<Query<HistoryQuery>, QueryRejection>,
) -> Result<Json<Envelope<DailyHistory>>, ApiError> {
    let invalid = || {
        error(
            StatusCode::BAD_REQUEST,
            "invalid_history_query",
            "Supply one IDX stock symbol and a range: 3w, 1mo, 3mo, ytd, 1y or 3y.",
        )
    };
    let Query(query) = query.map_err(|_| invalid())?;
    let symbol = Symbol::parse(&query.symbol).map_err(|_| invalid())?;
    if symbol.as_str().starts_with('^') {
        return Err(invalid());
    }
    let today = Utc::now()
        .with_timezone(&chrono::FixedOffset::east_opt(7 * 3600).expect("WIB"))
        .date_naive();
    let (period, start) = history_window(&query.range, today).ok_or_else(invalid)?;
    let _slot = state
        .history_slots
        .try_acquire()
        .map_err(|_| unavailable())?;
    let sourced = tokio::time::timeout(
        TIMEOUT,
        state.provider.history(&symbol, period, Interval::Day1),
    )
    .await
    .map_err(|_| timed_out())?
    .map_err(provider_error)?;
    if sourced.data.interval != Interval::Day1 || sourced.data.symbol != symbol {
        return Err(unavailable());
    }

    let result = sourced.map(|mut history| {
        history.candles.retain(|candle| {
            (start..=today).contains(&candle.date())
                && candle.close.is_finite()
                && candle.close > 0.0
        });
        history.candles.sort_by_key(|candle| candle.time);
        history.candles.dedup_by_key(|candle| candle.date());
        let points = history
            .candles
            .into_iter()
            .map(|candle| DailyPoint {
                date: candle.date(),
                close: candle.close,
                // Some providers map missing volume to zero in the shared model.
                volume: (candle.volume > 0).then_some(candle.volume),
            })
            .collect();
        DailyHistory {
            symbol,
            range: query.range,
            points,
        }
    });
    Ok(Json(public_envelope(SCHEMA_DAILY_HISTORY, result)))
}

fn market_open(now: DateTime<Utc>) -> Option<bool> {
    let wib = now.with_timezone(&chrono::FixedOffset::east_opt(7 * 3600).expect("WIB"));
    if !holidays::covers(wib.year()) {
        return None;
    }
    let minute = wib.hour() * 60 + wib.minute();
    let friday = wib.weekday() == Weekday::Fri;
    let morning_end = if friday { 690 } else { 720 };
    let afternoon_start = if friday { 840 } else { 810 };
    Some(
        holidays::is_trading_day(wib.date_naive())
            && ((540..morning_end).contains(&minute) || (afternoon_start..950).contains(&minute)),
    )
}

async fn market(
    State(state): State<AppState>,
    query: axum::extract::RawQuery,
) -> Result<Json<Envelope<MarketData>>, ApiError> {
    if query.0.is_some_and(|q| !q.is_empty()) {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "invalid_query",
            "No query parameters are supported.",
        ));
    }

    let mut cache = tokio::time::timeout(TIMEOUT, state.market.lock())
        .await
        .map_err(|_| timed_out())?;
    let result = if let Some((expires, result)) = &*cache {
        if Instant::now() < *expires {
            Some(result.clone())
        } else {
            None
        }
    } else {
        None
    };
    let envelope = if let Some(result) = result {
        let mut envelope = result?;
        envelope.cached = true;
        envelope
    } else {
        let result = match tokio::time::timeout(
            TIMEOUT,
            service::market_overview(
                state.provider.as_ref(),
                &state.universe,
                &state.index,
                10,
                1e12,
            ),
        )
        .await
        {
            Ok(Ok(data)) if data.data.index.is_none() && data.data.quoted == 0 => {
                Err(unavailable())
            }
            Ok(Ok(data)) => Ok(public_envelope(SCHEMA_MARKET, data)),
            Ok(Err(err)) => Err(provider_error(err)),
            Err(_) => Err(timed_out()),
        };
        let ttl = if result.is_ok() {
            MARKET_TTL
        } else {
            FAILURE_TTL
        };
        *cache = Some((Instant::now() + ttl, result.clone()));
        result?
    };
    Ok(Json(Envelope {
        schema: envelope.schema,
        provider: envelope.provider,
        fetched_at: envelope.fetched_at,
        cached: envelope.cached,
        stale: envelope.stale,
        stale_reason: envelope.stale_reason,
        warnings: envelope.warnings,
        data: MarketData {
            overview: envelope.data,
            market_open: market_open(Utc::now()),
        },
    }))
}

#[derive(serde::Serialize)]
struct MarketData {
    #[serde(flatten)]
    overview: MarketOverview,
    market_open: Option<bool>,
}

async fn cors(State(origins): State<Arc<[HeaderValue]>>, req: Request, next: Next) -> Response {
    let origin = req
        .headers()
        .get(header::ORIGIN)
        .filter(|origin| origins.contains(origin))
        .cloned();
    let mut response = next.run(req).await;
    response
        .headers_mut()
        .append(header::VARY, HeaderValue::from_static("Origin"));
    if let Some(origin) = origin {
        response
            .headers_mut()
            .insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
    }
    response
}

fn router(provider: Arc<dyn Provider>, universe: Vec<Issuer>, origins: Vec<HeaderValue>) -> Router {
    Router::new()
        .route("/healthz", get(health))
        .route("/api/quote", get(quote))
        .route("/api/market", get(market))
        .route("/api/history", get(history))
        .with_state(AppState {
            provider,
            universe: universe.into(),
            index: Symbol::parse("^JKSE").expect("valid composite index"),
            quote_slots: Arc::new(Semaphore::new(4)),
            history_slots: Arc::new(Semaphore::new(2)),
            market: Arc::new(Mutex::new(None)),
        })
        .layer(middleware::from_fn_with_state(
            Arc::<[HeaderValue]>::from(origins),
            cors,
        ))
}

fn bind_address() -> anyhow::Result<SocketAddr> {
    if let Some(bind) = std::env::var_os("IDX_API_BIND") {
        return bind
            .into_string()
            .map_err(|_| anyhow::anyhow!("Invalid IDX_API_BIND"))?
            .parse()
            .map_err(|_| anyhow::anyhow!("IDX_API_BIND must be an IP address and port"));
    }
    let port = if let Some(port) = std::env::var_os("PORT") {
        port.to_str()
            .and_then(|p| p.parse::<u16>().ok())
            .filter(|p| *p != 0)
            .ok_or_else(|| anyhow::anyhow!("PORT must be between 1 and 65535"))?
    } else {
        8000
    };
    Ok(([127, 0, 0, 1], port).into())
}

fn allowed_origins(raw: &str) -> anyhow::Result<Vec<HeaderValue>> {
    raw.split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|origin| {
            let url = reqwest::Url::parse(origin)?;
            anyhow::ensure!(
                matches!(url.scheme(), "http" | "https")
                    && url.origin().ascii_serialization() == origin,
                "IDX_API_CORS_ORIGINS requires canonical HTTP(S) origins without paths"
            );
            Ok(HeaderValue::from_str(origin)?)
        })
        .collect()
}

async fn shutdown() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        if let Ok(mut terminate) = signal(SignalKind::terminate()) {
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {},
                _ = terminate.recv() => {},
            }
            return;
        }
    }
    let _ = tokio::signal::ctrl_c().await;
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, Layer};

    let log = tracing_subscriber::EnvFilter::builder()
        .with_default_directive(tracing::Level::INFO.into())
        .from_env()?;
    // Provider debug events can include full URLs. Enable only HTTP API events.
    tracing_subscriber::registry()
        .with(log)
        .with(
            tracing_subscriber::fmt::layer().with_filter(tracing_subscriber::filter::filter_fn(
                |meta| meta.target() == "idx_api",
            )),
        )
        .init();
    let addr = bind_address()?;
    let origins = match std::env::var("IDX_API_CORS_ORIGINS") {
        Ok(raw) => allowed_origins(&raw)?,
        Err(std::env::VarError::NotPresent) => vec![],
        Err(err) => return Err(err.into()),
    };
    let context = build_context(&GlobalOpts {
        output: None,
        provider: None,
        history_provider: None,
        offline: false,
        no_cache: false,
        no_color: true,
        timeout: None,
        cache_dir: None,
        config: None,
        verbose: 0,
        quiet: true,
    })?;
    let mut universe = universe::load(None)?;
    universe::extend_from_ownership(&mut universe, &context.settings.ownership_db);
    anyhow::ensure!(!universe.is_empty(), "IDX universe is empty");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(address = %listener.local_addr()?, "idx-api listening");
    axum::serve(listener, router(context.provider, universe, origins))
        .with_graceful_shutdown(shutdown())
        .await?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request};
    use http_body_util::BodyExt;
    use idx::{
        error::IdxError,
        model::{History, Interval, Period, Quote},
        providers::Sourced,
    };
    use tower::ServiceExt;

    struct OfflineProvider;
    struct Fixture(std::sync::atomic::AtomicUsize, bool);

    #[async_trait::async_trait]
    impl Provider for OfflineProvider {
        fn name(&self) -> &'static str {
            "fixture"
        }
        async fn quotes(&self, _: &[Symbol]) -> idx::Result<Sourced<Vec<Quote>>> {
            Err(IdxError::NotFound("fixture has no quotes".into()))
        }
        async fn history(
            &self,
            _: &Symbol,
            _: Period,
            _: Interval,
        ) -> idx::Result<Sourced<History>> {
            Err(IdxError::NotFound("fixture has no history".into()))
        }
        async fn fundamentals(&self, _: &Symbol) -> idx::Result<Sourced<idx::model::Fundamentals>> {
            Err(IdxError::NotFound("fixture has no fundamentals".into()))
        }
    }

    #[async_trait::async_trait]
    impl Provider for Fixture {
        fn name(&self) -> &'static str {
            "fixture"
        }

        async fn quotes(&self, symbols: &[Symbol]) -> idx::Result<Sourced<Vec<Quote>>> {
            self.0.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let rows = symbols
                .iter()
                .filter(|s| self.1 || **s != Symbol::parse("^JKSE").unwrap())
                .map(|s| {
                    serde_json::from_value(json!({
                        "symbol": s, "source": "fixture", "price": 123,
                        "change_pct": 1, "market_time": "2026-11-18T10:00:00+07:00"
                    }))
                    .unwrap()
                })
                .collect();
            let mut sourced = Sourced::fresh(rows, self.name());
            sourced.fetched_at = "2026-11-18T04:00:00Z".parse().unwrap();
            sourced.stale = true;
            sourced.warnings.push("fixture private details".into());
            Ok(sourced)
        }

        async fn history(
            &self,
            symbol: &Symbol,
            period: Period,
            interval: Interval,
        ) -> idx::Result<Sourced<History>> {
            assert_eq!(period, Period::M1);
            assert_eq!(interval, Interval::Day1);
            let time = Utc::now().with_timezone(&chrono::FixedOffset::east_opt(7 * 3600).unwrap());
            let candle = idx::model::Candle {
                time,
                open: 100.0,
                high: 125.0,
                low: 95.0,
                close: 123.0,
                adj_close: Some(110.0),
                volume: 0,
            };
            let mut old = candle.clone();
            old.time = time.checked_sub_days(chrono::Days::new(25)).unwrap();
            let mut result = Sourced::fresh(
                History {
                    symbol: symbol.clone(),
                    name: None,
                    currency: Some("IDR".into()),
                    period,
                    interval,
                    candles: vec![old, candle.clone(), candle],
                    summary: None,
                },
                self.name(),
            );
            result.cached = true;
            Ok(result)
        }

        async fn fundamentals(&self, _: &Symbol) -> idx::Result<Sourced<idx::model::Fundamentals>> {
            unreachable!("API never fetches fundamentals")
        }
    }

    fn one_issuer() -> Vec<Issuer> {
        let mut issuers = universe::load(None).unwrap();
        issuers.truncate(1);
        issuers
    }

    #[test]
    fn history_ranges_use_wib_calendar_windows() {
        let today = NaiveDate::from_ymd_opt(2024, 3, 31).unwrap();
        for (range, period, start) in [
            ("3w", Period::M1, "2024-03-11"),
            ("1mo", Period::M1, "2024-02-29"),
            ("3mo", Period::M3, "2023-12-31"),
            ("ytd", Period::Ytd, "2024-01-01"),
            ("1y", Period::Y1, "2023-03-31"),
            ("3y", Period::Y5, "2021-03-31"),
        ] {
            assert_eq!(
                history_window(range, today),
                Some((period, start.parse().unwrap()))
            );
        }
        assert_eq!(history_window("max", today), None);
    }

    #[tokio::test]
    async fn history_trims_daily_points_and_preserves_provider_metadata() {
        let app = router(Arc::new(Fixture(0.into(), false)), one_issuer(), vec![]);
        let (status, body) = request(app, "/api/history?symbol=bbca.jk&range=3w").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["schema"], SCHEMA_DAILY_HISTORY);
        assert_eq!(body["cached"], true);
        assert_eq!(body["data"]["symbol"], "BBCA");
        assert_eq!(body["data"]["range"], "3w");
        let points = body["data"]["points"].as_array().unwrap();
        assert_eq!(points.len(), 1);
        assert_eq!(points[0]["close"], 123.0);
        assert!(points[0]["volume"].is_null());
    }

    #[tokio::test]
    async fn history_rejects_invalid_ranges_and_non_stock_symbols() {
        let app = router(Arc::new(OfflineProvider), one_issuer(), vec![]);
        for path in [
            "/api/history?symbol=BBCA",
            "/api/history?symbol=BBCA&range=max",
            "/api/history?symbol=%5EJKSE&range=1mo",
            "/api/history?symbol=BBCA,BBRI&range=1mo",
            "/api/history?symbol=BBCA&range=1mo&interval=1m",
        ] {
            let (status, body) = request(app.clone(), path).await;
            assert_eq!(status, StatusCode::BAD_REQUEST);
            assert_eq!(body["error"]["code"], "invalid_history_query");
        }
    }

    #[tokio::test]
    async fn quote_success_preserves_metadata_and_nullable_fields() {
        let app = router(Arc::new(Fixture(0.into(), false)), one_issuer(), vec![]);
        let (status, body) =
            request(app.clone(), "/api/quote?symbols=%20bbca.jk%20,BBRI,BBCA").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["schema"], SCHEMA_QUOTES);
        assert_eq!(body["stale"], true);
        assert_eq!(body["data"].as_array().unwrap().len(), 2);
        assert_eq!(body["data"][0]["symbol"], "BBCA");
        assert_eq!(body["data"][1]["symbol"], "BBRI");
        assert!(body["data"][0]["volume"].is_null());
        assert_eq!(body["warnings"].as_array().unwrap().len(), 1);
        assert!(!body.to_string().contains("fixture private details"));
        assert_eq!(
            request(app, "/api/quote?symbols=BBCA").await.0,
            StatusCode::OK
        );
        assert!(parse_symbols(&["BBCA"; 21].join(",")).is_err());
        assert!(parse_symbols("BBCA BBRI").is_err());
    }

    #[tokio::test]
    async fn market_preserves_timestamp_and_shares_refresh_with_concurrent_calls() {
        let provider = Arc::new(Fixture(0.into(), false));
        let app = router(provider.clone(), one_issuer(), vec![]);
        let ((status, first), (_, second)) = tokio::join!(
            request(app.clone(), "/api/market"),
            request(app.clone(), "/api/market")
        );
        assert_eq!(status, StatusCode::OK);
        assert_eq!(first["schema"], SCHEMA_MARKET);
        assert!(first["data"]["index"].is_null());
        assert!(first["data"].get("market_open").is_some());
        assert_eq!(first["data"]["as_of"], "2026-11-18T10:00:00+07:00");
        assert_eq!(first["fetched_at"], "2026-11-18T04:00:00Z");
        assert_eq!(second["cached"], true);
        assert_eq!(provider.0.load(std::sync::atomic::Ordering::Relaxed), 2);
    }

    #[tokio::test]
    async fn market_index_has_dashboard_fields() {
        let app = router(Arc::new(Fixture(0.into(), true)), one_issuer(), vec![]);
        let (status, body) = request(app, "/api/market").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["data"]["index"]["price"].as_f64(), Some(123.0));
        assert!(body["data"]["index"]["change"].is_null());
        assert_eq!(body["data"]["index"]["change_pct"].as_f64(), Some(1.0));
    }

    async fn call(uri: &str) -> (StatusCode, Value) {
        request(router(Arc::new(OfflineProvider), one_issuer(), vec![]), uri).await
    }

    async fn request(app: Router, uri: &str) -> (StatusCode, Value) {
        let response = app
            .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice(&bytes).unwrap())
    }

    #[tokio::test]
    async fn health_is_available_without_network() {
        let (status, body) = call("/healthz").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, json!({"ok": true, "service": "idx-api"}));
    }

    #[tokio::test]
    async fn invalid_queries_do_not_hit_provider() {
        for uri in [
            "/api/quote",
            "/api/quote?symbols=",
            "/api/quote?symbols=BBCA,",
        ] {
            let (status, body) = call(uri).await;
            assert_eq!(status, StatusCode::BAD_REQUEST);
            assert_eq!(body["error"]["code"], "invalid_symbols");
        }
    }

    #[tokio::test]
    async fn provider_errors_do_not_leak_details() {
        let (status, body) = call("/api/quote?symbols=BBCA").await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"]["code"], "not_found");
        assert_eq!(body["error"]["message"], "No data found.");
        assert_eq!(call("/api/market").await.0, StatusCode::SERVICE_UNAVAILABLE);
    }
}
