use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, Semaphore};
use tokio_util::sync::CancellationToken;

pub const WORKSPACE_TRANSFER_PROGRESS_EVENT: &str = "workspace://transfer-progress";

const DOWNLOAD_TICKET_TTL_SECS: u64 = 60;
const DEFAULT_WORKSPACE_UPLOAD_CONCURRENCY: usize = 4;
const DEFAULT_REMOTE_WORKSPACE_UPLOAD_CONCURRENCY: usize = 2;
const DEFAULT_WORKSPACE_ZIP_CONCURRENCY: usize = 2;
const DEFAULT_REMOTE_WORKSPACE_DOWNLOAD_CONCURRENCY: usize = 2;
const DEFAULT_TRANSFER_IDLE_TIMEOUT_SECS: u64 = 300;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DownloadKind {
    File,
    Dir,
}

#[derive(Clone, Debug)]
pub struct DownloadTicketSpec {
    pub root_path: PathBuf,
    pub target_path: PathBuf,
    pub relative_path: String,
    pub kind: DownloadKind,
    pub filename: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadTicketIssued {
    pub ticket: String,
    pub url: String,
    pub filename: String,
    pub expires_at: i64,
}

#[derive(Clone, Debug)]
pub struct DownloadTicket {
    pub root_path: PathBuf,
    pub target_path: PathBuf,
    pub relative_path: String,
    pub kind: DownloadKind,
    pub filename: String,
    pub expires_at: Instant,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTransferProgress {
    pub transfer_id: String,
    pub direction: TransferDirection,
    pub loaded: u64,
    pub total: Option<u64>,
    pub state: TransferState,
    pub path: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TransferDirection {
    Upload,
    Download,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TransferState {
    Running,
    Done,
    Cancelled,
    Error,
}

/// Remote transfers are owned by the invoking webview and machine. Tokens
/// and custom authentication headers never appear in this metadata.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteTransferOwner {
    pub connection_id: i32,
    #[serde(rename = "ownerWindowLabel")]
    pub window_label: String,
    pub window_instance_id: String,
}

struct TransferRegistration {
    token: CancellationToken,
    owner: Option<RemoteTransferOwner>,
}

pub struct WorkspaceTransferManager {
    tickets: Mutex<HashMap<String, DownloadTicket>>,
    cancels: Mutex<HashMap<String, TransferRegistration>>,
    ticket_ttl: Duration,
    pub workspace_upload_semaphore: Semaphore,
    pub remote_upload_semaphore: Semaphore,
    pub zip_semaphore: Semaphore,
    pub remote_download_semaphore: Semaphore,
    pub idle_timeout: Duration,
}

impl WorkspaceTransferManager {
    pub fn new_from_env() -> Self {
        Self {
            tickets: Mutex::new(HashMap::new()),
            cancels: Mutex::new(HashMap::new()),
            ticket_ttl: Duration::from_secs(DOWNLOAD_TICKET_TTL_SECS),
            workspace_upload_semaphore: Semaphore::new(env_usize(
                "CODEG_WORKSPACE_UPLOAD_MAX_CONCURRENCY",
                DEFAULT_WORKSPACE_UPLOAD_CONCURRENCY,
            )),
            remote_upload_semaphore: Semaphore::new(env_usize(
                "CODEG_REMOTE_WORKSPACE_UPLOAD_MAX_CONCURRENCY",
                DEFAULT_REMOTE_WORKSPACE_UPLOAD_CONCURRENCY,
            )),
            zip_semaphore: Semaphore::new(env_usize(
                "CODEG_WORKSPACE_ZIP_MAX_CONCURRENCY",
                DEFAULT_WORKSPACE_ZIP_CONCURRENCY,
            )),
            remote_download_semaphore: Semaphore::new(env_usize(
                "CODEG_REMOTE_WORKSPACE_DOWNLOAD_MAX_CONCURRENCY",
                DEFAULT_REMOTE_WORKSPACE_DOWNLOAD_CONCURRENCY,
            )),
            idle_timeout: env_duration_secs(
                "CODEG_WORKSPACE_TRANSFER_IDLE_TIMEOUT_SECS",
                DEFAULT_TRANSFER_IDLE_TIMEOUT_SECS,
            ),
        }
    }

    pub fn new_for_tests(ticket_ttl: Duration) -> Self {
        Self {
            tickets: Mutex::new(HashMap::new()),
            cancels: Mutex::new(HashMap::new()),
            ticket_ttl,
            workspace_upload_semaphore: Semaphore::new(DEFAULT_WORKSPACE_UPLOAD_CONCURRENCY),
            remote_upload_semaphore: Semaphore::new(DEFAULT_REMOTE_WORKSPACE_UPLOAD_CONCURRENCY),
            zip_semaphore: Semaphore::new(DEFAULT_WORKSPACE_ZIP_CONCURRENCY),
            remote_download_semaphore: Semaphore::new(
                DEFAULT_REMOTE_WORKSPACE_DOWNLOAD_CONCURRENCY,
            ),
            idle_timeout: Duration::from_secs(DEFAULT_TRANSFER_IDLE_TIMEOUT_SECS),
        }
    }

    pub async fn register_transfer(&self) -> (String, CancellationToken) {
        self.register(None).await
    }

    pub async fn register_remote_transfer(
        &self,
        owner: RemoteTransferOwner,
    ) -> (String, CancellationToken) {
        self.register(Some(owner)).await
    }

    async fn register(&self, owner: Option<RemoteTransferOwner>) -> (String, CancellationToken) {
        let id = uuid::Uuid::new_v4().simple().to_string();
        let token = CancellationToken::new();
        self.cancels.lock().await.insert(
            id.clone(),
            TransferRegistration {
                token: token.clone(),
                owner,
            },
        );
        (id, token)
    }

    pub async fn finish_transfer(&self, transfer_id: &str) {
        self.cancels.lock().await.remove(transfer_id);
    }

    /// Legacy local/backup cancellation cannot cancel an owned remote transfer.
    pub async fn cancel(&self, transfer_id: &str) -> bool {
        let mut entries = self.cancels.lock().await;
        if entries
            .get(transfer_id)
            .is_some_and(|entry| entry.owner.is_none())
        {
            entries.remove(transfer_id).unwrap().token.cancel();
            true
        } else {
            false
        }
    }

    pub async fn cancel_remote(
        &self,
        transfer_id: &str,
        label: &str,
        instance: &str,
        connection_id: Option<i32>,
    ) -> bool {
        let mut entries = self.cancels.lock().await;
        let matches = entries
            .get(transfer_id)
            .and_then(|entry| entry.owner.as_ref())
            .is_some_and(|owner| {
                owner.window_label == label
                    && owner.window_instance_id == instance
                    && connection_id.is_none_or(|id| owner.connection_id == id)
            });
        if matches {
            entries.remove(transfer_id).unwrap().token.cancel();
        }
        matches
    }

    /// Invalidating A cancels only A's transfers, including queued transfers.
    pub async fn cancel_connection(&self, connection_id: i32) -> usize {
        let mut entries = self.cancels.lock().await;
        let mut cancelled = 0;
        entries.retain(|_, entry| {
            if entry
                .owner
                .as_ref()
                .is_some_and(|owner| owner.connection_id == connection_id)
            {
                entry.token.cancel();
                cancelled += 1;
                false
            } else {
                true
            }
        });
        cancelled
    }

    pub async fn issue_download_ticket(&self, spec: DownloadTicketSpec) -> DownloadTicketIssued {
        self.cleanup_expired_tickets().await;

        let ticket = uuid::Uuid::new_v4().simple().to_string();
        let expires_at_instant = Instant::now() + self.ticket_ttl;
        let expires_at = SystemTime::now()
            .checked_add(self.ticket_ttl)
            .unwrap_or(SystemTime::now())
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;

        self.tickets.lock().await.insert(
            ticket.clone(),
            DownloadTicket {
                root_path: spec.root_path,
                target_path: spec.target_path,
                relative_path: spec.relative_path,
                kind: spec.kind,
                filename: spec.filename.clone(),
                expires_at: expires_at_instant,
            },
        );

        DownloadTicketIssued {
            url: ticket.clone(),
            ticket,
            filename: spec.filename,
            expires_at,
        }
    }

    pub async fn consume_download_ticket(&self, ticket: &str) -> Option<DownloadTicket> {
        self.cleanup_expired_tickets().await;
        let found = self.tickets.lock().await.remove(ticket);
        found.filter(|ticket| Instant::now() <= ticket.expires_at)
    }

    pub async fn cleanup_expired_tickets(&self) {
        let now = Instant::now();
        self.tickets
            .lock()
            .await
            .retain(|_, ticket| ticket.expires_at > now);
    }
}

pub fn env_usize(name: &str, default: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|raw| raw.trim().parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(default)
}

pub fn env_duration_secs(name: &str, default_secs: u64) -> Duration {
    Duration::from_secs(
        std::env::var(name)
            .ok()
            .and_then(|raw| raw.trim().parse::<u64>().ok())
            .filter(|value| *value > 0)
            .unwrap_or(default_secs),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::Duration;

    fn owner(connection_id: i32, instance: &str) -> RemoteTransferOwner {
        RemoteTransferOwner {
            connection_id,
            window_label: "main".into(),
            window_instance_id: instance.into(),
        }
    }

    #[tokio::test]
    async fn remote_cancellation_checks_machine_window_and_instance() {
        let manager = WorkspaceTransferManager::new_for_tests(Duration::from_secs(60));
        let (id, token) = manager.register_remote_transfer(owner(1, "old")).await;
        assert!(!manager.cancel(&id).await);
        assert!(!manager.cancel_remote(&id, "sibling", "old", Some(1)).await);
        assert!(!manager.cancel_remote(&id, "main", "new", Some(1)).await);
        assert!(!manager.cancel_remote(&id, "main", "old", Some(2)).await);
        assert!(!token.is_cancelled());
        assert!(manager.cancel_remote(&id, "main", "old", Some(1)).await);
        assert!(token.is_cancelled());
        let (legacy, legacy_token) = manager.register_remote_transfer(owner(1, "main")).await;
        assert!(manager.cancel_remote(&legacy, "main", "main", None).await);
        assert!(legacy_token.is_cancelled());
    }

    #[tokio::test]
    async fn connection_invalidation_only_cancels_its_own_transfers() {
        let manager = WorkspaceTransferManager::new_for_tests(Duration::from_secs(60));
        let (_, a1) = manager.register_remote_transfer(owner(1, "one")).await;
        let (_, a2) = manager.register_remote_transfer(owner(1, "two")).await;
        let (_, b) = manager.register_remote_transfer(owner(2, "one")).await;
        let (_, local) = manager.register_transfer().await;
        assert_eq!(manager.cancel_connection(1).await, 2);
        assert!(a1.is_cancelled() && a2.is_cancelled());
        assert!(!b.is_cancelled() && !local.is_cancelled());
        assert_eq!(manager.cancel_connection(1).await, 0);
        assert_eq!(
            serde_json::to_value(owner(1, "one")).unwrap(),
            serde_json::json!({
                "connectionId": 1, "ownerWindowLabel": "main", "windowInstanceId": "one",
            })
        );
    }

    #[test]
    fn env_usize_uses_default_for_missing_invalid_and_zero() {
        temp_env::with_var_unset("CODEG_WORKSPACE_UPLOAD_MAX_CONCURRENCY", || {
            assert_eq!(env_usize("CODEG_WORKSPACE_UPLOAD_MAX_CONCURRENCY", 4), 4);
        });
        temp_env::with_var(
            "CODEG_WORKSPACE_UPLOAD_MAX_CONCURRENCY",
            Some("nope"),
            || {
                assert_eq!(env_usize("CODEG_WORKSPACE_UPLOAD_MAX_CONCURRENCY", 4), 4);
            },
        );
        temp_env::with_var("CODEG_WORKSPACE_UPLOAD_MAX_CONCURRENCY", Some("0"), || {
            assert_eq!(env_usize("CODEG_WORKSPACE_UPLOAD_MAX_CONCURRENCY", 4), 4);
        });
    }

    #[tokio::test]
    async fn ticket_is_single_use_and_expires() {
        let manager = WorkspaceTransferManager::new_for_tests(Duration::from_millis(20));
        let ticket = manager
            .issue_download_ticket(DownloadTicketSpec {
                root_path: PathBuf::from("/tmp/root"),
                target_path: PathBuf::from("/tmp/root/file.txt"),
                relative_path: "file.txt".to_string(),
                kind: DownloadKind::File,
                filename: "file.txt".to_string(),
            })
            .await;
        assert!(manager
            .consume_download_ticket(&ticket.ticket)
            .await
            .is_some());
        assert!(manager
            .consume_download_ticket(&ticket.ticket)
            .await
            .is_none());

        let expired = manager
            .issue_download_ticket(DownloadTicketSpec {
                root_path: PathBuf::from("/tmp/root"),
                target_path: PathBuf::from("/tmp/root/old.txt"),
                relative_path: "old.txt".to_string(),
                kind: DownloadKind::File,
                filename: "old.txt".to_string(),
            })
            .await;
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert!(manager
            .consume_download_ticket(&expired.ticket)
            .await
            .is_none());
    }

    #[tokio::test]
    async fn cancel_marks_token_and_removes_entry() {
        let manager = WorkspaceTransferManager::new_for_tests(Duration::from_secs(60));
        let (id, token) = manager.register_transfer().await;
        assert!(!token.is_cancelled());
        assert!(manager.cancel(&id).await);
        assert!(token.is_cancelled());
        assert!(!manager.cancel(&id).await);
    }
}
