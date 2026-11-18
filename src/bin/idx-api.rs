//! Minimal standalone HTTP API for the Thomas IDX Lab.
//! Run with: cargo run --bin idx-api
//! Default binding is loopback-only; set IDX_API_BIND explicitly to expose it.
use std::{net::SocketAddr, sync::Arc};

use axum::{
    extract::{Query, State},
    http::StatusCode,
    routing::get,
    Json, Router,
};
use idx::{
    cli::{build_context, GlobalOpts},
    model::Symbol,
    output::json::{Envelope, SCHEMA_QUOTES},
    providers::Provider,
};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Clone)]
struct AppState {
    provider: Arc<dyn Provider>,
}

#[derive(Deserialize)]
struct QuoteQuery {
    symbols: Option<String>,
}

fn parse_symbols(raw: Option<&str>) -> Result<Vec<Symbol>, &'static str> {
    let raw = raw.ok_or("symbols is required")?;
    let parts: Vec<_> = raw.split(',').map(str::trim).collect();
    if parts.is_empty() || parts.len() > 20 || parts.iter().any(|s| s.is_empty()) {
        return Err("provide 1 to 20 comma-separated symbols");
    }
    Symbol::parse_list(parts).map_err(|_| "invalid symbol")
}

fn error(status: StatusCode, code: &str, message: &str) -> (StatusCode, Json<Value>) {
    (
        status,
        Json(json!({ "error": { "code": code, "message": message } })),
    )
}

async fn health() -> Json<Value> {
    Json(json!({ "ok": true, "service": "idx-api" }))
}

async fn quote(
    State(state): State<AppState>,
    Query(query): Query<QuoteQuery>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let symbols = parse_symbols(query.symbols.as_deref())
        .map_err(|msg| error(StatusCode::BAD_REQUEST, "usage", msg))?;
    let result = state.provider.quotes(&symbols).await.map_err(|_| {
        error(
            StatusCode::BAD_GATEWAY,
            "provider",
            "quote provider unavailable",
        )
    })?;
    let envelope = Envelope::from_sourced(SCHEMA_QUOTES, result);
    let body = serde_json::to_value(envelope).map_err(|_| {
        error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
            "serialization failed",
        )
    })?;
    Ok(Json(body))
}

fn router(provider: Arc<dyn Provider>) -> Router {
    Router::new()
        .route("/healthz", get(health))
        .route("/api/quote", get(quote))
        .with_state(AppState { provider })
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Reuse the existing configuration, fetcher, cache and provider selection.
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
    let addr: SocketAddr = std::env::var("IDX_API_BIND")
        .unwrap_or_else(|_| "127.0.0.1:8000".to_string())
        .parse()?;
    let listener = tokio::net::TcpListener::bind(addr).await?;
    println!("idx-api listening on http://{addr}");
    axum::serve(listener, router(context.provider)).await?;
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

    async fn call(uri: &str) -> (StatusCode, Value) {
        let response = router(Arc::new(OfflineProvider))
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
        assert_eq!(body["ok"], true);
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
            assert_eq!(body["error"]["code"], "usage");
        }
    }

    #[tokio::test]
    async fn provider_errors_do_not_leak_details() {
        let (status, body) = call("/api/quote?symbols=BBCA").await;
        assert_eq!(status, StatusCode::BAD_GATEWAY);
        assert_eq!(body["error"]["code"], "provider");
        assert_eq!(body["error"]["message"], "quote provider unavailable");
    }
}
