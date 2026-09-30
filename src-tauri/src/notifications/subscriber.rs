use std::collections::{HashMap, HashSet};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use sea_orm::{DatabaseConnection, EntityTrait};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

use super::bark;
use crate::acp::internal_bus::InternalEventBus;
use crate::acp::manager::ConnectionManager;
use crate::acp::types::{AcpEvent, ConnectionStatus, EventEnvelope};
use crate::db::entities::folder;
use crate::db::service::conversation_service;

const COMPLETION_DELAY: Duration = Duration::from_secs(2);

#[derive(Default)]
struct TurnTracker {
    conversation_id: Option<i32>,
    child: bool,
    last_seq: u64,
    generation: u64,
    active: bool,
    failed: bool,
    disconnected: bool,
    final_reply: String,
    has_reply: bool,
    pending: Option<u64>,
}

struct Completion {
    connection_id: String,
    conversation_id: i32,
    generation: u64,
    final_reply: String,
}

impl TurnTracker {
    fn invalidate_after_lag(&mut self) {
        self.generation = self.generation.wrapping_add(1);
        self.active = false;
        self.failed = true;
        self.pending = None;
        self.has_reply = false;
        self.final_reply.clear();
    }

    fn begin(&mut self) {
        self.generation = self.generation.wrapping_add(1);
        self.active = true;
        self.failed = false;
        self.pending = None;
        self.has_reply = false;
        self.final_reply.clear();
    }

    fn apply(&mut self, envelope: &EventEnvelope) -> Option<Completion> {
        if envelope.seq <= self.last_seq {
            return None;
        }
        self.last_seq = envelope.seq;
        match &envelope.payload {
            AcpEvent::ConversationLinked {
                conversation_id,
                parent_conversation_id,
                ..
            } => {
                self.conversation_id = Some(*conversation_id);
                self.child = parent_conversation_id.is_some();
            }
            AcpEvent::UserMessage { .. } => self.begin(),
            AcpEvent::StatusChanged {
                status: ConnectionStatus::Prompting,
            } if !self.active => {
                self.begin();
            }
            AcpEvent::ContentDelta {
                text,
                parent_tool_use_id: None,
            } if self.active => {
                self.has_reply |= !text.trim().is_empty();
                let remaining =
                    bark::PREVIEW_CHARS.saturating_sub(self.final_reply.chars().count());
                self.final_reply.extend(text.chars().take(remaining));
            }
            AcpEvent::ToolCall { .. } if self.active => {
                // Text preceding a tool is progress commentary. Only a reply
                // after the last tool can announce the finished work.
                self.final_reply.clear();
                self.has_reply = false;
            }
            AcpEvent::Error { .. } => {
                self.failed = true;
                self.pending = None;
            }
            AcpEvent::SessionFailure { record }
                if record.severity == "error" && !record.resolved =>
            {
                self.failed = true;
                self.pending = None;
            }
            AcpEvent::StatusChanged {
                status: ConnectionStatus::Error,
            } => {
                self.failed = true;
                self.pending = None;
            }
            AcpEvent::StatusChanged {
                status: ConnectionStatus::Disconnected,
            } => {
                self.disconnected = true;
                self.active = false;
            }
            AcpEvent::DelegationCompleted {
                result: crate::acp::types::DelegationResultSummary::Err { .. },
                ..
            } => {
                self.failed = true;
                self.pending = None;
            }
            AcpEvent::BackgroundActivity { settled, .. }
                if settled.iter().any(|task| task.status != "completed") =>
            {
                self.failed = true;
                self.pending = None;
            }
            AcpEvent::AsyncTask { delta }
                if delta
                    .state
                    .as_deref()
                    .is_some_and(|status| matches!(status, "failed" | "stopped")) =>
            {
                self.failed = true;
                self.pending = None;
            }
            AcpEvent::TurnComplete { stop_reason, .. } => {
                if !self.active && stop_reason == "end_turn" {
                    return None;
                }
                let eligible = self.active
                    && !self.failed
                    && !self.child
                    && self.has_reply
                    && stop_reason == "end_turn";
                self.active = false;
                if eligible {
                    let conversation_id = self.conversation_id?;
                    self.pending = Some(self.generation);
                    return Some(Completion {
                        connection_id: envelope.connection_id.clone(),
                        conversation_id,
                        generation: self.generation,
                        final_reply: std::mem::take(&mut self.final_reply),
                    });
                }
                self.pending = None;
            }
            _ => {}
        }
        None
    }

    fn is_current(&self, completion: &Completion) -> bool {
        self.pending == Some(completion.generation) && !self.active && !self.failed
    }
}

type Trackers = Arc<Mutex<HashMap<String, TurnTracker>>>;

/// Subscribe synchronously so the first prompt cannot race task scheduling.
pub fn spawn_completion_subscriber(
    bus: Arc<InternalEventBus>,
    db: DatabaseConnection,
    manager: ConnectionManager,
) -> JoinHandle<()> {
    let mut rx = bus.subscribe();
    let metrics = Arc::clone(bus.metrics());
    tokio::spawn(async move {
        let source_id = match bark::source_id(&db).await {
            Ok(id) => id,
            Err(error) => {
                tracing::error!("[Bark] cannot initialize notification source: {error}");
                return;
            }
        };
        let client = match bark::client() {
            Ok(client) => client,
            Err(error) => {
                tracing::error!("[Bark] cannot initialize notification client: {error}");
                return;
            }
        };
        let trackers: Trackers = Arc::new(Mutex::new(HashMap::new()));
        loop {
            let envelope = match rx.recv().await {
                Ok(envelope) => envelope,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    metrics.lagged_count.fetch_add(n, Ordering::Relaxed);
                    // Missing a failure/turn boundary makes a success inference
                    // unreliable. Drop in-flight notifications after a lag.
                    for tracker in trackers.lock().await.values_mut() {
                        tracker.invalidate_after_lag();
                    }
                    tracing::warn!("[Bark] dropped {n} events; cleared completion tracking");
                    continue;
                }
                Err(_) => break,
            };
            let completion = {
                let mut records = trackers.lock().await;
                if !records.contains_key(&envelope.connection_id)
                    && !matches!(
                        &envelope.payload,
                        AcpEvent::ConversationLinked { .. }
                            | AcpEvent::UserMessage { .. }
                            | AcpEvent::StatusChanged {
                                status: ConnectionStatus::Prompting
                            }
                    )
                {
                    continue;
                }
                let tracker = records.entry(envelope.connection_id.clone()).or_default();
                let completion = tracker.apply(&envelope);
                if tracker.disconnected && tracker.pending.is_none() {
                    records.remove(&envelope.connection_id);
                }
                completion
            };
            if let Some(completion) = completion {
                let trackers = Arc::clone(&trackers);
                let db = db.clone();
                let manager = manager.clone_ref();
                let client = client.clone();
                let source_id = source_id.clone();
                tokio::spawn(async move {
                    if wait_for_idle(&trackers, &manager, &completion).await {
                        if let Err(error) =
                            deliver(&trackers, &db, &manager, &client, &source_id, &completion)
                                .await
                        {
                            tracing::warn!("[Bark] completion notification failed: {error}");
                        }
                    }
                    let mut records = trackers.lock().await;
                    if let Some(tracker) = records.get_mut(&completion.connection_id) {
                        if tracker.pending == Some(completion.generation) {
                            tracker.pending = None;
                        }
                        if tracker.disconnected && tracker.pending.is_none() {
                            records.remove(&completion.connection_id);
                        }
                    }
                });
            }
        }
    })
}

async fn still_current(trackers: &Trackers, completion: &Completion) -> bool {
    trackers
        .lock()
        .await
        .get(&completion.connection_id)
        .is_some_and(|tracker| tracker.is_current(completion))
}

async fn work_is_idle(manager: &ConnectionManager, connection_id: &str) -> bool {
    if manager.has_running_delegations(connection_id).await {
        return false;
    }
    let Some(state) = manager.get_state(connection_id).await else {
        // The connection may retire normally immediately after its final
        // reply; its tracked terminal reason is still authoritative.
        return true;
    };
    let state = state.read().await;
    !state.turn_in_flight
        && !state.agent_initiated_turn
        && state.active_delegations.is_empty()
        && state.background_outstanding == 0
        && state
            .async_tasks
            .values()
            .all(|task| crate::acp::types::async_task_state_is_terminal(&task.state))
        && state.pending_permission.is_none()
        && state.pending_question.is_none()
        && state.pending_plan_approval.is_none()
        && !state
            .feedback
            .iter()
            .any(|item| matches!(item.status, crate::acp::feedback::FeedbackStatus::Pending))
}

async fn wait_for_idle(
    trackers: &Trackers,
    manager: &ConnectionManager,
    completion: &Completion,
) -> bool {
    // Synthetic-ID children have no public DelegationCompleted event. Remember
    // their broker IDs so a failure/cancellation while waiting cannot be told
    // as success simply because the child stopped running.
    let mut observed: HashSet<String> = manager
        .running_delegation_ids(&completion.connection_id)
        .await
        .into_iter()
        .collect();
    loop {
        tokio::time::sleep(COMPLETION_DELAY).await;
        if !still_current(trackers, completion).await {
            return false;
        }
        observed.extend(
            manager
                .running_delegation_ids(&completion.connection_id)
                .await,
        );
        if work_is_idle(manager, &completion.connection_id).await {
            return manager
                .delegations_completed_successfully(
                    &completion.connection_id,
                    &observed.into_iter().collect::<Vec<_>>(),
                )
                .await;
        }
    }
}

async fn deliver(
    trackers: &Trackers,
    db: &DatabaseConnection,
    manager: &ConnectionManager,
    client: &reqwest::Client,
    source_id: &str,
    completion: &Completion,
) -> Result<(), crate::app_error::AppCommandError> {
    if !still_current(trackers, completion).await
        || !work_is_idle(manager, &completion.connection_id).await
    {
        return Ok(());
    }
    let devices = bark::enabled_devices(db).await?;
    if devices.is_empty() {
        return Ok(());
    }
    let conversation = conversation_service::get_by_id(db, completion.conversation_id).await?;
    if conversation.parent_id.is_some() {
        return Ok(());
    }
    let folder = folder::Entity::find_by_id(conversation.folder_id)
        .one(db)
        .await
        .map_err(crate::db::error::DbError::from)?;
    let workspace = if let Some(cwd) = conversation.origin_cwd.as_deref() {
        std::path::Path::new(cwd)
            .file_name()
            .and_then(|name| name.to_str())
            .map(str::to_string)
    } else {
        folder
            .as_ref()
            .filter(|folder| folder.kind == folder::FolderKind::Regular)
            .map(|folder| {
                match folder
                    .alias
                    .as_deref()
                    .filter(|alias| !alias.trim().is_empty())
                {
                    Some(alias) => format!("{alias} [{}]", folder.name),
                    None => folder.name.clone(),
                }
            })
    };
    let mut destinations = HashSet::new();
    for device in devices {
        // Settings can change while other devices are being delivered. Read
        // this device again so disabling immediately suppresses a waiting send.
        let settings = bark::load_settings(db, &device.device_id).await?;
        if !settings.enabled
            || !still_current(trackers, completion).await
            || !work_is_idle(manager, &completion.connection_id).await
        {
            continue;
        }
        if !destinations.insert(settings.push_url.clone()) {
            continue;
        }
        let payload = bark::completion_payload(
            &settings,
            &device.device_id,
            completion.conversation_id,
            conversation.title.as_deref(),
            workspace.as_deref(),
            source_id,
            &completion.final_reply,
        );
        if let Err(error) = bark::send(client, &settings, payload).await {
            // Don't let one broken destination suppress the other phones.
            tracing::warn!("[Bark] notification delivery failed: {error}");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
