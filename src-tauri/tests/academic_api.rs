//! Academic server integration: real auth/router, SQLite, and event broadcaster.
#![cfg(all(feature = "test-utils", not(feature = "tauri-runtime")))]

use std::sync::Arc;

use axum_test::TestServer;
use codeg_lib::academic::{self, store, types::AcademicPaper};
use codeg_lib::app_state::AppState;
use codeg_lib::db::{test_helpers::fresh_in_memory_db, AppDatabase};
use codeg_lib::web::{router::build_router, shutdown::ShutdownSignal};
use sea_orm::{ConnectionTrait, DbBackend, Statement};
use serde_json::{json, Value};

const AUTH: &str = "Bearer academic-api-test";
const ROUTES: &[&str] = &[
    "academic_settings_get",
    "academic_settings_set",
    "academic_library",
    "academic_select",
    "academic_paper_get",
    "academic_import",
    "academic_prepare",
    "academic_cancel",
    "academic_open_target",
    "academic_bind_conversation",
    "academic_conversation_paper",
];

async fn server() -> (TestServer, Arc<AppState>, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let state = Arc::new(AppState::new_for_test(
        fresh_in_memory_db().await,
        dir.path().into(),
    ));
    let router = build_router(
        state.clone(),
        "academic-api-test".into(),
        dir.path().into(),
        Arc::new(ShutdownSignal::new()),
    );
    (TestServer::new(router).unwrap(), state, dir)
}

#[tokio::test]
async fn every_academic_route_requires_the_codeg_server_token() {
    let (server, _, _dir) = server().await;
    for route in ROUTES {
        for header in [None, Some("Bearer incorrect")] {
            let mut request = server.post(&format!("/api/{route}")).json(&json!({}));
            if let Some(header) = header {
                request = request.add_header("authorization", header);
            }
            assert_eq!(request.await.status_code(), 401, "{route}");
        }
    }
}

#[tokio::test]
async fn academic_mutation_routes_validate_json_before_dispatch() {
    let (server, _, _dir) = server().await;
    for route in ROUTES
        .iter()
        .filter(|route| !matches!(**route, "academic_settings_get" | "academic_library"))
    {
        let response = server
            .post(&format!("/api/{route}"))
            .add_header("authorization", AUTH)
            .json(&json!({}))
            .await;
        assert_eq!(response.status_code(), 422, "{route}");
    }
}

async fn rows(state: &AppState, table: &str) -> i64 {
    state
        .db
        .conn
        .query_one(Statement::from_string(
            DbBackend::Sqlite,
            format!("SELECT COUNT(*) AS n FROM {table}"),
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get("", "n")
        .unwrap()
}

#[tokio::test]
async fn academic_server_runtime_supports_settings_association_recovery_and_events() {
    let (server, state, dir) = server().await;
    // This integration binary is isolated from unit tests and only this test
    // accesses the file-based credential store. Never read or modify real tokens.
    std::env::set_var("CODEG_DATA_DIR", dir.path());
    let folder =
        codeg_lib::db::test_helpers::seed_folder(&state.db, dir.path().to_str().unwrap()).await;
    let paper: AcademicPaper = serde_json::from_value(json!({
        "id": "paper-api", "item_key": "ABCDEFGH", "instance_id": "test-zotero",
        "library_id": 1, "title": "Paper over remote workspace", "authors": [],
        "abstract_text": "Reference data", "folder_id": folder,
        "status": "analyzing", "candidates": []
    }))
    .unwrap();
    store::save(&state.db.conn, &paper).await.unwrap();
    academic::initialize(
        AppDatabase {
            conn: state.db.conn.clone(),
        },
        state.connection_manager.clone_ref(),
        state.emitter.clone(),
        state.data_dir.clone(),
    )
    .await
    .unwrap();
    assert!(dir.path().join("research").is_dir());
    assert_eq!(
        store::get(&state.db.conn, &paper.id).await.unwrap().status,
        "interrupted"
    );
    let response = server
        .post("/api/academic_settings_get")
        .add_header("authorization", AUTH)
        .json(&json!({}))
        .await;
    assert_eq!(response.status_code(), 200);
    assert_eq!(
        response.json::<Value>(),
        json!({"agent_type":"codex", "bridge_port":23119, "paired":false, "mcp_enabled":false})
    );

    // Invalid input reaches the shared validator and never persists the token.
    let response = server
        .post("/api/academic_settings_set")
        .add_header("authorization", AUTH)
        .json(&json!({"agentType":"codex", "bridgePort":0, "token":"do-not-store"}))
        .await;
    assert_eq!(response.status_code(), 400);
    assert!(!response.text().contains("do-not-store"));
    assert!(!dir.path().join("tokens.json").exists());
    let response = server
        .post("/api/academic_settings_set")
        .add_header("authorization", AUTH)
        .json(&json!({"agentType":"codex", "bridgePort":23119}))
        .await;
    assert_eq!(response.status_code(), 200);
    assert!(response.json::<Value>().get("token").is_none());

    let response = server
        .post("/api/academic_library")
        .add_header("authorization", AUTH)
        .json(&json!({}))
        .await;
    assert_eq!(response.status_code(), 400);
    assert!(response.text().contains("Pair Zotero"));
    let response = server
        .post("/api/academic_import")
        .add_header("authorization", AUTH)
        .json(&json!({"identifier":"invalid", "collectionKey":"ABCDEFGH"}))
        .await;
    assert_eq!(response.status_code(), 400);
    assert!(response.text().contains("arXiv"));

    let response = server
        .post("/api/academic_select")
        .add_header("authorization", AUTH)
        .json(&json!({
            "itemKey":"ABCDEFGH",
            "agentPreferences":{"agent_type":"codex", "mode_id":null, "config_values":{}}
        }))
        .await;
    assert_eq!(response.status_code(), 400);
    assert!(response.text().contains("Pair Zotero"));
    // Preserve the nested preferences contract and reject a stale snapshot
    // before queuing any agent work on the server.
    let response = server
        .post("/api/academic_prepare")
        .add_header("authorization", AUTH)
        .json(&json!({
            "paperId":paper.id,
            "agentPreferences":{"agent_type":"gemini", "mode_id":"research", "config_values":{"model":"test-model"}}
        }))
        .await;
    assert_eq!(response.status_code(), 400);
    assert!(response
        .text()
        .contains("configured research agent changed"));
    assert_eq!(
        store::get(&state.db.conn, &paper.id).await.unwrap().status,
        "interrupted"
    );

    let response = server
        .post("/api/academic_paper_get")
        .add_header("authorization", AUTH)
        .json(&json!({"paperId":paper.id}))
        .await;
    assert_eq!(response.status_code(), 200);
    assert_eq!(response.json::<Value>()["status"], "interrupted");
    let response = server
        .post("/api/academic_open_target")
        .add_header("authorization", AUTH)
        .json(&json!({"paperId":paper.id, "withoutCode":true}))
        .await;
    assert_eq!(response.status_code(), 200);
    assert_eq!(response.json::<Value>()["paper_id"], paper.id);

    let response = server.post("/api/create_conversation").add_header("authorization", AUTH)
        .json(&json!({"folderId":folder, "agentType":"codex", "title":"Paper research", "academicPaperId":paper.id})).await;
    assert_eq!(response.status_code(), 200);
    let conversation: i32 = response.json();
    assert_eq!(
        store::conversation_paper(&state.db.conn, conversation)
            .await
            .unwrap()
            .unwrap()
            .id,
        paper.id
    );
    let response = server
        .post("/api/create_chat_conversation")
        .add_header("authorization", AUTH)
        .json(&json!({"agentType":"codex", "academicPaperId":paper.id}))
        .await;
    assert_eq!(response.status_code(), 200);
    let chat = response.json::<Value>()["conversationId"].as_i64().unwrap() as i32;
    assert_eq!(
        store::conversation_paper(&state.db.conn, chat)
            .await
            .unwrap()
            .unwrap()
            .id,
        paper.id
    );
    let response = server
        .post("/api/academic_conversation_paper")
        .add_header("authorization", AUTH)
        .json(&json!({"conversationId":chat}))
        .await;
    assert_eq!(response.status_code(), 200);
    assert_eq!(response.json::<Value>()["id"], paper.id);

    // Failed binding must roll back both kinds of conversations, including chat folders.
    let folders_before = rows(&state, "folder").await;
    let conversations_before = rows(&state, "conversation").await;
    for route in ["create_conversation", "create_chat_conversation"] {
        let response = server
            .post(&format!("/api/{route}"))
            .add_header("authorization", AUTH)
            .json(
                &json!({"folderId":folder, "agentType":"codex", "academicPaperId":"missing-paper"}),
            )
            .await;
        assert_eq!(response.status_code(), 400, "{route}");
    }
    assert_eq!(rows(&state, "folder").await, folders_before);
    assert_eq!(rows(&state, "conversation").await, conversations_before);

    let mut events = state.event_broadcaster.subscribe();
    let response = server
        .post("/api/academic_bind_conversation")
        .add_header("authorization", AUTH)
        .json(&json!({"paperId":paper.id, "conversationId":conversation}))
        .await;
    assert_eq!(response.status_code(), 200);
    assert_eq!(response.json::<Value>(), Value::Null);
    let event = events.try_recv().unwrap();
    assert_eq!(event.channel, "academic://changed");
    assert_eq!(event.payload["paper_id"], paper.id);
    let response = server
        .post("/api/academic_cancel")
        .add_header("authorization", AUTH)
        .json(&json!({"paperId":paper.id}))
        .await;
    assert_eq!(response.status_code(), 200);
    let event = events.try_recv().unwrap();
    assert_eq!(event.channel, "academic://changed");

    // Pairing is stored on the backend, not returned to remote clients. Use a
    // synthetic token after all bridge operations so this test stays offline.
    let pairing_token = "academic-test-only-pairing-token";
    let response = server
        .post("/api/academic_settings_set")
        .add_header("authorization", AUTH)
        .json(&json!({"agentType":"codex", "bridgePort":23119, "token":pairing_token}))
        .await;
    assert_eq!(response.status_code(), 200);
    assert_eq!(response.json::<Value>()["paired"], true);
    assert!(!response.text().contains(pairing_token));
    let credentials = dir.path().join("tokens.json");
    let saved: Value = serde_json::from_slice(&std::fs::read(&credentials).unwrap()).unwrap();
    assert_eq!(saved["secret:academic-zotero-bridge"], pairing_token);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(credentials).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    let response = server
        .post("/api/academic_settings_get")
        .add_header("authorization", AUTH)
        .json(&json!({}))
        .await;
    assert_eq!(response.status_code(), 200);
    assert_eq!(response.json::<Value>()["paired"], true);
    assert!(!response.text().contains(pairing_token));
    // Fake plugin on a random loopback port; never accesses real Zotero.
    use academic::mcp::{execute, parse_tool};
    use axum::{routing::post, Json, Router};
    let item = json!({"key":"PAPER001","title":"Imported paper","doi":"10.1234/test","collections":["COLLECT1"],"version":1});
    let library = json!({"library_id":1,"instance_id":"mock-zotero","collections":[{"key":"COLLECT1","name":"Research","parent_key":null}],"items":[item.clone()]});
    let plugin = Router::new()
        .route(
            "/codeg/v1/health",
            post(|| async { Json(json!({"version":1,"instance_id":"mock-zotero"})) }),
        )
        .route(
            "/codeg/v1/library",
            post(move || {
                let library = library.clone();
                async move { Json(library) }
            }),
        )
        .route(
            "/codeg/v1/import",
            post(
                move |headers: axum::http::HeaderMap, Json(body): Json<Value>| {
                    let item = item.clone();
                    async move {
                        assert_eq!(
                            headers["authorization"],
                            "Bearer academic-test-only-pairing-token"
                        );
                        assert_eq!(
                            body,
                            json!({"identifier":"10.1234/test","collection_key":"COLLECT1"})
                        );
                        Json(item)
                    }
                },
            ),
        );
    let tcp = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = tcp.local_addr().unwrap().port();
    let plugin_task = tokio::spawn(async move {
        axum::serve(tcp, plugin).await.unwrap();
    });
    let runtime = academic::runtime().unwrap();
    let import = || {
        parse_tool(
            "zotero_import_paper",
            json!({"identifier":"10.1234/test","collection_key":"COLLECT1"}),
        )
        .unwrap()
    };
    assert!(!academic::mcp::enabled().await);
    assert_eq!(execute(import()).await["ok"], false);
    let response = server
        .post("/api/academic_settings_set")
        .add_header("authorization", AUTH)
        .json(&json!({"agentType":"codex","bridgePort":port,"mcpEnabled":true}))
        .await;
    assert_eq!(response.status_code(), 200);
    assert_eq!(response.json::<Value>()["mcp_enabled"], true);
    assert!(academic::mcp::enabled().await);
    runtime
        .set_settings("codex".into(), port, None, None)
        .await
        .unwrap();
    assert!(runtime.settings().await.unwrap().mcp_enabled);
    let listed = execute(parse_tool("zotero_list_collections", json!({})).unwrap()).await;
    assert_eq!(listed["collections"][0]["key"], "COLLECT1");
    let imported = execute(import()).await;
    assert_eq!(imported["ok"], true, "{imported}");
    assert_eq!(imported["item"]["key"], "PAPER001");
    assert!(!imported.to_string().contains(pairing_token));
    assert_eq!(events.try_recv().unwrap().channel, "academic://changed");
    let found =
        execute(parse_tool("zotero_search_items", json!({"query":"10.1234/test"})).unwrap()).await;
    assert_eq!(found["total"], 1);
    runtime
        .set_settings("codex".into(), port, None, Some(false))
        .await
        .unwrap();
    assert!(!academic::mcp::enabled().await);
    assert_eq!(execute(import()).await["ok"], false);
    plugin_task.abort();
}
