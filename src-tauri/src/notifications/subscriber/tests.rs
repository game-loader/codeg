use super::*;
use crate::acp::types::SessionFailureRecord;
use crate::models::agent::AgentType;
use crate::web::event_bridge::EventEmitter;

fn apply(tracker: &mut TurnTracker, event: AcpEvent) -> Option<Completion> {
    tracker.apply(&EventEnvelope {
        seq: tracker.last_seq + 1,
        connection_id: "conn".into(),
        payload: event,
    })
}

fn begin(tracker: &mut TurnTracker) {
    apply(
        tracker,
        AcpEvent::ConversationLinked {
            conversation_id: 42,
            folder_id: 1,
            parent_conversation_id: None,
            parent_tool_use_id: None,
        },
    );
    apply(
        tracker,
        AcpEvent::UserMessage {
            message_id: "prompt".into(),
            blocks: vec![],
        },
    );
}

fn reply() -> AcpEvent {
    AcpEvent::ContentDelta {
        text: "Final reply".into(),
        parent_tool_use_id: None,
    }
}

fn done(reason: &str) -> AcpEvent {
    AcpEvent::TurnComplete {
        session_id: "session".into(),
        stop_reason: reason.into(),
        agent_type: "codex".into(),
    }
}

#[test]
fn only_successful_final_replies_notify_and_duplicates_do_not_cancel_them() {
    let mut tracker = TurnTracker::default();
    begin(&mut tracker);
    apply(&mut tracker, reply());
    let completion = apply(&mut tracker, done("end_turn")).unwrap();
    assert_eq!(completion.final_reply, "Final reply");
    assert!(tracker.is_current(&completion));
    assert!(apply(&mut tracker, done("end_turn")).is_none());
    assert!(tracker.is_current(&completion));
    for reason in [
        "cancelled",
        "refusal",
        "max_tokens",
        "max_turn_requests",
        "empty",
        "error",
        "unknown",
    ] {
        begin(&mut tracker);
        apply(&mut tracker, reply());
        assert!(
            apply(&mut tracker, done(reason)).is_none(),
            "notified {reason}"
        );
    }
}

#[test]
fn tool_endings_thinking_and_child_content_are_not_final_replies() {
    let mut tracker = TurnTracker::default();
    begin(&mut tracker);
    apply(
        &mut tracker,
        AcpEvent::Thinking {
            text: "thinking".into(),
            parent_tool_use_id: None,
        },
    );
    apply(
        &mut tracker,
        AcpEvent::ContentDelta {
            text: "Child done".into(),
            parent_tool_use_id: Some("delegate".into()),
        },
    );
    assert!(apply(&mut tracker, done("end_turn")).is_none());
    begin(&mut tracker);
    apply(&mut tracker, reply());
    apply(
        &mut tracker,
        AcpEvent::ToolCall {
            tool_call_id: "tool".into(),
            title: "Run".into(),
            kind: "execute".into(),
            status: "completed".into(),
            content: None,
            raw_input: None,
            raw_output: None,
            locations: None,
            meta: None,
            images: None,
        },
    );
    assert!(apply(&mut tracker, done("end_turn")).is_none());
    begin(&mut tracker);
    apply(&mut tracker, reply());
    tracker.child = true;
    assert!(apply(&mut tracker, done("end_turn")).is_none());
}

#[test]
fn typed_failures_masking_end_turn_are_filtered_but_retry_warnings_can_recover() {
    for severity in ["error", "warning"] {
        let mut tracker = TurnTracker::default();
        begin(&mut tracker);
        apply(&mut tracker, reply());
        apply(
            &mut tracker,
            AcpEvent::SessionFailure {
                record: SessionFailureRecord {
                    id: "failure".into(),
                    revision: 1,
                    category: "service".into(),
                    severity: severity.into(),
                    title: "failure".into(),
                    details: None,
                    actions: vec![],
                    resolved: false,
                },
            },
        );
        assert_eq!(
            apply(&mut tracker, done("end_turn")).is_some(),
            severity == "warning"
        );
    }
}

#[test]
fn new_queued_turn_invalidates_earlier_completion_and_final_turn_can_notify() {
    let mut tracker = TurnTracker::default();
    begin(&mut tracker);
    apply(&mut tracker, reply());
    let first = apply(&mut tracker, done("end_turn")).unwrap();
    apply(
        &mut tracker,
        AcpEvent::UserMessage {
            message_id: "queued".into(),
            blocks: vec![],
        },
    );
    assert!(!tracker.is_current(&first));
    apply(&mut tracker, reply());
    let last = apply(&mut tracker, done("end_turn")).unwrap();
    assert!(tracker.is_current(&last));
}

#[test]
fn lag_invalidates_old_completion_but_retains_identity_for_later_turns() {
    let mut tracker = TurnTracker::default();
    begin(&mut tracker);
    apply(&mut tracker, reply());
    let old = apply(&mut tracker, done("end_turn")).unwrap();
    tracker.invalidate_after_lag();
    assert!(!tracker.is_current(&old));
    apply(
        &mut tracker,
        AcpEvent::UserMessage {
            message_id: "after-lag".into(),
            blocks: vec![],
        },
    );
    apply(&mut tracker, reply());
    let completion = apply(&mut tracker, done("end_turn")).unwrap();
    assert_eq!(completion.conversation_id, 42);
}

#[tokio::test]
async fn pending_completion_waits_until_background_work_settles_successfully() {
    let manager = crate::app_state::default_connection_manager();
    manager
        .insert_test_connection("conn", AgentType::Codex, None, EventEmitter::Noop)
        .await;
    let state = manager.get_state("conn").await.unwrap();
    state.write().await.background_outstanding = 1;
    let mut tracker = TurnTracker::default();
    begin(&mut tracker);
    apply(&mut tracker, reply());
    let completion = apply(&mut tracker, done("end_turn")).unwrap();
    let trackers = Arc::new(Mutex::new(HashMap::from([("conn".into(), tracker)])));
    let waiter = tokio::spawn(async move { wait_for_idle(&trackers, &manager, &completion).await });
    tokio::time::sleep(Duration::from_millis(2200)).await;
    assert!(!waiter.is_finished());
    state.write().await.background_outstanding = 0;
    assert!(tokio::time::timeout(Duration::from_secs(3), waiter)
        .await
        .unwrap()
        .unwrap());
}

#[tokio::test]
async fn admitted_prompts_pending_approval_and_background_work_suppress_delivery() {
    let manager = crate::app_state::default_connection_manager();
    manager
        .insert_test_connection("conn", AgentType::Codex, None, EventEmitter::Noop)
        .await;
    let state = manager.get_state("conn").await.unwrap();
    assert!(work_is_idle(&manager, "conn").await);
    state.write().await.turn_in_flight = true;
    assert!(!work_is_idle(&manager, "conn").await);
    state.write().await.turn_in_flight = false;
    {
        let mut state = state.write().await;
        state.background_outstanding = 1;
        state.background_activity_at = Some(chrono::Utc::now());
    }
    assert!(!work_is_idle(&manager, "conn").await);
    state.write().await.background_outstanding = 0;
    assert!(work_is_idle(&manager, "conn").await);
}

#[tokio::test]
async fn subscriber_sends_only_last_reply_after_queued_turn_and_duplicate_events() {
    use crate::acp::internal_bus::EventBusMetrics;
    use crate::web::event_bridge::{emit_with_state, WebEventBroadcaster};
    let db = crate::db::test_helpers::fresh_in_memory_db().await;
    let folder = crate::db::test_helpers::seed_folder(&db, "/tmp/bark-test").await;
    let conversation =
        crate::db::test_helpers::seed_conversation(&db, folder, AgentType::Codex).await;
    let (mut settings, mut requests, mock_server) =
        super::super::bark::tests::mock_bark(axum::http::StatusCode::OK, 200).await;
    settings.include_preview = true;
    let device = "ffab49ec-0110-4f12-81fe-e37a8e2da001";
    bark::save_settings(&db.conn, device, settings)
        .await
        .unwrap();
    let bus = Arc::new(InternalEventBus::new(Arc::new(EventBusMetrics::default())));
    let emitter = EventEmitter::web_only(Arc::new(WebEventBroadcaster::new()), bus.clone());
    let manager = crate::app_state::default_connection_manager();
    manager
        .insert_test_connection("conn", AgentType::Codex, None, emitter.clone())
        .await;
    let state = manager.get_state("conn").await.unwrap();
    let subscriber = spawn_completion_subscriber(bus, db.conn.clone(), manager);
    emit_with_state(
        &state,
        &emitter,
        AcpEvent::ConversationLinked {
            conversation_id: conversation,
            folder_id: folder,
            parent_conversation_id: None,
            parent_tool_use_id: None,
        },
    )
    .await;
    for (id, text) in [("first", "Intermediate reply"), ("queued", "Final reply")] {
        emit_with_state(
            &state,
            &emitter,
            AcpEvent::UserMessage {
                message_id: id.into(),
                blocks: vec![],
            },
        )
        .await;
        emit_with_state(
            &state,
            &emitter,
            AcpEvent::ContentDelta {
                text: text.into(),
                parent_tool_use_id: None,
            },
        )
        .await;
        emit_with_state(&state, &emitter, done("end_turn")).await;
    }
    emit_with_state(&state, &emitter, done("end_turn")).await;
    let payload = tokio::time::timeout(Duration::from_secs(5), requests.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(payload["body"], "Task completed\nFinal reply");
    assert!(payload["subtitle"]
        .as_str()
        .unwrap()
        .starts_with("bark-test · "));
    assert_eq!(
        payload["url"],
        format!("codeg://conversation/{conversation}?server_id={device}")
    );
    assert!(requests.try_recv().is_err());
    subscriber.abort();
    mock_server.abort();
}

#[tokio::test]
async fn disabling_or_failure_after_completion_suppresses_waiting_delivery() {
    let db = crate::db::test_helpers::fresh_in_memory_db().await;
    let folder = crate::db::test_helpers::seed_folder(&db, "/tmp/bark-test").await;
    let conversation =
        crate::db::test_helpers::seed_conversation(&db, folder, AgentType::Codex).await;
    let (mut settings, mut requests, mock_server) =
        super::super::bark::tests::mock_bark(axum::http::StatusCode::OK, 200).await;
    let device = "ffab49ec-0110-4f12-81fe-e37a8e2da001";
    bark::save_settings(&db.conn, device, settings.clone())
        .await
        .unwrap();
    let manager = crate::app_state::default_connection_manager();
    let mut tracker = TurnTracker::default();
    begin(&mut tracker);
    tracker.conversation_id = Some(conversation);
    apply(&mut tracker, reply());
    let completion = apply(&mut tracker, done("end_turn")).unwrap();
    let trackers = Arc::new(Mutex::new(HashMap::from([("conn".into(), tracker)])));
    settings.enabled = false;
    bark::save_settings(&db.conn, device, settings.clone())
        .await
        .unwrap();
    let client = bark::client().unwrap();
    deliver(
        &trackers,
        &db.conn,
        &manager,
        &client,
        "server-a",
        &completion,
    )
    .await
    .unwrap();
    assert!(requests.try_recv().is_err());

    settings.enabled = true;
    bark::save_settings(&db.conn, device, settings)
        .await
        .unwrap();
    trackers.lock().await.get_mut("conn").unwrap().failed = true;
    deliver(
        &trackers,
        &db.conn,
        &manager,
        &client,
        "server-a",
        &completion,
    )
    .await
    .unwrap();
    assert!(requests.try_recv().is_err());
    mock_server.abort();
}
