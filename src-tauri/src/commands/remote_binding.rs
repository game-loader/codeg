//! Fixed connection snapshots and invalidation shared by desktop proxies and
//! server-mode tests. A binding never resolves another machine after an await.
use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use sea_orm::DatabaseConnection;
use serde_json::Value;
use tokio::sync::{Mutex, RwLock};
use tokio_util::sync::CancellationToken;

use crate::app_error::AppCommandError;
use crate::db::service::remote_workspace_connection_service;
use crate::models::{RemoteWorkspaceConnectionInfo, ToHeaderMap};

#[derive(Default)]
pub struct RemoteBindingState {
    /// Update/delete serialize with loading and registering a binding. The
    /// guard is released before network I/O; invalidation cancels that I/O.
    gates: Mutex<HashMap<i32, Arc<RwLock<()>>>>,
    tokens: Mutex<HashMap<i32, CancellationToken>>,
}

pub struct RemoteBinding {
    pub connection: RemoteWorkspaceConnectionInfo,
    pub invalidated: CancellationToken,
}

pub fn configuration_changed() -> AppCommandError {
    AppCommandError::configuration_invalid(
        "Remote connection configuration changed; rebuild the backend runtime",
    )
}

impl RemoteBindingState {
    pub async fn gate(&self, id: i32) -> Arc<RwLock<()>> {
        self.gates.lock().await.entry(id).or_default().clone()
    }

    pub async fn bind(
        &self,
        db: &DatabaseConnection,
        id: i32,
        config_revision: Option<&str>,
    ) -> Result<RemoteBinding, AppCommandError> {
        let gate = self.gate(id).await;
        let _guard = gate.read().await;
        self.bind_locked(db, id, config_revision).await
    }

    /// Caller holds `gate` while atomically registering a WS or transfer.
    pub async fn bind_locked(
        &self,
        db: &DatabaseConnection,
        id: i32,
        config_revision: Option<&str>,
    ) -> Result<RemoteBinding, AppCommandError> {
        let connection = remote_workspace_connection_service::get(db, id)
            .await
            .map_err(AppCommandError::db)?
            .ok_or_else(|| {
                AppCommandError::not_found(format!("Remote connection {id} not found"))
            })?;
        if config_revision.is_some_and(|revision| revision != connection.config_revision) {
            return Err(configuration_changed());
        }
        let invalidated = self.tokens.lock().await.entry(id).or_default().clone();
        Ok(RemoteBinding {
            connection,
            invalidated,
        })
    }

    /// Caller holds the write guard through the configuration mutation.
    pub async fn invalidate_locked(&self, id: i32) {
        if let Some(token) = self.tokens.lock().await.remove(&id) {
            token.cancel();
        }
    }
}

impl RemoteBinding {
    /// Fence local delivery against update/delete, including a frame selected
    /// before the writer acquired the gate. Keep the guard through all local
    /// state changes and emission; ordinary network I/O must use `run` instead.
    pub async fn with_current<T>(
        &self,
        bindings: &RemoteBindingState,
        action: impl Future<Output = T>,
    ) -> Option<T> {
        let gate = bindings.gate(self.connection.id).await;
        let _guard = gate.read().await;
        if self.invalidated.is_cancelled() {
            return None;
        }
        Some(action.await)
    }

    pub async fn run<T>(
        &self,
        future: impl Future<Output = Result<T, AppCommandError>>,
    ) -> Result<T, AppCommandError> {
        tokio::select! {
            biased;
            _ = self.invalidated.cancelled() => Err(configuration_changed()),
            result = future => result,
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub async fn remote_http_call_core(
    db: &DatabaseConnection,
    bindings: &RemoteBindingState,
    client: &reqwest::Client,
    connection_id: i32,
    command: &str,
    args: Option<Value>,
    timeout_ms: Option<u64>,
    config_revision: Option<&str>,
) -> Result<Value, AppCommandError> {
    let binding = bindings.bind(db, connection_id, config_revision).await?;
    let conn = &binding.connection;
    binding
        .run(async {
            let url = format!(
                "{}/api/{}",
                conn.base_url.trim_end_matches('/'),
                command.trim_start_matches('/')
            );
            let mut request = client
                .post(url)
                .bearer_auth(conn.token.trim())
                .headers(conn.headers.to_header_map())
                .json(&args.unwrap_or_else(|| serde_json::json!({})));
            if let Some(ms) = timeout_ms {
                request = request.timeout(Duration::from_millis(ms).min(Duration::from_secs(600)));
            }
            let response = request.send().await.map_err(|e| {
                AppCommandError::network("Remote HTTP request failed")
                    .with_detail(request_error_detail(&e))
            })?;
            let status = response.status();
            if status == reqwest::StatusCode::UNAUTHORIZED {
                return Err(AppCommandError::authentication_failed(
                    "Remote Workspace token is invalid",
                ));
            }
            if !status.is_success() {
                let raw = response.text().await.unwrap_or_default();
                if let Ok(error) = serde_json::from_str::<AppCommandError>(&raw) {
                    return Err(error);
                }
                return Err(
                    AppCommandError::network(format!("Remote returned HTTP {status}"))
                        .with_detail(raw),
                );
            }
            response.json::<Value>().await.map_err(|e| {
                AppCommandError::network("Failed to parse remote response")
                    .with_detail(e.to_string())
            })
        })
        .await
}

pub fn ws_connect_is_unauthorized(error: &tokio_tungstenite::tungstenite::Error) -> bool {
    matches!(error, tokio_tungstenite::tungstenite::Error::Http(response)
        if response.status() == http::StatusCode::UNAUTHORIZED)
}

pub fn request_error_detail(err: &reqwest::Error) -> String {
    let mut detail = err.to_string();
    let mut source = std::error::Error::source(err);
    while let Some(cause) = source {
        detail.push_str(": ");
        detail.push_str(&cause.to_string());
        source = cause.source();
    }
    detail
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_error::AppErrorCode;
    use crate::db::test_helpers::fresh_in_memory_db;
    use crate::models::RemoteWorkspaceHeader;
    use axum::{http::HeaderMap, routing::post, Json, Router};
    use std::sync::Arc;

    fn test_client() -> reqwest::Client {
        reqwest::Client::builder().no_proxy().build().unwrap()
    }

    fn assert_code(actual: AppErrorCode, expected: AppErrorCode) {
        assert_eq!(
            serde_json::to_value(actual).unwrap(),
            serde_json::to_value(expected).unwrap()
        );
    }

    async fn echo_server() -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            axum::serve(listener, Router::new().route("/api/echo", post(|headers: HeaderMap| async move {
                Json(serde_json::json!({
                    "authorization": headers.get("authorization").unwrap().to_str().unwrap(),
                    "custom": headers.get("x-test").map(|value| value.to_str().unwrap()),
                }))
            }))).await.unwrap();
        });
        (format!("http://{address}"), task)
    }

    #[tokio::test]
    async fn selected_delivery_waiting_on_update_or_delete_never_runs_after_invalidation() {
        for deleted in [false, true] {
            let db = fresh_in_memory_db().await;
            let bindings = Arc::new(RemoteBindingState::default());
            let a = remote_workspace_connection_service::create(
                &db.conn,
                "A",
                "http://localhost:3080",
                "token",
                &[],
            )
            .await
            .unwrap();
            let binding = bindings.bind(&db.conn, a.id, None).await.unwrap();
            let gate = bindings.gate(a.id).await;
            let guard = gate.write().await;
            let (selected_tx, selected_rx) = tokio::sync::oneshot::channel();
            let delivery_bindings = bindings.clone();
            let delivered = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let changed = delivered.clone();
            let delivery = tokio::spawn(async move {
                selected_tx.send(()).unwrap();
                binding
                    .with_current(&delivery_bindings, async {
                        changed.store(true, std::sync::atomic::Ordering::SeqCst);
                    })
                    .await
            });
            selected_rx.await.unwrap();
            if deleted {
                remote_workspace_connection_service::delete(&db.conn, a.id)
                    .await
                    .unwrap();
            } else {
                remote_workspace_connection_service::update(
                    &db.conn,
                    a.id,
                    "A",
                    "http://localhost:3090",
                    "token",
                    &[],
                )
                .await
                .unwrap();
            }
            bindings.invalidate_locked(a.id).await;
            drop(guard);
            assert!(delivery.await.unwrap().is_none());
            assert!(!delivered.load(std::sync::atomic::Ordering::SeqCst));
        }
    }

    #[tokio::test]
    async fn delivery_holds_the_gate_until_emission_completes_without_blocking_b() {
        let db = fresh_in_memory_db().await;
        let bindings = Arc::new(RemoteBindingState::default());
        let a = remote_workspace_connection_service::create(
            &db.conn,
            "A",
            "http://localhost:3080",
            "token",
            &[],
        )
        .await
        .unwrap();
        let b = remote_workspace_connection_service::create(
            &db.conn,
            "B",
            "http://localhost:3081",
            "token",
            &[],
        )
        .await
        .unwrap();
        let binding = bindings.bind(&db.conn, a.id, None).await.unwrap();
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let delivery_bindings = bindings.clone();
        let delivery = tokio::spawn(async move {
            binding
                .with_current(&delivery_bindings, async {
                    entered_tx.send(()).unwrap();
                    release_rx.await.unwrap();
                })
                .await
        });
        entered_rx.await.unwrap();
        let gate = bindings.gate(a.id).await;
        let writer = gate.write();
        tokio::pin!(writer);
        assert!(futures_util::poll!(&mut writer).is_pending());
        assert!(bindings.bind(&db.conn, b.id, None).await.is_ok());
        release_tx.send(()).unwrap();
        assert_eq!(delivery.await.unwrap(), Some(()));
        let _guard = writer.await;
        bindings.invalidate_locked(a.id).await;
    }

    #[tokio::test]
    async fn revision_rejects_old_binding_and_legacy_calls_use_new_credentials() {
        let db = fresh_in_memory_db().await;
        let bindings = RemoteBindingState::default();
        let (url_a, task_a) = echo_server().await;
        let (url_b, task_b) = echo_server().await;
        let original =
            remote_workspace_connection_service::create(&db.conn, "A", &url_a, "old-token", &[])
                .await
                .unwrap();
        let old_binding = bindings
            .bind(&db.conn, original.id, Some(&original.config_revision))
            .await
            .unwrap();
        let gate = bindings.gate(original.id).await;
        let guard = gate.write().await;
        let updated = remote_workspace_connection_service::update(
            &db.conn,
            original.id,
            "B",
            &url_b,
            "new-token",
            &[RemoteWorkspaceHeader {
                name: "X-Test".into(),
                value: "new-header".into(),
            }],
        )
        .await
        .unwrap();
        bindings.invalidate_locked(original.id).await;
        drop(guard);
        assert_ne!(original.config_revision, updated.config_revision);
        assert!(old_binding.invalidated.is_cancelled());
        assert!(!updated.config_revision.contains("token"));
        let client = test_client();
        let err = remote_http_call_core(
            &db.conn,
            &bindings,
            &client,
            original.id,
            "echo",
            None,
            None,
            Some(&original.config_revision),
        )
        .await
        .unwrap_err();
        assert_code(err.code, AppErrorCode::ConfigurationInvalid);
        let legacy = remote_http_call_core(
            &db.conn,
            &bindings,
            &client,
            original.id,
            "echo",
            None,
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(legacy["authorization"], "Bearer new-token");
        assert_eq!(legacy["custom"], "new-header");
        remote_workspace_connection_service::reorder(&db.conn, vec![original.id])
            .await
            .unwrap();
        assert_eq!(
            remote_workspace_connection_service::get(&db.conn, original.id)
                .await
                .unwrap()
                .unwrap()
                .config_revision,
            updated.config_revision
        );
        let current = remote_http_call_core(
            &db.conn,
            &bindings,
            &client,
            original.id,
            "echo",
            None,
            None,
            Some(&updated.config_revision),
        )
        .await
        .unwrap();
        assert_eq!(current, legacy);
        task_a.abort();
        task_b.abort();
    }

    #[tokio::test]
    async fn invalidation_cancels_in_flight_http_without_affecting_another_machine() {
        let db = fresh_in_memory_db().await;
        let bindings = Arc::new(RemoteBindingState::default());
        let received = Arc::new(tokio::sync::Notify::new());
        let notified = received.clone();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new().route(
                    "/api/slow",
                    post(move || {
                        let notified = notified.clone();
                        async move {
                            notified.notify_one();
                            std::future::pending::<Json<Value>>().await
                        }
                    }),
                ),
            )
            .await
            .unwrap();
        });
        let a = remote_workspace_connection_service::create(&db.conn, "A", &url, "token", &[])
            .await
            .unwrap();
        let (url_b, task_b) = echo_server().await;
        let b = remote_workspace_connection_service::create(&db.conn, "B", &url_b, "b-token", &[])
            .await
            .unwrap();
        let b_binding = bindings.bind(&db.conn, b.id, None).await.unwrap();
        let request_db = db.conn.clone();
        let request_bindings = bindings.clone();
        let request = tokio::spawn(async move {
            remote_http_call_core(
                &request_db,
                &request_bindings,
                &test_client(),
                a.id,
                "slow",
                None,
                None,
                None,
            )
            .await
        });
        tokio::time::timeout(Duration::from_secs(5), received.notified())
            .await
            .unwrap();
        let gate = bindings.gate(a.id).await;
        let guard = gate.write().await;
        remote_workspace_connection_service::delete(&db.conn, a.id)
            .await
            .unwrap();
        bindings.invalidate_locked(a.id).await;
        // A's configuration lock cannot stall B's requests.
        tokio::time::timeout(Duration::from_secs(1), bindings.bind(&db.conn, b.id, None))
            .await
            .unwrap()
            .unwrap();
        drop(guard);
        let error = tokio::time::timeout(Duration::from_secs(5), request)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err();
        assert_code(error.code, AppErrorCode::ConfigurationInvalid);
        assert!(!b_binding.invalidated.is_cancelled());
        let result = remote_http_call_core(
            &db.conn,
            &bindings,
            &test_client(),
            b.id,
            "echo",
            None,
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(result["authorization"], "Bearer b-token");
        assert_code(
            bindings
                .bind(&db.conn, a.id, None)
                .await
                .err()
                .unwrap()
                .code,
            AppErrorCode::NotFound,
        );
        task.abort();
        task_b.abort();
    }

    #[tokio::test]
    async fn http_and_ws_distinguish_explicit_401_from_offline_or_503() {
        let db = fresh_in_memory_db().await;
        let bindings = RemoteBindingState::default();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new()
                    .route(
                        "/api/unauthorized",
                        post(|| async { http::StatusCode::UNAUTHORIZED }),
                    )
                    .route(
                        "/api/unavailable",
                        post(|| async { http::StatusCode::SERVICE_UNAVAILABLE }),
                    )
                    .route(
                        "/unauthorized",
                        axum::routing::get(|| async { http::StatusCode::UNAUTHORIZED }),
                    )
                    .route(
                        "/unavailable",
                        axum::routing::get(|| async { http::StatusCode::SERVICE_UNAVAILABLE }),
                    ),
            )
            .await
            .unwrap();
        });
        let conn = remote_workspace_connection_service::create(
            &db.conn,
            "A",
            &format!("http://{address}"),
            "token",
            &[],
        )
        .await
        .unwrap();
        let client = test_client();
        for (command, code) in [
            ("unauthorized", AppErrorCode::AuthenticationFailed),
            ("unavailable", AppErrorCode::NetworkError),
        ] {
            assert_code(
                remote_http_call_core(
                    &db.conn, &bindings, &client, conn.id, command, None, None, None,
                )
                .await
                .unwrap_err()
                .code,
                code,
            );
            let error = tokio_tungstenite::connect_async(format!("ws://{address}/{command}"))
                .await
                .unwrap_err();
            assert_eq!(
                ws_connect_is_unauthorized(&error),
                command == "unauthorized"
            );
        }
        task.abort();
        let _ = task.await;
        for _ in 0..4 {
            let error = tokio_tungstenite::connect_async(format!("ws://{address}/unauthorized"))
                .await
                .unwrap_err();
            assert!(!ws_connect_is_unauthorized(&error));
        }
        assert_code(
            remote_http_call_core(
                &db.conn,
                &bindings,
                &client,
                conn.id,
                "unauthorized",
                None,
                Some(1000),
                None,
            )
            .await
            .unwrap_err()
            .code,
            AppErrorCode::NetworkError,
        );
    }
}
