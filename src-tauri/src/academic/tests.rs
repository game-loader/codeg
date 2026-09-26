use super::sources::*;

#[test]
fn arxiv_identifiers_are_validated_without_losing_versions() {
    assert_eq!(
        arxiv_id("https://arxiv.org/abs/2401.01234v2").as_deref(),
        Some("2401.01234v2")
    );
    assert_eq!(
        arxiv_id("arXiv:hep-th/9901001").as_deref(),
        Some("hep-th/9901001")
    );
    assert!(arxiv_id("https://evil.invalid/abs/2401.01234").is_none());
    assert!(arxiv_id("2401.01234/../../secret").is_none());
}

#[test]
fn cloning_accepts_only_canonical_public_https_repositories() {
    assert_eq!(
        repository_url("https://github.com/owner/repo").unwrap(),
        "https://github.com/owner/repo"
    );
    for bad in [
        "file:///etc",
        "ssh://git@github.com/a/b",
        "https://localhost/a/b",
        "https://github.com.evil.invalid/a/b",
        "https://token@github.com/a/b",
        "https://github.com/a/b?token=x",
        "https://github.com/a/../b",
        "https://github.com/a/b/issues",
        "https://github.com:444/a/b",
    ] {
        assert!(repository_url(bad).is_err(), "accepted {bad}");
    }
}

#[test]
fn code_claim_requires_exact_evidence_and_same_repository() {
    let corpus = "Our code is available at https://github.com/lab/paper .";
    assert!(verify_evidence("https://github.com/lab/paper", corpus, corpus).is_ok());
    assert!(verify_evidence("https://github.com/lab/other", corpus, corpus).is_err());
    assert!(verify_evidence(
        "https://github.com/lab/paper",
        "Official code: https://github.com/lab/paper",
        corpus
    )
    .is_err());
    assert!(verify_evidence(
        "https://github.com/lab/paper",
        "Related work https://github.com/lab/paper",
        "Related work https://github.com/lab/paper"
    )
    .is_err());
}

#[test]
fn title_search_never_selects_without_explicit_identifier() {
    let candidate = |id: &str| super::types::ArxivCandidate {
        id: id.into(),
        title: "A paper about learning".into(),
        authors: vec!["Ada Smith".into()],
        summary: String::new(),
        pdf_url: String::new(),
    };
    assert!(resolve_candidate(None, &[candidate("2401.00001")]).is_none());
    assert!(resolve_candidate(None, &[candidate("2401.00001"), candidate("2401.00002")]).is_none());
    assert_eq!(
        resolve_candidate(Some("2401.00001"), &[candidate("2401.00001v2")]),
        Some("2401.00001v2".into())
    );
}

fn paper_fixture(id: &str) -> super::types::AcademicPaper {
    super::types::AcademicPaper {
        id: id.into(),
        item_key: "ABCDEFGH".into(),
        library_id: 1,
        instance_id: "zotero-a".into(),
        title: "Paper".into(),
        authors: vec!["Ada Smith".into()],
        abstract_text: "An abstract".into(),
        doi: None,
        arxiv_id: None,
        pdf_path: None,
        text_path: None,
        context_path: None,
        repo_url: None,
        repo_path: None,
        folder_id: Some(10),
        status: "ready".into(),
        error: None,
        analysis: None,
        analysis_conversation_id: None,
        candidates: vec![],
        repo_candidates: vec![],
        conversations: vec![],
    }
}

async fn database() -> sea_orm::DatabaseConnection {
    use sea_orm::ConnectionTrait;
    let db = sea_orm::Database::connect("sqlite::memory:").await.unwrap();
    for sql in [
        "CREATE TABLE academic_paper(id TEXT PRIMARY KEY, instance_id TEXT, library_id INTEGER, item_key TEXT, payload TEXT, UNIQUE(instance_id,library_id,item_key))",
        "CREATE TABLE academic_conversation(conversation_id INTEGER PRIMARY KEY, paper_id TEXT)",
        "CREATE TABLE folder(id INTEGER PRIMARY KEY, kind TEXT, deleted_at TEXT)",
        "CREATE TABLE conversation(id INTEGER PRIMARY KEY, folder_id INTEGER, kind TEXT, agent_type TEXT, title TEXT, deleted_at TEXT, created_at TEXT)",
        "INSERT INTO folder(id,kind) VALUES (10,'regular'),(20,'regular'),(30,'chat')",
        "INSERT INTO conversation(id,folder_id,kind,agent_type) VALUES (1,10,'regular','codex'),(2,20,'regular','codex'),(3,30,'chat','codex')",
    ] { db.execute_unprepared(sql).await.unwrap(); }
    db
}

#[tokio::test]
async fn association_is_idempotent_validates_folder_and_cannot_be_reassigned() {
    let db = database().await;
    let first = paper_fixture("paper-a");
    let mut second = paper_fixture("paper-b");
    second.item_key = "IJKLMNOP".into();
    super::store::save(&db, &first).await.unwrap();
    super::store::save(&db, &second).await.unwrap();
    assert!(super::store::bind_conversation(&db, "paper-a", 2)
        .await
        .is_err());
    assert!(super::store::conversation_paper(&db, 2)
        .await
        .unwrap()
        .is_none());
    super::store::bind_conversation(&db, "paper-a", 1)
        .await
        .unwrap();
    super::store::bind_conversation(&db, "paper-a", 1)
        .await
        .unwrap();
    assert!(super::store::bind_conversation(&db, "paper-b", 1)
        .await
        .is_err());
    assert_eq!(
        super::store::conversation_paper(&db, 1)
            .await
            .unwrap()
            .unwrap()
            .id,
        "paper-a"
    );
    super::store::bind_conversation(&db, "paper-a", 3)
        .await
        .unwrap();
}

#[tokio::test]
async fn restart_recovery_preserves_terminal_states_and_associations() {
    let db = database().await;
    let mut active = paper_fixture("active");
    active.status = "cloning".into();
    let mut ready = paper_fixture("ready");
    ready.item_key = "IJKLMNOP".into();
    super::store::save(&db, &active).await.unwrap();
    super::store::save(&db, &ready).await.unwrap();
    super::store::bind_conversation(&db, "active", 1)
        .await
        .unwrap();
    super::store::recover(&db).await.unwrap();
    assert_eq!(
        super::store::get(&db, "active").await.unwrap().status,
        "interrupted"
    );
    assert_eq!(
        super::store::get(&db, "ready").await.unwrap().status,
        "ready"
    );
    assert_eq!(
        super::store::conversation_paper(&db, 1)
            .await
            .unwrap()
            .unwrap()
            .id,
        "active"
    );
}

#[tokio::test]
async fn context_is_bounded_and_only_added_for_associated_conversations() {
    let db = database().await;
    let mut paper = paper_fixture("paper");
    paper.analysis = Some("学".repeat(20000));
    paper.pdf_path = Some("/zotero/storage/paper.pdf".into());
    paper.text_path = Some("/research/paper/paper.txt".into());
    paper.context_path = Some("/research/paper/context.md".into());
    super::store::save(&db, &paper).await.unwrap();
    assert!(super::store::conversation_context(&db, 1)
        .await
        .unwrap()
        .is_none());
    super::store::bind_conversation(&db, "paper", 1)
        .await
        .unwrap();
    let context = super::store::conversation_context(&db, 1)
        .await
        .unwrap()
        .unwrap();
    assert!(context.len() <= 16_000);
    assert!(context.contains("/zotero/storage/paper.pdf"));
    assert!(context.contains("/research/paper/paper.txt"));
    assert!(context.contains("/research/paper/context.md"));
    assert!(context.contains("untrusted source material"));
}

#[test]
fn atom_parser_decodes_entities_and_ignores_external_links() {
    let xml = r#"<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>http://arxiv.org/abs/2401.01234v2</id><title>A &amp; B</title><summary>Some paper</summary><author><name>Ada Smith</name></author><link href="https://evil.invalid/paper.pdf"/></entry></feed>"#;
    let candidates = parse_arxiv_feed(xml).unwrap();
    assert_eq!(candidates[0].title, "A & B");
    assert_eq!(candidates[0].pdf_url, "https://arxiv.org/pdf/2401.01234v2");
}

#[test]
fn official_project_pages_require_paper_attribution_and_exact_secondary_evidence() {
    let corpus = "Our project page is https://paper.example.org .";
    assert!(verify_project_page("https://paper.example.org", corpus, corpus).is_ok());
    assert!(verify_project_page("https://other.example.org", corpus, corpus).is_err());
    assert!(verify_project_page("http://paper.example.org", corpus, corpus).is_err());
    let page = "Code https://github.com/lab/paper";
    assert!(verify_project_repository("https://github.com/lab/paper", page, page).is_ok());
    assert!(verify_project_repository("https://github.com/lab/other", page, page).is_err());
}

#[test]
fn private_and_special_addresses_never_pass_the_project_fetch_gate() {
    for address in [
        "127.0.0.1",
        "10.1.2.3",
        "169.254.169.254",
        "100.64.0.1",
        "0.2.3.4",
        "198.18.1.1",
        "192.0.2.1",
        "240.0.0.1",
    ] {
        assert!(!public_ipv4(address.parse().unwrap()), "accepted {address}");
    }
    assert!(public_ipv4("140.82.112.3".parse().unwrap()));
}

#[tokio::test]
async fn repeated_analysis_creates_distinct_persisted_chat_folders() {
    use sea_orm_migration::MigratorTrait;
    let db = sea_orm::Database::connect("sqlite::memory:").await.unwrap();
    crate::db::migration::Migrator::up(&db, None).await.unwrap();
    let root = tempfile::tempdir().unwrap();
    let paper_workspace = root.path().join("research").join("paper");
    let first_dir = super::analysis_workspace(&paper_workspace);
    let second_dir = super::analysis_workspace(&paper_workspace);
    let first = crate::commands::conversations::create_chat_conversation_core(
        &db,
        root.path(),
        crate::models::AgentType::Codex,
        None,
        first_dir.to_str(),
    )
    .await
    .unwrap();
    let second = crate::commands::conversations::create_chat_conversation_core(
        &db,
        root.path(),
        crate::models::AgentType::Codex,
        None,
        second_dir.to_str(),
    )
    .await
    .unwrap();
    assert_ne!(first.folder_id, second.folder_id);
    assert_ne!(first.conversation_id, second.conversation_id);
    assert!(first_dir.starts_with(&paper_workspace));
    assert!(second_dir.starts_with(&paper_workspace));
}

#[tokio::test]
async fn cancelling_waiting_selection_persists_without_a_live_worker() {
    let db = database().await;
    let mut paper = paper_fixture("paper");
    paper.status = "needs_repo".into();
    super::store::save(&db, &paper).await.unwrap();
    let dir = tempfile::tempdir().unwrap();
    let runtime = super::AcademicRuntime {
        db: crate::db::AppDatabase { conn: db },
        manager: crate::acp::manager::ConnectionManager::new(),
        emitter: crate::web::event_bridge::EventEmitter::Noop,
        data_dir: dir.path().to_path_buf(),
        operations: tokio::sync::Mutex::new(()),
        imports: tokio::sync::Mutex::new(()),
        jobs: tokio::sync::Mutex::new(std::collections::HashMap::new()),
        _ownership: std::fs::File::create(dir.path().join("lock")).unwrap(),
    };
    runtime.cancel("paper").await.unwrap();
    assert_eq!(
        super::store::get(&runtime.db.conn, "paper")
            .await
            .unwrap()
            .status,
        "cancelled"
    );
}

#[tokio::test]
async fn immediate_choice_waits_for_terminal_worker_cleanup_then_validates_input() {
    let db = database().await;
    let mut paper = paper_fixture("paper");
    paper.status = "needs_match".into();
    super::store::save(&db, &paper).await.unwrap();
    let dir = tempfile::tempdir().unwrap();
    let runtime = std::sync::Arc::new(super::AcademicRuntime {
        db: crate::db::AppDatabase { conn: db },
        manager: crate::acp::manager::ConnectionManager::new(),
        emitter: crate::web::event_bridge::EventEmitter::Noop,
        data_dir: dir.path().to_path_buf(),
        operations: tokio::sync::Mutex::new(()),
        imports: tokio::sync::Mutex::new(()),
        jobs: tokio::sync::Mutex::new(std::collections::HashMap::new()),
        _ownership: std::fs::File::create(dir.path().join("lock")).unwrap(),
    });
    let connection = std::sync::Arc::new(tokio::sync::Mutex::new(None));
    let completed = tokio_util::sync::CancellationToken::new();
    runtime.jobs.lock().await.insert(
        "paper".into(),
        super::Job {
            token: tokio_util::sync::CancellationToken::new(),
            connection: connection.clone(),
            completed: completed.clone(),
        },
    );
    let choosing = runtime.prepare("paper".into(), Some("invalid-id".into()), None, None);
    tokio::pin!(choosing);
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(10), &mut choosing)
            .await
            .is_err()
    );
    runtime.finish_job("paper", &connection, &completed).await;
    let error = choosing
        .await
        .expect_err("the choice must be validated after cleanup, not silently ignored");
    assert!(error.contains("Invalid arXiv"));
}

#[tokio::test]
async fn stale_finalizer_does_not_remove_a_newer_worker() {
    let db = database().await;
    let dir = tempfile::tempdir().unwrap();
    let runtime = super::AcademicRuntime {
        db: crate::db::AppDatabase { conn: db },
        manager: crate::acp::manager::ConnectionManager::new(),
        emitter: crate::web::event_bridge::EventEmitter::Noop,
        data_dir: dir.path().to_path_buf(),
        operations: tokio::sync::Mutex::new(()),
        imports: tokio::sync::Mutex::new(()),
        jobs: tokio::sync::Mutex::new(std::collections::HashMap::new()),
        _ownership: std::fs::File::create(dir.path().join("lock")).unwrap(),
    };
    let old_connection = std::sync::Arc::new(tokio::sync::Mutex::new(None));
    let new_connection = std::sync::Arc::new(tokio::sync::Mutex::new(None));
    let old_completed = tokio_util::sync::CancellationToken::new();
    let new_completed = tokio_util::sync::CancellationToken::new();
    runtime.jobs.lock().await.insert(
        "paper".into(),
        super::Job {
            token: tokio_util::sync::CancellationToken::new(),
            connection: new_connection.clone(),
            completed: new_completed.clone(),
        },
    );
    runtime
        .finish_job("paper", &old_connection, &old_completed)
        .await;
    assert!(old_completed.is_cancelled());
    assert!(!new_completed.is_cancelled());
    assert!(std::sync::Arc::ptr_eq(
        &runtime.jobs.lock().await.get("paper").unwrap().connection,
        &new_connection
    ));
}

#[test]
fn configured_research_agent_preferences_are_captured_and_mismatch_is_rejected() {
    let settings = super::types::AcademicSettings::default();
    let requested = super::types::AcademicAgentPreferences {
        agent_type: "codex".into(),
        mode_id: Some("read-only".into()),
        config_values: std::collections::BTreeMap::from([
            ("model".into(), "research-model".into()),
            ("reasoning_effort".into(), "high".into()),
        ]),
    };
    let resolved = super::resolve_analysis_preferences(&settings, Some(requested.clone())).unwrap();
    assert_eq!(resolved, requested);
    let mut wrong_agent = requested;
    wrong_agent.agent_type = "claude_code".into();
    assert!(super::resolve_analysis_preferences(&settings, Some(wrong_agent)).is_err());
    let defaults = super::resolve_analysis_preferences(&settings, None).unwrap();
    assert_eq!(defaults.agent_type, "codex");
    assert!(defaults.mode_id.is_none());
    assert!(defaults.config_values.is_empty());
}
