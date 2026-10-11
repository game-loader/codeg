#![cfg(all(feature = "test-utils", unix))]

use std::sync::Arc;

use axum::http::{header, StatusCode};
use axum_test::TestServer;
use codeg_lib::app_state::AppState;
use codeg_lib::commands::folders::{open_folder_core, open_worktree_folder_core};
use codeg_lib::db::test_helpers::fresh_in_memory_db;
use codeg_lib::models::GitWorktreeInfo;
use codeg_lib::web::{router::build_router, shutdown::ShutdownSignal};
use serde_json::json;

fn git(path: &std::path::Path, args: &[&str]) {
    let output = std::process::Command::new("git")
        .args(args)
        .current_dir(path)
        .env("GIT_AUTHOR_NAME", "Test")
        .env("GIT_AUTHOR_EMAIL", "test@example.invalid")
        .env("GIT_COMMITTER_NAME", "Test")
        .env("GIT_COMMITTER_EMAIL", "test@example.invalid")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[tokio::test]
async fn routes_list_detached_and_remove_by_path_with_auth_and_folder_cleanup() {
    let repo = tempfile::tempdir().unwrap();
    let worktrees = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    let static_dir = tempfile::tempdir().unwrap();
    git(repo.path(), &["init", "-q", "-b", "main"]);
    git(
        repo.path(),
        &["commit", "-q", "--allow-empty", "-m", "base"],
    );
    let detached = worktrees.path().join("detached space\nline ");
    git(
        repo.path(),
        &["worktree", "add", "--detach", detached.to_str().unwrap()],
    );
    let db = fresh_in_memory_db().await;
    let root = open_folder_core(&db, repo.path().to_string_lossy().into_owned())
        .await
        .unwrap();
    let child = open_worktree_folder_core(&db, detached.to_string_lossy().into_owned(), root.id)
        .await
        .unwrap();
    let state = Arc::new(AppState::new_for_test(db, data.path().into()));
    let server = TestServer::new(build_router(
        state,
        "test-token".into(),
        static_dir.path().into(),
        Arc::new(ShutdownSignal::new()),
    ))
    .unwrap();
    let params = json!({"path": repo.path()});
    server
        .post("/api/git_list_worktrees")
        .json(&params)
        .await
        .assert_status(StatusCode::UNAUTHORIZED);
    let listed = server
        .post("/api/git_list_worktrees")
        .add_header(header::AUTHORIZATION, "Bearer test-token")
        .json(&params)
        .await;
    listed.assert_status_ok();
    let listed: Vec<GitWorktreeInfo> = listed.json();
    assert_eq!(listed.len(), 2);
    assert!(listed[0].is_main);
    assert_eq!(listed[0].branch.as_deref(), Some("main"));
    assert!(listed[1].detached);
    assert_eq!(std::path::Path::new(&listed[1].path), detached);
    let removed = server.post("/api/git_remove_worktree_path")
        .add_header(header::AUTHORIZATION, "Bearer test-token")
        .json(&json!({"path": repo.path(), "worktreePath": detached, "sourceFolderId": root.id, "deleteBranch": true})).await;
    removed.assert_status_ok();
    let result: serde_json::Value = removed.json();
    assert_eq!(result["folder_id"], child.id);
    assert_eq!(result["branch_deleted"], false);
    assert!(!detached.exists());
    let missing = server
        .post("/api/get_folder")
        .add_header(header::AUTHORIZATION, "Bearer test-token")
        .json(&json!({"folderId": child.id}))
        .await;
    missing.assert_status(StatusCode::NOT_FOUND);
    assert_eq!(missing.json::<serde_json::Value>()["code"], "not_found");
    server
        .post("/api/get_folder")
        .add_header(header::AUTHORIZATION, "Bearer test-token")
        .json(&json!({"folderId": root.id}))
        .await
        .assert_status_ok();
    let listed = server
        .post("/api/git_list_worktrees")
        .add_header(header::AUTHORIZATION, "Bearer test-token")
        .json(&params)
        .await;
    assert_eq!(listed.json::<Vec<GitWorktreeInfo>>().len(), 1);
}
