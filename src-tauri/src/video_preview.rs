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
#[cfg(feature = "tauri-runtime")]
use crate::models::ToHeaderMap;

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
    },
}

struct Session {
    source: Source,
    expires_at: Instant,
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
    sessions.retain(|_, session| session.expires_at > Instant::now());
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
        sessions.retain(|_, session| session.expires_at > Instant::now());
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
        Source::Remote { url, client } => {
            let mut upstream = client.request(request.method().clone(), url);
            for name in [header::RANGE, header::IF_RANGE] {
                if let Some(value) = request.headers().get(&name) {
                    upstream = upstream.header(name, value);
                }
            }
            match upstream.send().await {
                Ok(upstream) => {
                    let status = upstream.status();
                    let headers = upstream.headers().clone();
                    let mut response =
                        Response::new(axum::body::Body::from_stream(upstream.bytes_stream()));
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
    connection_id: i32,
    token: String,
) -> Result<VideoPreviewSession, AppCommandError> {
    if token.len() != 32 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(AppCommandError::invalid_input("Invalid video capability"));
    }
    let connection =
        crate::db::service::remote_workspace_connection_service::get(&db.conn, connection_id)
            .await
            .map_err(AppCommandError::db)?
            .ok_or_else(|| AppCommandError::not_found("Remote connection not found"))?;
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
    };
    local_url(issue(source).await?).await
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
