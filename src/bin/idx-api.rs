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
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use chrono::{DateTime, Datelike, Months, NaiveDate, Timelike, Utc, Weekday};
use idx::{
    analysis::technical::{daily_indicators, DailyIndicators},
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
type MarketResult = Result<Envelope<service::MarketWithMoverFallback>, ApiError>;

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
    #[serde(default)]
    indicators: bool,
    before: Option<NaiveDate>,
    symbol: String,
    range: String,
}

#[derive(serde::Serialize)]
struct DailyHistory {
    symbol: Symbol,
    range: String,
    currency: Option<String>,
    points: Vec<DailyPoint>,
    #[serde(skip_serializing_if = "Option::is_none")]
    interval: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    next_before: Option<NaiveDate>,
    #[serde(skip_serializing_if = "Option::is_none")]
    calculation: Option<Calculation>,
}

#[derive(serde::Serialize)]
struct Calculation {
    method: &'static str,
    basis: &'static str,
    window_start: NaiveDate,
    as_of: NaiveDate,
    calendar_years: Vec<i32>,
}

#[derive(serde::Serialize)]
struct DailyPoint {
    #[serde(skip_serializing_if = "Option::is_none")]
    indicators: Option<DailyIndicators>,
    date: NaiveDate,
    bar_time: DateTime<chrono::FixedOffset>,
    open: Option<f64>,
    high: Option<f64>,
    low: Option<f64>,
    close: f64,
    adjusted_close: Option<f64>,
    provisional: bool,
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
            "Supply one IDX stock symbol and a range: 3w, 1mo, 3mo, ytd, 1y, 3y or all.",
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
    let weekly = query.range == "all";
    let end = query.before.unwrap_or_else(|| today + chrono::Days::new(1));
    if end > today + chrono::Days::new(1) || end.year() < 1900 {
        return Err(invalid());
    }
    let (period, start) = if weekly {
        (
            Period::Max,
            end.checked_sub_months(Months::new(60))
                .ok_or_else(invalid)?,
        )
    } else {
        history_window(&query.range, today).ok_or_else(invalid)?
    };
    let interval = if weekly {
        Interval::Week1
    } else {
        Interval::Day1
    };
    // The visual range is independent of the provider history used for warm-up.
    let full_history = weekly || query.indicators || query.before.is_some();
    let period = if full_history { Period::Max } else { period };
    let _slot = state
        .history_slots
        .try_acquire()
        .map_err(|_| unavailable())?;
    let sourced = tokio::time::timeout(TIMEOUT, state.provider.history(&symbol, period, interval))
        .await
        .map_err(|_| timed_out())?
        .map_err(provider_error)?;
    if sourced.data.interval != interval || sourced.data.symbol != symbol {
        return Err(unavailable());
    }

    let fetched_at = sourced.fetched_at;
    let as_of = fetched_at
        .with_timezone(&idx::model::wib())
        .date_naive()
        .min(today);
    let window_start = NaiveDate::from_ymd_opt(1900, 1, 1).expect("valid date");
    let calculation = query.indicators.then(|| Calculation {
        method: if weekly {
            "idx.technical.weekly.v1"
        } else {
            "idx.technical.v2"
        },
        basis: "close",
        window_start,
        as_of,
        calendar_years: holidays::years(),
    });
    let result = sourced.map(|history| {
        let mut points = daily_points(
            history.candles,
            history.close_only,
            if full_history { window_start } else { start },
            today,
            fetched_at,
        );
        let next_before = if weekly {
            for point in &mut points {
                point.date = point.date
                    - chrono::Days::new(u64::from(point.date.weekday().num_days_from_monday()));
                point.provisional = point.date + chrono::Days::new(7) > as_of;
            }
            points.dedup_by_key(|point| point.date);
            if calculation.is_some() {
                attach_weekly_indicators(&mut points);
            }
            let more = points.iter().any(|p| p.date < start);
            points.retain(|point| point.date >= start && point.date < end);
            more.then_some(start)
        } else {
            if calculation.is_some() {
                attach_indicators(&mut points);
            }
            // Initial viewport is the requested range. Earlier pages contain up
            // to 500 actual observations, so long gaps never produce empty pages.
            if query.before.is_some() {
                points.retain(|point| point.date < end);
                let count = points.len().saturating_sub(500);
                let more = count > 0;
                points.drain(..count);
                more.then(|| points[0].date)
            } else {
                let more = points.iter().any(|point| point.date < start);
                points.retain(|point| point.date >= start && point.date < end);
                if more && !points.is_empty() {
                    Some(points[0].date)
                } else {
                    None
                }
            }
        };
        DailyHistory {
            symbol,
            range: query.range,
            calculation,
            interval: weekly.then_some("1wk"),
            next_before,
            points,
            currency: history.currency.and_then(|currency| {
                let code = currency.trim().to_ascii_uppercase();
                (code.len() == 3 && code.bytes().all(|byte| byte.is_ascii_uppercase()))
                    .then_some(code)
            }),
        }
    });
    Ok(Json(public_envelope(SCHEMA_DAILY_HISTORY, result)))
}

fn daily_points(
    candles: Vec<idx::model::Candle>,
    close_only: Vec<idx::model::CloseObservation>,
    start: NaiveDate,
    today: NaiveDate,
    fetched_at: DateTime<Utc>,
) -> Vec<DailyPoint> {
    let wib = idx::model::wib();
    let fetched_date = fetched_at.with_timezone(&wib).date_naive();
    let last_complete =
        holidays::covers(fetched_date.year()).then(|| holidays::latest_session(fetched_at));
    let full = candles.into_iter().map(|c| {
        let valid = [c.open, c.high, c.low]
            .iter()
            .all(|p| p.is_finite() && *p > 0.0)
            && c.low <= c.open.min(c.close)
            && c.high >= c.open.max(c.close);
        (
            c.time,
            c.close,
            c.adj_close,
            c.volume,
            valid.then_some((c.open, c.high, c.low)),
        )
    });
    let partial = close_only
        .into_iter()
        .map(|p| (p.time, p.close, p.adj_close, p.volume, None));
    let mut points: Vec<_> = full
        .chain(partial)
        .filter_map(|(time, close, adj, volume, ohl)| {
            let bar_time = time.with_timezone(&wib);
            let date = bar_time.date_naive();
            if !(start..=today.min(fetched_date)).contains(&date)
                || !close.is_finite()
                || close <= 0.0
            {
                return None;
            }
            Some(DailyPoint {
                indicators: None,
                date,
                bar_time,
                open: ohl.map(|p| p.0),
                high: ohl.map(|p| p.1),
                low: ohl.map(|p| p.2),
                close,
                adjusted_close: adj.filter(|value| value.is_finite() && *value > 0.0),
                provisional: last_complete.map_or(date == fetched_date, |last| date > last),
                volume: (volume > 0).then_some(volume),
            })
        })
        .collect();
    points.sort_by_key(|p| std::cmp::Reverse(p.bar_time));
    points.dedup_by_key(|p| p.date);
    points.reverse();
    points
}

#[cfg(test)]
fn indicator_window(points: &mut Vec<DailyPoint>, start: NaiveDate) {
    attach_indicators(points);
    points.retain(|p| p.date >= start);
}

// Only a verified exchange calendar can establish that a provider omitted a session.
// Outside its coverage, use the observed trading dates without inventing holidays.
fn daily_contiguous(previous: NaiveDate, current: NaiveDate) -> bool {
    let mut date = previous + chrono::Days::new(1);
    while date < current {
        if holidays::covers(date.year()) && holidays::is_trading_day(date) {
            return false;
        }
        date += chrono::Duration::days(1);
    }
    true
}

// Split at known missing sessions; unverified older dates use observed closes.
fn attach_indicators(points: &mut [DailyPoint]) {
    let eligible = |p: &DailyPoint| !p.provisional && holidays::is_trading_day(p.date);
    let mut remaining = points;
    while let Some((first, rest)) = remaining.split_first_mut() {
        if !eligible(first) {
            remaining = rest;
            continue;
        }
        let mut previous = first.date;
        let count = rest
            .iter()
            .take_while(|p| {
                let consecutive = eligible(p) && daily_contiguous(previous, p.date);
                previous = p.date;
                consecutive
            })
            .count();
        let (continuation, tail) = rest.split_at_mut(count);
        let closes: Vec<_> = std::iter::once(first.close)
            .chain(continuation.iter().map(|p| p.close))
            .collect();
        for (point, values) in std::iter::once(first)
            .chain(continuation)
            .zip(daily_indicators(&closes))
        {
            point.indicators = Some(values);
        }
        remaining = tail;
    }
}

// Weekly provider observations are used as reported; missing weeks reset the seed.
fn attach_weekly_indicators(points: &mut [DailyPoint]) {
    let mut remaining = points;
    while let Some((first, rest)) = remaining.split_first_mut() {
        if first.provisional {
            remaining = rest;
            continue;
        }
        let mut previous = first.date;
        let count = rest
            .iter()
            .take_while(|point| {
                let consecutive =
                    !point.provisional && point.date == previous + chrono::Days::new(7);
                previous = point.date;
                consecutive
            })
            .count();
        let (continuation, tail) = rest.split_at_mut(count);
        let closes: Vec<_> = std::iter::once(first.close)
            .chain(continuation.iter().map(|point| point.close))
            .collect();
        for (point, values) in std::iter::once(first)
            .chain(continuation)
            .zip(daily_indicators(&closes))
        {
            point.indicators = Some(values);
        }
        remaining = tail;
    }
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
            service::market_overview_with_mover_fallback(
                state.provider.as_ref(),
                &state.universe,
                &state.index,
                10,
                1e12,
            ),
        )
        .await
        {
            Ok(Ok(data))
                if data.data.overview.index.is_none() && data.data.overview.quoted == 0 =>
            {
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
            overview: envelope.data.overview,
            gainers_fallback: envelope.data.gainers_fallback,
            losers_fallback: envelope.data.losers_fallback,
            market_open: market_open(Utc::now()),
        },
    }))
}

#[derive(serde::Serialize)]
struct MarketData {
    #[serde(flatten)]
    overview: MarketOverview,
    market_open: Option<bool>,
    gainers_fallback: bool,
    losers_fallback: bool,
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

/// Shared per-process budget. Forwarded client addresses are deliberately not trusted.
struct ApiBudget {
    window: Mutex<(Instant, u32)>,
    active: Semaphore,
}

const REQUESTS_PER_MINUTE: u32 = 120;
async fn limit_api(State(budget): State<Arc<ApiBudget>>, req: Request, next: Next) -> Response {
    if req.uri().query().is_some_and(|q| q.len() > 2048) {
        return error(
            StatusCode::URI_TOO_LONG,
            "query_too_long",
            "Query exceeds 2048 bytes.",
        )
        .into_response();
    }
    {
        let mut window = budget.window.lock().await;
        let elapsed = window.0.elapsed().as_secs();
        if elapsed >= 60 {
            *window = (Instant::now(), 0);
        }
        if window.1 >= REQUESTS_PER_MINUTE {
            let mut response = error(
                StatusCode::TOO_MANY_REQUESTS,
                "rate_limited",
                "Retry after the current request window.",
            )
            .into_response();
            response
                .headers_mut()
                .insert(header::RETRY_AFTER, HeaderValue::from(60 - elapsed));
            return response;
        }
        window.1 += 1;
    }
    let Ok(_slot) = budget.active.try_acquire() else {
        return unavailable().into_response();
    };
    next.run(req).await
}

fn router(provider: Arc<dyn Provider>, universe: Vec<Issuer>, origins: Vec<HeaderValue>) -> Router {
    Router::new()
        .route("/api/quote", get(quote))
        .route("/api/market", get(market))
        .route("/api/history", get(history))
        .route_layer(middleware::from_fn_with_state(
            Arc::new(ApiBudget {
                window: Mutex::new((Instant::now(), 0)),
                active: Semaphore::new(12),
            }),
            limit_api,
        ))
        .route("/healthz", get(health))
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
                        "change_pct": 1, "market_time": "2026-11-18T10:00:00+07:00", "volume": self.1.then_some(100)
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
            if interval == Interval::Week1 {
                assert_eq!(period, Period::Max);
            } else {
                assert_eq!(period, if self.1 { Period::Max } else { Period::M1 });
                assert_eq!(interval, Interval::Day1);
            }
            let wib = idx::model::wib();
            let time = Utc::now()
                .with_timezone(&wib)
                .date_naive()
                .and_hms_opt(0, 0, 0)
                .unwrap()
                .and_local_timezone(wib)
                .unwrap();
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
                    close_only: Vec::new(),
                    symbol: symbol.clone(),
                    name: None,
                    currency: Some("IDR".into()),
                    period,
                    interval,
                    candles: if interval == Interval::Week1 {
                        (0..600)
                            .rev()
                            .map(|week| {
                                let mut row = candle.clone();
                                row.time = time - chrono::Days::new(week * 7);
                                row
                            })
                            .collect()
                    } else if period == Period::Max {
                        (0..3000)
                            .rev()
                            .filter_map(|day| {
                                let mut row = candle.clone();
                                row.time = time - chrono::Days::new(day);
                                holidays::is_trading_day(row.time.date_naive()).then_some(row)
                            })
                            .collect()
                    } else {
                        vec![old, candle.clone(), candle]
                    },
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
        assert_eq!(body["data"]["currency"], "IDR");
        let points = body["data"]["points"].as_array().unwrap();
        assert_eq!(points.len(), 1);
        assert_eq!(points[0]["open"], 100.0);
        assert_eq!(points[0]["high"], 125.0);
        assert_eq!(points[0]["low"], 95.0);
        assert_eq!(points[0]["close"], 123.0);
        assert_eq!(points[0]["adjusted_close"], 110.0);
        assert!(points[0]["bar_time"].as_str().unwrap().ends_with("+07:00"));
        assert!(points[0]["volume"].is_null());
    }

    #[tokio::test]
    async fn indicator_ranges_request_same_source_and_crop_after_calculation() {
        let app = router(Arc::new(Fixture(0.into(), true)), one_issuer(), vec![]);
        let (status, short) = request(
            app.clone(),
            "/api/history?symbol=BBCA&range=3w&indicators=true",
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let (status, long) =
            request(app, "/api/history?symbol=BBCA&range=3y&indicators=true").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(short["data"]["calculation"], long["data"]["calculation"]);
        assert_eq!(short["data"]["calculation"]["basis"], "close");
        let short_points = short["data"]["points"].as_array().unwrap();
        let long_points = long["data"]["points"].as_array().unwrap();
        assert!(short_points[0]["indicators"]["sma200"].is_number());
        assert_eq!(
            short_points,
            &long_points[long_points.len() - short_points.len()..]
        );
        // The first 3-year candle has enough provider history even before 2026.
        assert!(long_points[0]["indicators"]["ema20"].is_number());
    }

    #[tokio::test]
    async fn daily_history_pages_keep_initial_range_and_indicator_values() {
        let app = router(Arc::new(Fixture(0.into(), true)), one_issuer(), vec![]);
        let (status, first) = request(
            app.clone(),
            "/api/history?symbol=BBCA&range=3w&indicators=true",
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let first = &first["data"];
        let recent = first["points"].as_array().unwrap();
        assert!(recent.len() <= 21);
        let cursor = first["next_before"].as_str().unwrap();
        assert_eq!(cursor, recent[0]["date"].as_str().unwrap());
        let path = format!("/api/history?symbol=BBCA&range=3w&indicators=true&before={cursor}");
        let (status, older) = request(app.clone(), &path).await;
        assert_eq!(status, StatusCode::OK);
        let older = &older["data"];
        let rows = older["points"].as_array().unwrap();
        assert_eq!(rows.len(), 500);
        assert!(rows.last().unwrap()["date"].as_str().unwrap() < cursor);
        assert!(rows[0]["indicators"]["sma200"].is_number());
        let (_, long) = request(
            app.clone(),
            "/api/history?symbol=BBCA&range=3y&indicators=true",
        )
        .await;
        let long = long["data"]["points"].as_array().unwrap();
        for row in rows {
            let same = long
                .iter()
                .find(|point| point["date"] == row["date"])
                .unwrap();
            assert_eq!(row, same);
        }
        let mut cursor = older["next_before"].as_str().map(str::to_owned);
        let mut count = recent.len() + rows.len();
        let mut oldest = rows[0].clone();
        while let Some(before) = cursor {
            let path = format!("/api/history?symbol=BBCA&range=3w&indicators=true&before={before}");
            let (status, page) = request(app.clone(), &path).await;
            assert_eq!(status, StatusCode::OK);
            let data = &page["data"];
            let points = data["points"].as_array().unwrap();
            assert!(!points.is_empty() && points.len() <= 500);
            assert!(points.last().unwrap()["date"].as_str().unwrap() < before.as_str());
            oldest = points[0].clone();
            count += points.len();
            assert!(count <= 3000);
            cursor = data["next_before"].as_str().map(str::to_owned);
        }
        assert!(count > 1500);
        assert!(oldest["indicators"]["sma200"].is_null());
        assert_eq!(oldest["indicators"]["observations"], 1);
    }

    #[tokio::test]
    async fn weekly_pages_are_disjoint_and_keep_warmed_up_indicators() {
        let app = router(Arc::new(Fixture(0.into(), true)), one_issuer(), vec![]);
        let (status, first) = request(
            app.clone(),
            "/api/history?symbol=BBCA&range=all&indicators=true",
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let data = &first["data"];
        assert_eq!(data["interval"], "1wk");
        let rows = data["points"].as_array().unwrap();
        assert!((259..=262).contains(&rows.len()));
        assert!(rows[0]["indicators"]["sma200"].is_number());
        assert_eq!(rows.last().unwrap()["provisional"], true);
        assert!(rows.last().unwrap()["indicators"].is_null());
        let before = data["next_before"].as_str().unwrap();
        let path = format!("/api/history?symbol=BBCA&range=all&indicators=true&before={before}");
        let (status, older) = request(app, &path).await;
        assert_eq!(status, StatusCode::OK);
        let earlier = older["data"]["points"].as_array().unwrap();
        assert!(
            earlier.last().unwrap()["date"].as_str().unwrap() < rows[0]["date"].as_str().unwrap()
        );
        assert_eq!(earlier.last().unwrap()["indicators"]["sma20"], 123.0);
    }

    #[test]
    fn visual_window_does_not_change_warmed_up_values() {
        let as_of: NaiveDate = "2026-11-27".parse().unwrap();
        let rows = || {
            let mut date: NaiveDate = "2026-01-02".parse().unwrap();
            let mut rows = Vec::new();
            while date <= as_of {
                if holidays::is_trading_day(date) {
                    rows.push(DailyPoint {
                        date,
                        bar_time: date
                            .and_hms_opt(9, 0, 0)
                            .unwrap()
                            .and_local_timezone(idx::model::wib())
                            .unwrap(),
                        open: None,
                        high: None,
                        low: None,
                        close: 100.0 + (rows.len() % 17) as f64,
                        adjusted_close: Some(75.0),
                        volume: None,
                        indicators: None,
                        provisional: false,
                    });
                }
                date = date.succ_opt().unwrap();
            }
            rows
        };
        let mut short = rows();
        let mut long = rows();
        indicator_window(&mut short, history_window("3w", as_of).unwrap().1);
        indicator_window(&mut long, history_window("3y", as_of).unwrap().1);
        assert!(short.len() < 20 && short[0].indicators.as_ref().unwrap().sma200.is_some());
        assert_eq!(
            serde_json::to_value(&short).unwrap(),
            serde_json::to_value(&long[long.len() - short.len()..]).unwrap()
        );
    }

    #[test]
    fn studies_restart_after_a_verified_missing_session_and_exclude_provisional_dates() {
        let make = |day: &str, provisional| DailyPoint {
            date: day.parse().unwrap(),
            bar_time: format!("{day}T09:00:00+07:00").parse().unwrap(),
            open: None,
            high: None,
            low: None,
            close: 100.0,
            adjusted_close: Some(60.0),
            volume: None,
            indicators: None,
            provisional,
        };
        let mut points = [
            make("2025-12-24", false),
            make("2025-12-30", false),
            make("2026-11-06", false),
            make("2026-11-09", false),
            make("2026-11-11", false),
            make("2026-11-12", true),
            make("2026-11-13", false),
        ];
        attach_indicators(&mut points);
        assert_eq!(
            points.map(|p| p.indicators.map(|v| v.observations)),
            [Some(1), Some(2), Some(1), Some(2), Some(1), None, Some(1)]
        );
    }

    #[test]
    fn history_normalizes_days_and_marks_intraday_captures() {
        let candle = |time: &str, close, adj_close, volume| idx::model::Candle {
            time: time.parse().unwrap(),
            open: close,
            high: close,
            low: close,
            close,
            adj_close,
            volume,
        };
        let candles = vec![
            candle("2026-11-09T02:00:00Z", 100.0, Some(97.0), 100),
            candle("2026-11-08T18:00:00Z", 95.0, None, 50),
            candle("2026-11-06T02:00:00Z", 92.0, Some(f64::NAN), 0),
            candle("2026-11-10T02:00:00Z", 900.0, None, 100),
        ];
        let start = NaiveDate::from_ymd_opt(2026, 11, 1).unwrap();
        let today = NaiveDate::from_ymd_opt(2026, 11, 10).unwrap();
        let intraday = daily_points(
            candles.clone(),
            Vec::new(),
            start,
            today,
            "2026-11-09T06:00:00Z".parse().unwrap(),
        );
        assert_eq!(intraday.len(), 2);
        assert_eq!(intraday[0].adjusted_close, None);
        assert_eq!(intraday[0].volume, None);
        assert!(!intraday[0].provisional);
        assert_eq!(intraday[1].date.to_string(), "2026-11-09");
        assert_eq!(intraday[1].close, 100.0);
        assert_eq!(intraday[1].adjusted_close, Some(97.0));
        assert!(intraday[1].provisional);
        let after_close = daily_points(
            candles,
            Vec::new(),
            start,
            today,
            "2026-11-09T09:15:00Z".parse().unwrap(),
        );
        assert!(!after_close[1].provisional);
    }

    #[test]
    fn partial_and_inconsistent_bars_preserve_close_without_candlesticks() {
        let fetched: DateTime<Utc> = "2026-11-09T10:00:00Z".parse().unwrap();
        let invalid = idx::model::Candle {
            time: "2026-11-06T09:00:00+07:00".parse().unwrap(),
            open: 111.0,
            high: 105.0,
            low: 90.0,
            close: 100.0,
            adj_close: None,
            volume: 100,
        };
        let partial = idx::model::CloseObservation {
            time: "2026-11-09T09:00:00+07:00".parse().unwrap(),
            close: 103.0,
            adj_close: Some(102.0),
            volume: 0,
        };
        let points = daily_points(
            vec![invalid],
            vec![partial],
            "2026-11-01".parse().unwrap(),
            fetched.date_naive(),
            fetched,
        );
        assert_eq!(points.len(), 2);
        assert!(points
            .iter()
            .all(|p| p.open.is_none() && p.high.is_none() && p.low.is_none()));
        assert_eq!(points[1].close, 103.0);
        assert_eq!(points[1].adjusted_close, Some(102.0));
        assert_eq!(points[1].volume, None);
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
        assert_eq!(body["data"]["gainers_fallback"], true);
        assert_eq!(body["data"]["losers_fallback"], false);
        assert_eq!(body["data"]["gainers"][0]["volume"], 100);
        assert!(body["data"]["gainers"][0]["market_cap"].is_null());
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
    async fn public_budget_limits_api_requests_and_keeps_liveness_available() {
        let app = router(Arc::new(OfflineProvider), one_issuer(), vec![]);
        let oversized = "/api/history?".to_string() + &"a".repeat(2049);
        assert_eq!(
            request(app.clone(), &oversized).await.0,
            StatusCode::URI_TOO_LONG
        );
        for _ in 0..REQUESTS_PER_MINUTE {
            assert_eq!(
                request(app.clone(), "/api/quote").await.0,
                StatusCode::BAD_REQUEST
            );
        }
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/market")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        assert!(response.headers().contains_key(header::RETRY_AFTER));
        assert_eq!(request(app, "/healthz").await.0, StatusCode::OK);
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
