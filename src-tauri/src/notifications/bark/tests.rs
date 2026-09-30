use super::*;
use axum::{http::StatusCode, routing::post, Json, Router};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

const DEVICE_A: &str = "ffab49ec-0110-4f12-81fe-e37a8e2da001";
const DEVICE_B: &str = "ffab49ec-0110-4f12-81fe-e37a8e2da002";

pub(crate) async fn mock_bark(
    status: StatusCode,
    code: i32,
) -> (
    BarkSettings,
    mpsc::Receiver<serde_json::Value>,
    JoinHandle<()>,
) {
    let (tx, rx) = mpsc::channel(8);
    let router = Router::new().route(
        "/prefix/push",
        post(move |Json(body): Json<serde_json::Value>| {
            let tx = tx.clone();
            async move {
                tx.send(body).await.unwrap();
                (
                    status,
                    Json(serde_json::json!({"code": code, "message": "mock"})),
                )
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let settings = BarkSettings {
        enabled: true,
        push_url: format!("http://{address}/prefix/secret-key"),
        ..Default::default()
    };
    (settings, rx, server)
}

#[test]
fn validates_device_urls_and_preserves_proxy_prefixes() {
    for (input, expected) in [
        ("https://api.day.app/ABC123/", "https://api.day.app/push"),
        (
            "https://bark.example/prefix/ABC123",
            "https://bark.example/prefix/push",
        ),
        ("http://127.0.0.1:8080/ABC123", "http://127.0.0.1:8080/push"),
    ] {
        let (url, key) = push_endpoint(input).unwrap();
        assert_eq!(url.as_str(), expected);
        assert_eq!(key, "ABC123");
    }
    for input in [
        "https://api.day.app",
        "https://api.day.app/",
        "https://api.day.app/push",
        "https://api.day.app/ABC/body",
        "file:///ABC",
        "ftp://bark.example/ABC",
        "https://name:password@bark.example/ABC",
        "https://bark.example/ABC?key=bad",
        "https://bark.example/ABC#fragment",
        "https://bark.example//ABC",
        "https://bark.example/ABC%2Fdef",
    ] {
        assert!(push_endpoint(input).is_err(), "accepted {input}");
    }
}

#[test]
fn completion_payload_omits_reply_unless_opted_in_and_routes_to_server() {
    let mut settings = BarkSettings::default();
    let payload = completion_payload(
        &settings,
        DEVICE_A,
        42,
        Some("Build app"),
        None,
        "server-a",
        "PRIVATE REPLY",
    );
    assert_eq!(payload["body"], "Task completed");
    assert_eq!(payload["subtitle"], "Build app");
    assert!(!payload.to_string().contains("PRIVATE"));
    assert_eq!(
        payload["url"],
        format!("codeg://conversation/42?server_id={DEVICE_A}")
    );
    settings.include_preview = true;
    settings.language = "zh-Hans".into();
    let payload = completion_payload(
        &settings,
        DEVICE_A,
        42,
        None,
        None,
        "server-a",
        &"中".repeat(1000),
    );
    assert!(payload["body"]
        .as_str()
        .unwrap()
        .starts_with("任务已完成\n"));
    assert_eq!(
        payload["body"].as_str().unwrap().chars().count(),
        6 + PREVIEW_CHARS
    );
    assert!(serde_json::to_vec(&payload).unwrap().len() < 4096);
}

#[tokio::test]
async fn settings_are_persisted_per_device_with_safe_defaults() {
    let db = crate::db::test_helpers::fresh_in_memory_db().await;
    let defaults = load_settings(&db.conn, DEVICE_A).await.unwrap();
    assert!(!defaults.enabled && !defaults.include_preview && defaults.push_url.is_empty());
    let settings = BarkSettings {
        enabled: true,
        push_url: " https://api.day.app/ABC123/ ".into(),
        ..defaults
    };
    let saved = save_settings(&db.conn, &DEVICE_A.to_uppercase(), settings)
        .await
        .unwrap();
    assert_eq!(saved.push_url, "https://api.day.app/ABC123");
    assert!(load_settings(&db.conn, DEVICE_A).await.unwrap().enabled);
    assert!(!load_settings(&db.conn, DEVICE_B).await.unwrap().enabled);
    assert_eq!(enabled_devices(&db.conn).await.unwrap().len(), 1);
    let disabled = BarkSettings {
        enabled: false,
        ..saved
    };
    save_settings(&db.conn, DEVICE_A, disabled).await.unwrap();
    assert!(enabled_devices(&db.conn).await.unwrap().is_empty());
    let devices = list_devices(&db.conn).await.unwrap();
    assert_eq!(devices.len(), 1);
    assert_eq!(devices[0].device_id, DEVICE_A);
    assert!(load_settings(&db.conn, "bad-device").await.is_err());
    assert!(save_settings(
        &db.conn,
        DEVICE_A,
        BarkSettings {
            enabled: true,
            ..Default::default()
        }
    )
    .await
    .is_err());
}

#[test]
fn browser_and_desktop_notifications_open_a_matching_server() {
    let mut settings = BarkSettings::default();
    let id = "00000000-0000-4000-8000-000000000001";
    let payload = completion_payload(&settings, id, 42, None, None, "server-a", "Done");
    assert!(payload.get("url").is_none());
    settings.server_url = "https://codeg.example:3080".into();
    let payload = completion_payload(&settings, id, 42, None, None, "server-a", "Done");
    assert_eq!(
        payload["url"],
        "codeg://conversation/42?server_url=https%3A%2F%2Fcodeg.example%3A3080"
    );
    for endpoint in [
        "file:///tmp",
        "https://user:secret@example.com",
        "https://example.com?token=secret",
    ] {
        settings.server_url = endpoint.into();
        assert!(normalize(settings.clone()).is_err());
    }
}

#[tokio::test]
async fn push_uses_json_key_and_deep_link_and_requires_bark_ack() {
    for (status, code, success) in [
        (StatusCode::OK, 200, true),
        (StatusCode::OK, 400, false),
        (StatusCode::BAD_GATEWAY, 200, false),
        (StatusCode::FOUND, 200, false),
    ] {
        let (settings, mut receiver, server) = mock_bark(status, code).await;
        let payload = completion_payload(&settings, DEVICE_A, 17, None, None, "server-a", "Done");
        let result = send(&client().unwrap(), &settings, payload).await;
        assert_eq!(result.is_ok(), success);
        if let Err(error) = result {
            let serialized = serde_json::to_string(&error).unwrap();
            assert!(!serialized.contains("secret-key"));
        }
        let captured = receiver.recv().await.unwrap();
        assert_eq!(captured["device_key"], "secret-key");
        assert_eq!(
            captured["url"],
            format!("codeg://conversation/17?server_id={DEVICE_A}")
        );
        server.abort();
    }
}

#[tokio::test]
async fn explicit_test_works_with_completion_switch_off() {
    let db = crate::db::test_helpers::fresh_in_memory_db().await;
    let (mut settings, mut receiver, server) = mock_bark(StatusCode::OK, 200).await;
    settings.enabled = false;
    save_settings(&db.conn, DEVICE_A, settings).await.unwrap();
    test_notification(&db.conn, DEVICE_A).await.unwrap();
    let payload = receiver.recv().await.unwrap();
    assert_eq!(
        payload["url"],
        format!("codeg://settings/notifications?server_id={DEVICE_A}")
    );
    assert!(test_notification(&db.conn, DEVICE_B).await.is_err());
    server.abort();
}

#[tokio::test]
async fn source_identity_survives_reload_and_differs_across_servers() {
    let a = crate::db::test_helpers::fresh_in_memory_db().await;
    let b = crate::db::test_helpers::fresh_in_memory_db().await;
    let id = source_id(&a.conn).await.unwrap();
    assert_eq!(source_id(&a.conn).await.unwrap(), id);
    assert_ne!(source_id(&b.conn).await.unwrap(), id);
}

#[test]
fn source_and_workspace_are_visible_and_remote_conversation_ids_do_not_collide() {
    let mut settings = BarkSettings {
        source_name: "Academic server".into(),
        ..Default::default()
    };
    let a = completion_payload(
        &settings,
        DEVICE_A,
        42,
        Some("Review paper"),
        Some("Academic"),
        "server-a",
        "Done",
    );
    let b = completion_payload(
        &settings,
        DEVICE_A,
        42,
        Some("Build app"),
        Some("Machines"),
        "server-b",
        "Done",
    );
    assert_eq!(a["title"], "Codeg · Academic server");
    assert_eq!(a["subtitle"], "Academic · Review paper");
    assert_eq!(b["subtitle"], "Machines · Build app");
    assert_ne!(a["group"], b["group"]);
    assert_eq!(
        a["group"],
        completion_payload(&settings, DEVICE_B, 42, None, None, "server-a", "Done")["group"]
    );
    settings.source_name.clear();
    settings.server_url = "https://academic.example:3080".into();
    assert_eq!(
        completion_payload(&settings, DEVICE_A, 42, None, None, "server-a", "Done")["title"],
        "Codeg · academic.example:3080"
    );
    for label in ["a\nb".to_string(), "中".repeat(81)] {
        settings.source_name = label;
        assert!(normalize(settings.clone()).is_err());
    }
    settings.source_name = "  Academic  ".into();
    assert_eq!(normalize(settings).unwrap().source_name, "Academic");
}
