//! File-scoped video capabilities. Players cannot attach Bearer headers and
//! issue multiple Range requests (including Safari's initial bytes=0-1 probe),
//! so download's single-use tickets are not suitable here.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::{Duration, Instant};

use axum::extract::{Path as AxumPath, Request};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use tokio::sync::Mutex;
use tower_http::services::ServeFile;

use crate::app_error::AppCommandError;
#[cfg(any(feature = "tauri-runtime", test))]
use crate::commands::remote_binding::RemoteBindingState;
#[cfg(any(feature = "tauri-runtime", test))]
use crate::models::ToHeaderMap;
#[cfg(any(feature = "tauri-runtime", test))]
use futures_util::StreamExt;

const SESSION_TTL: Duration = Duration::from_secs(24 * 60 * 60);
const MAX_SESSIONS: usize = 256;
static SESSIONS: LazyLock<Mutex<HashMap<String, Session>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Clone)]
enum Source {
    File(PathBuf),
    #[cfg(any(feature = "tauri-runtime", test))]
    Remote {
        url: String,
        client: reqwest::Client,
        invalidated: tokio_util::sync::CancellationToken,
    },
}

struct Session {
    source: Source,
    expires_at: Instant,
}

impl Session {
    fn is_current(&self) -> bool {
        if self.expires_at <= Instant::now() {
            return false;
        }
        match &self.source {
            Source::File(_) => true,
            #[cfg(any(feature = "tauri-runtime", test))]
            Source::Remote { invalidated, .. } => !invalidated.is_cancelled(),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct VideoPreviewSession {
    pub token: String,
    pub url: String,
}

fn video_mime(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "mp4" | "m4v" => Some("video/mp4"),
        "mov" => Some("video/quicktime"),
        "webm" => Some("video/webm"),
        "ogv" | "ogg" => Some("video/ogg"),
        "mkv" => Some("video/x-matroska"),
        "avi" => Some("video/x-msvideo"),
        "mpeg" | "mpg" => Some("video/mpeg"),
        "3gp" => Some("video/3gpp"),
        "3g2" => Some("video/3gpp2"),
        _ => None,
    }
}

async fn issue(source: Source) -> Result<VideoPreviewSession, AppCommandError> {
    let mut sessions = SESSIONS.lock().await;
    sessions.retain(|_, session| session.is_current());
    if sessions.len() >= MAX_SESSIONS {
        return Err(AppCommandError::invalid_input(
            "Too many open video previews",
        ));
    }
    let token = uuid::Uuid::new_v4().simple().to_string();
    sessions.insert(
        token.clone(),
        Session {
            source,
            expires_at: Instant::now() + SESSION_TTL,
        },
    );
    Ok(VideoPreviewSession {
        url: format!("/api/video-preview/{token}"),
        token,
    })
}

pub async fn start_video_preview_core(
    root_path: String,
    path: String,
) -> Result<VideoPreviewSession, AppCommandError> {
    let root = PathBuf::from(root_path);
    if !root.is_absolute() {
        return Err(AppCommandError::invalid_input("Root path must be absolute"));
    }
    let target = crate::commands::folders::resolve_tree_path(&root, &path)?;
    crate::commands::folders::ensure_user_navigable_path(&root, &target)?;
    if video_mime(&target).is_none() {
        return Err(AppCommandError::invalid_input("Not a video file"));
    }
    let metadata = tokio::fs::metadata(&target)
        .await
        .map_err(AppCommandError::io)?;
    if !metadata.is_file() {
        return Err(AppCommandError::invalid_input("Path is not a file"));
    }
    // Preserve the tree's symlink semantics, as for ordinary file previews.
    // Only this authenticated selection can create a capability; the GET
    // endpoint accepts no filesystem path from its caller.
    issue(Source::File(target)).await
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn stop_video_preview(token: String) {
    SESSIONS.lock().await.remove(&token);
}

pub async fn stream_video(AxumPath(token): AxumPath<String>, request: Request) -> Response {
    let source = {
        let mut sessions = SESSIONS.lock().await;
        sessions.retain(|_, session| session.is_current());
        sessions.get(&token).map(|session| session.source.clone())
    };
    let Some(source) = source else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let mut response = match source {
        Source::File(path) => {
            // ServeFile implements GET/HEAD, suffix/open-ended ranges, 206 and
            // 416 with streaming IO, without allocating the whole video.
            let mime = video_mime(&path).expect("validated video extension");
            let mut service = ServeFile::new_with_mime(path, &mime.parse().unwrap());
            match service.try_call(request).await {
                Ok(response) => response.into_response(),
                Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
            }
        }
        #[cfg(any(feature = "tauri-runtime", test))]
        Source::Remote {
            url,
            client,
            invalidated,
        } => {
            let mut upstream = client.request(request.method().clone(), url);
            for name in [header::RANGE, header::IF_RANGE] {
                if let Some(value) = request.headers().get(&name) {
                    upstream = upstream.header(name, value);
                }
            }
            let result = tokio::select! {
                biased;
                _ = invalidated.cancelled() => return StatusCode::NOT_FOUND.into_response(),
                result = upstream.send() => result,
            };
            match result {
                Ok(upstream) => {
                    let status = upstream.status();
                    let headers = upstream.headers().clone();
                    let stream = upstream
                        .bytes_stream()
                        .take_until(invalidated.cancelled_owned());
                    let mut response = Response::new(axum::body::Body::from_stream(stream));
                    *response.status_mut() = status;
                    for name in [
                        header::CONTENT_TYPE,
                        header::CONTENT_LENGTH,
                        header::CONTENT_RANGE,
                        header::ACCEPT_RANGES,
                        header::ETAG,
                        header::LAST_MODIFIED,
                    ] {
                        if let Some(value) = headers.get(&name) {
                            response.headers_mut().insert(name, value.clone());
                        }
                    }
                    response
                }
                Err(_) => StatusCode::BAD_GATEWAY.into_response(),
            }
        }
    };
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    response
}

#[cfg(feature = "tauri-runtime")]
async fn local_url(
    mut session: VideoPreviewSession,
) -> Result<VideoPreviewSession, AppCommandError> {
    static PORT: tokio::sync::OnceCell<u16> = tokio::sync::OnceCell::const_new();
    let port = PORT
        .get_or_try_init(|| async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
            let port = listener.local_addr()?.port();
            let router = axum::Router::new().route(
                "/api/video-preview/{token}",
                axum::routing::get(stream_video),
            );
            tokio::spawn(async move {
                if let Err(error) = axum::serve(listener, router).await {
                    tracing::warn!(%error, "Video preview listener stopped");
                }
            });
            Ok::<_, std::io::Error>(port)
        })
        .await;
    match port {
        Ok(port) => {
            session.url = format!("http://127.0.0.1:{port}{}", session.url);
            Ok(session)
        }
        Err(error) => {
            stop_video_preview(session.token).await;
            Err(AppCommandError::io(error))
        }
    }
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn start_video_preview(
    root_path: String,
    path: String,
) -> Result<VideoPreviewSession, AppCommandError> {
    local_url(start_video_preview_core(root_path, path).await?).await
}

/// Remote desktop also uses loopback so HTTP servers are playable from the
/// secure webview. The destination is derived from the saved connection; no
/// arbitrary URL or master token is exposed to the player.
#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn relay_video_preview(
    db: tauri::State<'_, crate::db::AppDatabase>,
    proxy: tauri::State<'_, std::sync::Arc<crate::commands::remote_proxy::RemoteProxyState>>,
    connection_id: i32,
    token: String,
    config_revision: Option<String>,
) -> Result<VideoPreviewSession, AppCommandError> {
    local_url(
        relay_video_preview_core(
            &db.conn,
            &proxy.bindings,
            connection_id,
            token,
            config_revision.as_deref(),
        )
        .await?,
    )
    .await
}

#[cfg(any(feature = "tauri-runtime", test))]
pub async fn relay_video_preview_core(
    db: &sea_orm::DatabaseConnection,
    bindings: &RemoteBindingState,
    connection_id: i32,
    token: String,
    config_revision: Option<&str>,
) -> Result<VideoPreviewSession, AppCommandError> {
    if token.len() != 32 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(AppCommandError::invalid_input("Invalid video capability"));
    }
    let binding = bindings.bind(db, connection_id, config_revision).await?;
    let connection = &binding.connection;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .default_headers(connection.headers.to_header_map())
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| AppCommandError::network(error.to_string()))?;
    let source = Source::Remote {
        url: format!(
            "{}/api/video-preview/{token}",
            connection.base_url.trim_end_matches('/')
        ),
        client,
        invalidated: binding.invalidated.clone(),
    };
    binding
        .with_current(bindings, issue(source))
        .await
        .ok_or_else(crate::commands::remote_binding::configuration_changed)?
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::{to_bytes, Body};
    use axum::http::Method;

    async fn request(token: &str, method: Method, range: Option<&str>) -> Response {
        let mut builder = Request::builder().method(method).uri("/");
        if let Some(range) = range {
            builder = builder.header(header::RANGE, range);
        }
        stream_video(
            AxumPath(token.to_string()),
            builder.body(Body::empty()).unwrap(),
        )
        .await
    }

    async fn fixture() -> (tempfile::TempDir, VideoPreviewSession) {
        let dir = tempfile::tempdir().unwrap();
        tokio::fs::write(dir.path().join("视频 #1.MP4"), b"0123456789")
            .await
            .unwrap();
        let session = start_video_preview_core(
            dir.path().to_string_lossy().into_owned(),
            "视频 #1.MP4".into(),
        )
        .await
        .unwrap();
        (dir, session)
    }

    #[tokio::test]
    async fn safari_probe_seeking_and_head_reuse_one_capability() {
        let (_dir, session) = fixture().await;
        let response = request(&session.token, Method::HEAD, None).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CONTENT_TYPE], "video/mp4");
        assert_eq!(response.headers()[header::CONTENT_LENGTH], "10");
        assert_eq!(response.headers()[header::ACCEPT_RANGES], "bytes");
        assert!(to_bytes(response.into_body(), 100)
            .await
            .unwrap()
            .is_empty());

        for (range, content_range, bytes) in [
            ("bytes=0-1", "bytes 0-1/10", "01"),
            ("bytes=6-", "bytes 6-9/10", "6789"),
            ("bytes=-3", "bytes 7-9/10", "789"),
        ] {
            let response = request(&session.token, Method::GET, Some(range)).await;
            assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
            assert_eq!(response.headers()[header::CONTENT_RANGE], content_range);
            assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
            assert_eq!(to_bytes(response.into_body(), 100).await.unwrap(), bytes);
        }
        let response = request(&session.token, Method::GET, Some("bytes=20-30")).await;
        assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(response.headers()[header::CONTENT_RANGE], "bytes */10");
        let response = request(&session.token, Method::GET, None).await;
        assert_eq!(
            to_bytes(response.into_body(), 100).await.unwrap(),
            "0123456789"
        );
        stop_video_preview(session.token.clone()).await;
        assert_eq!(
            request(&session.token, Method::GET, None).await.status(),
            StatusCode::NOT_FOUND
        );
    }

    #[tokio::test]
    async fn rejects_invalid_paths_unknown_and_expired_capabilities() {
        let (dir, session) = fixture().await;
        let root = dir.path().to_string_lossy().into_owned();
        for path in [
            "../escape.mp4",
            "/etc/example.mp4",
            "notes.txt",
            "missing.mp4",
        ] {
            assert!(start_video_preview_core(root.clone(), path.into())
                .await
                .is_err());
        }
        assert!(
            start_video_preview_core("relative".into(), "demo.mp4".into())
                .await
                .is_err()
        );
        tokio::fs::create_dir(dir.path().join("folder.mp4"))
            .await
            .unwrap();
        assert!(start_video_preview_core(root, "folder.mp4".into())
            .await
            .is_err());
        assert_eq!(
            request("unknown", Method::GET, None).await.status(),
            StatusCode::NOT_FOUND
        );
        SESSIONS
            .lock()
            .await
            .get_mut(&session.token)
            .unwrap()
            .expires_at = Instant::now();
        assert_eq!(
            request(&session.token, Method::GET, None).await.status(),
            StatusCode::NOT_FOUND
        );
    }

    #[tokio::test]
    async fn relay_fixed_revision_rename_rotation_delete_and_stream_invalidation_preserve_b() {
        use crate::db::service::remote_workspace_connection_service as connections;
        use crate::db::test_helpers::fresh_in_memory_db;
        use crate::models::RemoteWorkspaceHeader;
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        };

        async fn upstream(
            marker: &'static str,
        ) -> (String, Arc<AtomicUsize>, tokio::task::JoinHandle<()>) {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap());
            let calls = Arc::new(AtomicUsize::new(0));
            let called = calls.clone();
            let server = tokio::spawn(async move {
                axum::serve(
                    listener,
                    axum::Router::new().route(
                        "/api/video-preview/{token}",
                        axum::routing::get(move || {
                            called.fetch_add(1, Ordering::SeqCst);
                            async move {
                                let stream = futures_util::stream::once(async move {
                                    Ok::<_, std::io::Error>(marker.to_string())
                                })
                                .chain(futures_util::stream::pending());
                                Response::new(Body::from_stream(stream))
                            }
                        }),
                    ),
                )
                .await
                .unwrap();
            });
            (url, calls, server)
        }

        let db = fresh_in_memory_db().await;
        let bindings = RemoteBindingState::default();
        let (url_a, _, server_a) = upstream("A").await;
        let (url_b, _, server_b) = upstream("B").await;
        let (url_new, calls_new, server_new) = upstream("new A").await;
        let mut a = connections::create(&db.conn, "A", &url_a, "token", &[])
            .await
            .unwrap();
        let b = connections::create(&db.conn, "B", &url_b, "b-token", &[])
            .await
            .unwrap();
        let capability = "a".repeat(32);
        let b_relay = relay_video_preview_core(
            &db.conn,
            &bindings,
            b.id,
            capability.clone(),
            Some(&b.config_revision),
        )
        .await
        .unwrap();
        let original_revision = a.config_revision.clone();
        let relay = relay_video_preview_core(
            &db.conn,
            &bindings,
            a.id,
            capability.clone(),
            Some(&original_revision),
        )
        .await
        .unwrap();
        let renamed = connections::update(&db.conn, a.id, "Renamed A", &url_a, "token", &[])
            .await
            .unwrap();
        assert_eq!(renamed.config_revision, original_revision);
        assert_eq!(
            request(&relay.token, Method::GET, None).await.status(),
            StatusCode::OK
        );
        a = renamed;
        for (url, token, headers) in [
            (url_new.as_str(), "token", vec![]),
            (url_new.as_str(), "changed-token", vec![]),
            (
                url_new.as_str(),
                "changed-token",
                vec![RemoteWorkspaceHeader {
                    name: "X-Test".into(),
                    value: "changed".into(),
                }],
            ),
        ] {
            let relay = relay_video_preview_core(
                &db.conn,
                &bindings,
                a.id,
                capability.clone(),
                Some(&a.config_revision),
            )
            .await
            .unwrap();
            let response = request(&relay.token, Method::GET, None).await;
            assert_eq!(response.status(), StatusCode::OK);
            let mut body = response.into_body().into_data_stream();
            assert!(body.next().await.unwrap().is_ok());
            let gate = bindings.gate(a.id).await;
            let guard = gate.write().await;
            let updated = connections::update(&db.conn, a.id, "Renamed A", url, token, &headers)
                .await
                .unwrap();
            bindings.invalidate_locked(a.id).await;
            drop(guard);
            assert!(tokio::time::timeout(Duration::from_secs(1), body.next())
                .await
                .unwrap()
                .is_none());
            assert_eq!(
                request(&relay.token, Method::GET, None).await.status(),
                StatusCode::NOT_FOUND
            );
            let before = calls_new.load(Ordering::SeqCst);
            let error = relay_video_preview_core(
                &db.conn,
                &bindings,
                a.id,
                capability.clone(),
                Some(&a.config_revision),
            )
            .await
            .unwrap_err();
            assert!(matches!(
                error.code,
                crate::app_error::AppErrorCode::ConfigurationInvalid
            ));
            assert_eq!(
                calls_new.load(Ordering::SeqCst),
                before,
                "old capability never reaches the newly saved endpoint"
            );
            assert_eq!(
                request(&b_relay.token, Method::HEAD, None).await.status(),
                StatusCode::OK
            );
            a = updated;
        }
        let relay = relay_video_preview_core(
            &db.conn,
            &bindings,
            a.id,
            capability,
            Some(&a.config_revision),
        )
        .await
        .unwrap();
        let response = request(&relay.token, Method::GET, None).await;
        let mut body = response.into_body().into_data_stream();
        assert!(body.next().await.unwrap().is_ok());
        let gate = bindings.gate(a.id).await;
        let guard = gate.write().await;
        connections::delete(&db.conn, a.id).await.unwrap();
        bindings.invalidate_locked(a.id).await;
        drop(guard);
        assert!(tokio::time::timeout(Duration::from_secs(1), body.next())
            .await
            .unwrap()
            .is_none());
        assert_eq!(
            request(&relay.token, Method::GET, None).await.status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            request(&b_relay.token, Method::HEAD, None).await.status(),
            StatusCode::OK
        );
        assert_eq!(
            request(&relay.token, Method::GET, None).await.status(),
            StatusCode::NOT_FOUND
        );
        stop_video_preview(relay.token).await;
        stop_video_preview(b_relay.token).await;
        server_a.abort();
        server_b.abort();
        server_new.abort();
    }

    #[tokio::test]
    async fn remote_relay_streams_ranges_and_head_without_a_full_download() {
        let (_dir, remote) = fixture().await;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                axum::Router::new().route(
                    "/api/video-preview/{token}",
                    axum::routing::get(stream_video),
                ),
            )
            .await
            .unwrap();
        });
        let relay = issue(Source::Remote {
            url: format!("http://{addr}{}", remote.url),
            client: reqwest::Client::builder().no_proxy().build().unwrap(),
            invalidated: tokio_util::sync::CancellationToken::new(),
        })
        .await
        .unwrap();
        let response = request(&relay.token, Method::GET, Some("bytes=0-1")).await;
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.headers()[header::CONTENT_RANGE], "bytes 0-1/10");
        assert_eq!(response.headers()[header::CONTENT_LENGTH], "2");
        assert_eq!(response.headers()[header::CONTENT_TYPE], "video/mp4");
        assert_eq!(to_bytes(response.into_body(), 100).await.unwrap(), "01");
        let response = request(&relay.token, Method::HEAD, None).await;
        assert_eq!(response.headers()[header::CONTENT_LENGTH], "10");
        assert!(to_bytes(response.into_body(), 100)
            .await
            .unwrap()
            .is_empty());
        let response = request(&relay.token, Method::GET, Some("bytes=99-")).await;
        assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(response.headers()[header::CONTENT_RANGE], "bytes */10");
        stop_video_preview(remote.token).await;
        assert_eq!(
            request(&relay.token, Method::GET, None).await.status(),
            StatusCode::NOT_FOUND
        );
        stop_video_preview(relay.token).await;
        server.abort();
    }
}
