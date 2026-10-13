//! Safe, read-only source metadata for registered folders in either runtime.

use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::path::Path;
use std::process::Stdio;
use std::sync::LazyLock;
use std::time::Duration;

use futures::future::join_all;
use tokio::io::{AsyncReadExt, BufReader};
use tokio::sync::Semaphore;
use tokio::time::{timeout_at, Instant};

use crate::app_error::AppCommandError;
use crate::db::service::folder_service;
use crate::db::AppDatabase;
use crate::git_remote_identity::select_identity;
use crate::models::{
    RepositoryProjectIdentity, RepositoryProjectIdentityEntry, RepositoryProjectIdentityStatus,
};

const MAX_FOLDER_IDS: usize = 128;
const MAX_OUTPUT_BYTES: u64 = 256 * 1024;
const READ_TIMEOUT: Duration = Duration::from_secs(5);
const BATCH_TIMEOUT: Duration = Duration::from_secs(25);
// All requests and both runtime adapters share this process-wide limit.
static PROBE_SLOTS: LazyLock<Semaphore> = LazyLock::new(|| Semaphore::new(4));

struct ProbeContext<'a> {
    slots: &'a Semaphore,
    program: &'a OsStr,
    read_timeout: Duration,
    batch_deadline: Instant,
}

pub async fn list_repository_project_identities_core(
    db: &AppDatabase,
    folder_ids: Vec<i32>,
) -> Result<Vec<RepositoryProjectIdentityEntry>, AppCommandError> {
    // Count submitted IDs, not unique IDs, before any database/process work.
    if folder_ids.len() > MAX_FOLDER_IDS {
        return Err(AppCommandError::invalid_input(
            "At most 128 folder IDs are allowed",
        ));
    }
    let mut seen = HashSet::new();
    let folder_ids: Vec<_> = folder_ids
        .into_iter()
        .filter(|id| seen.insert(*id))
        .collect();
    if folder_ids.is_empty() {
        return Ok(Vec::new());
    }
    let context = ProbeContext {
        slots: &PROBE_SLOTS,
        program: OsStr::new("git"),
        read_timeout: READ_TIMEOUT,
        batch_deadline: Instant::now() + BATCH_TIMEOUT,
    };
    let paths: HashMap<_, _> = match timeout_at(
        context.batch_deadline,
        folder_service::repository_project_paths(&db.conn, &folder_ids),
    )
    .await
    {
        Ok(result) => result?.into_iter().collect(),
        Err(_) => HashMap::new(),
    };
    Ok(join_all(folder_ids.into_iter().map(|folder_id| {
        let path = paths.get(&folder_id).cloned();
        let context = &context;
        async move {
            let result = match path.as_deref() {
                Some(path) => inspect_path(path, context).await,
                None => Err(()),
            };
            let (status, identity) = match result {
                Ok(identity) => (RepositoryProjectIdentityStatus::Resolved, identity),
                Err(()) => (RepositoryProjectIdentityStatus::Unavailable, None),
            };
            RepositoryProjectIdentityEntry {
                folder_id,
                path,
                status,
                identity,
            }
        }
    }))
    .await)
}

async fn inspect_path(
    path: &str,
    context: &ProbeContext<'_>,
) -> Result<Option<RepositoryProjectIdentity>, ()> {
    let _permit = timeout_at(context.batch_deadline, context.slots.acquire())
        .await
        .map_err(|_| ())?
        .map_err(|_| ())?;
    let deadline = context
        .batch_deadline
        .min(Instant::now() + context.read_timeout);
    let is_repo = timeout_at(deadline, async {
        if !tokio::fs::metadata(path).await.map_err(|_| ())?.is_dir() {
            return Err(());
        }
        // Opening the directory also checks readability for authoritative absence.
        let _ = tokio::fs::read_dir(path).await.map_err(|_| ())?;
        match tokio::fs::symlink_metadata(Path::new(path).join(".git")).await {
            Ok(_) => Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(_) => Err(()),
        }
    })
    .await
    .map_err(|_| ())??;
    if !is_repo {
        return Ok(None);
    }
    let mut command = crate::process::tokio_command(context.program);
    command
        .current_dir(path)
        // Explicit git-dir prevents discovery of an ancestor, including broken .git entries.
        .args(["--git-dir=.git", "remote", "-v"])
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_COMMON_DIR")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let output = read_command(&mut command, deadline).await?;
    let output = std::str::from_utf8(&output).map_err(|_| ())?;
    Ok(select_identity(output))
}

/// Bound memory as well as time. Keep ownership of the child while waiting so
/// failures/timeouts explicitly kill and reap it; cancellation also kills on drop.
async fn read_command(
    command: &mut tokio::process::Command,
    deadline: Instant,
) -> Result<Vec<u8>, ()> {
    if Instant::now() >= deadline {
        return Err(());
    }
    let mut child = command.spawn().map_err(|_| ())?;
    let stdout = child.stdout.take().ok_or(())?;
    let mut reader = BufReader::new(stdout).take(MAX_OUTPUT_BYTES + 1);
    let mut output = Vec::new();
    let result = timeout_at(deadline, async {
        let read = async {
            reader.read_to_end(&mut output).await.map_err(|_| ())?;
            if output.len() as u64 > MAX_OUTPUT_BYTES {
                return Err(());
            }
            Ok(())
        };
        let wait = async {
            let status = child.wait().await.map_err(|_| ())?;
            if status.success() {
                Ok(())
            } else {
                Err(())
            }
        };
        tokio::try_join!(read, wait).map(|_| ())
    })
    .await;
    match result {
        Ok(Ok(())) => Ok(output),
        _ => {
            // kill() waits too. No stderr/raw remote ever reaches errors or logs.
            let _ = child.kill().await;
            let _ = child.wait().await;
            Err(())
        }
    }
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn list_repository_project_identities(
    db: tauri::State<'_, AppDatabase>,
    folder_ids: Vec<i32>,
) -> Result<Vec<RepositoryProjectIdentityEntry>, AppCommandError> {
    list_repository_project_identities_core(&db, folder_ids).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::entities::folder::{self, FolderKind};
    use crate::db::test_helpers::{fresh_in_memory_db, seed_folder};
    use sea_orm::{ActiveModelTrait, EntityTrait, IntoActiveModel, Set};

    // The saturation test deliberately holds production slots until the batch
    // deadline. Serialize other catalog tests so it cannot starve their fixtures.
    static CATALOG_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    fn git(path: &Path, args: &[&str]) {
        let output = std::process::Command::new("git")
            .current_dir(path)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git fixture failed: {:?}",
            output.status
        );
    }

    #[tokio::test]
    async fn registered_roots_forks_worktrees_and_remote_removal() {
        let _guard = CATALOG_TEST_LOCK.lock().await;
        let db = fresh_in_memory_db().await;
        let root = tempfile::tempdir().unwrap();
        let fork = tempfile::tempdir().unwrap();
        git(root.path(), &["init", "-q"]);
        git(fork.path(), &["init", "-q"]);
        git(
            root.path(),
            &["remote", "add", "origin", "https://github.com/a/fork"],
        );
        git(
            fork.path(),
            &["remote", "add", "origin", "https://github.com/b/fork"],
        );
        for path in [root.path(), fork.path()] {
            git(
                path,
                &[
                    "remote",
                    "add",
                    "upstream",
                    "git@github.com:Source/Repo.git",
                ],
            );
        }
        let root_id = seed_folder(&db, root.path().to_str().unwrap()).await;
        let fork_id = seed_folder(&db, fork.path().to_str().unwrap()).await;
        let nested = root.path().join("nested");
        std::fs::create_dir(&nested).unwrap();
        let nested_id = seed_folder(&db, nested.to_str().unwrap()).await;
        git(
            root.path(),
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.com",
                "commit",
                "--allow-empty",
                "-qm",
                "initial",
            ],
        );
        let linked = root.path().join("linked");
        git(
            root.path(),
            &["worktree", "add", "-qb", "linked", linked.to_str().unwrap()],
        );
        let linked_id = seed_folder(&db, linked.to_str().unwrap()).await;
        let entries = list_repository_project_identities_core(
            &db,
            vec![root_id, fork_id, nested_id, linked_id, root_id],
        )
        .await
        .unwrap();
        assert_eq!(entries.len(), 4);
        assert_eq!(entries[0].folder_id, root_id);
        assert_eq!(entries[0].identity, entries[1].identity);
        assert_eq!(entries[0].identity, entries[3].identity);
        assert_eq!(
            entries[0].identity.as_ref().unwrap().project_key,
            "github:source/repo"
        );
        assert_eq!(entries[2].status, RepositoryProjectIdentityStatus::Resolved);
        assert!(
            entries[2].identity.is_none(),
            "never use an ancestor repository"
        );
        git(root.path(), &["remote", "remove", "upstream"]);
        git(root.path(), &["remote", "remove", "origin"]);
        let entries = list_repository_project_identities_core(&db, vec![root_id, linked_id])
            .await
            .unwrap();
        assert!(entries.iter().all(|entry| entry.status
            == RepositoryProjectIdentityStatus::Resolved
            && entry.identity.is_none()));
    }

    #[tokio::test]
    async fn only_requested_regular_live_rows_are_probed_including_closed_roots() {
        let _guard = CATALOG_TEST_LOCK.lock().await;
        let db = fresh_in_memory_db().await;
        let dirs: Vec<_> = (0..5).map(|_| tempfile::tempdir().unwrap()).collect();
        let mut ids = Vec::new();
        for dir in &dirs {
            ids.push(seed_folder(&db, dir.path().to_str().unwrap()).await);
        }
        for (index, id) in ids.iter().enumerate().take(3) {
            let mut row = folder::Entity::find_by_id(*id)
                .one(&db.conn)
                .await
                .unwrap()
                .unwrap()
                .into_active_model();
            match index {
                0 => row.kind = Set(FolderKind::Chat),
                1 => row.deleted_at = Set(Some(chrono::Utc::now())),
                _ => row.is_open = Set(false),
            }
            row.update(&db.conn).await.unwrap();
        }
        let entries =
            list_repository_project_identities_core(&db, vec![ids[1], ids[0], -1, ids[2], ids[3]])
                .await
                .unwrap();
        for entry in &entries[..3] {
            assert_eq!(entry.status, RepositoryProjectIdentityStatus::Unavailable);
            assert!(entry.path.is_none());
        }
        assert_eq!(entries[3].status, RepositoryProjectIdentityStatus::Resolved);
        assert_eq!(entries[4].status, RepositoryProjectIdentityStatus::Resolved);
        assert_eq!(entries.len(), 5, "do not scan unrequested rows");
    }

    #[tokio::test]
    async fn empty_and_oversize_batches_do_not_access_database() {
        // A disconnected DB proves validation happens before the lookup.
        let db = AppDatabase {
            conn: sea_orm::DatabaseConnection::Disconnected,
        };
        assert!(list_repository_project_identities_core(&db, vec![])
            .await
            .unwrap()
            .is_empty());
        let error = list_repository_project_identities_core(&db, vec![1; 129])
            .await
            .unwrap_err();
        assert!(matches!(
            error.code,
            crate::app_error::AppErrorCode::InvalidInput
        ));
        let db = fresh_in_memory_db().await;
        assert_eq!(
            list_repository_project_identities_core(&db, (1..=128).collect())
                .await
                .unwrap()
                .len(),
            128
        );
    }

    #[tokio::test]
    async fn missing_paths_and_broken_git_are_unavailable_ordinary_directories_resolved() {
        let _guard = CATALOG_TEST_LOCK.lock().await;
        let db = fresh_in_memory_db().await;
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("missing");
        let broken = dir.path().join("broken");
        std::fs::create_dir(&broken).unwrap();
        std::fs::write(
            broken.join(".git"),
            "gitdir: /nonexistent/project-catalog-test",
        )
        .unwrap();
        let mut ids = Vec::new();
        for path in [missing.as_path(), broken.as_path(), dir.path()] {
            ids.push(seed_folder(&db, path.to_str().unwrap()).await);
        }
        let entries = list_repository_project_identities_core(&db, ids)
            .await
            .unwrap();
        assert_eq!(
            entries[0].status,
            RepositoryProjectIdentityStatus::Unavailable
        );
        assert_eq!(
            entries[1].status,
            RepositoryProjectIdentityStatus::Unavailable
        );
        assert_eq!(entries[2].status, RepositoryProjectIdentityStatus::Resolved);
        assert!(entries
            .iter()
            .all(|entry| entry.identity.is_none() && entry.path.is_some()));
    }

    #[tokio::test]
    async fn real_partial_clone_fetch_uses_corrected_shared_parser() {
        let _guard = CATALOG_TEST_LOCK.lock().await;
        let dir = tempfile::tempdir().unwrap();
        git(dir.path(), &["init", "-q"]);
        git(
            dir.path(),
            &[
                "remote",
                "add",
                "origin",
                "https://github.com/Team/Repo.git",
            ],
        );
        git(dir.path(), &["config", "remote.origin.promisor", "true"]);
        git(
            dir.path(),
            &["config", "remote.origin.partialclonefilter", "blob:none"],
        );
        let db = fresh_in_memory_db().await;
        let path = dir.path().to_str().unwrap();
        let id = seed_folder(&db, path).await;
        let entries = list_repository_project_identities_core(&db, vec![id])
            .await
            .unwrap();
        assert_eq!(
            entries[0].identity.as_ref().unwrap().project_key,
            "github:team/repo"
        );
        let old_remotes = crate::commands::folders::git_list_remotes(path.to_owned())
            .await
            .unwrap();
        assert_eq!(old_remotes.len(), 1);
        assert_eq!(old_remotes[0].url, "https://github.com/Team/Repo.git");
    }

    #[cfg(unix)]
    fn executable(dir: &Path, contents: &str) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join("probe");
        std::fs::write(&path, contents).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        path
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn bounded_output_nonzero_exit_and_timeout_are_failures_and_reap_children() {
        let dir = tempfile::tempdir().unwrap();
        let program = executable(dir.path(), "#!/bin/sh\nexec yes x\n");
        let mut command = crate::process::tokio_command(&program);
        command
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        assert!(
            read_command(&mut command, Instant::now() + Duration::from_secs(2))
                .await
                .is_err()
        );
        let program = executable(dir.path(), "#!/bin/sh\nexit 1\n");
        let mut command = crate::process::tokio_command(&program);
        command
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        assert!(
            read_command(&mut command, Instant::now() + Duration::from_secs(2))
                .await
                .is_err()
        );
        let pid_file = dir.path().join("pid");
        let program = executable(
            dir.path(),
            &format!(
                "#!/bin/sh\necho $$ > '{}'\nexec sleep 60\n",
                pid_file.display()
            ),
        );
        let mut command = crate::process::tokio_command(&program);
        command
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let start = Instant::now();
        assert!(read_command(&mut command, start + READ_TIMEOUT)
            .await
            .is_err());
        assert!(start.elapsed() >= Duration::from_secs(4));
        assert!(start.elapsed() < Duration::from_secs(7));
        let pid: u32 = std::fs::read_to_string(pid_file)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        #[cfg(target_os = "linux")]
        assert!(
            !Path::new(&format!("/proc/{pid}")).exists(),
            "timed out child must be reaped"
        );
        #[cfg(not(target_os = "linux"))]
        let _ = pid;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn concurrent_requests_share_four_slots_and_deadline_includes_queueing() {
        let _guard = CATALOG_TEST_LOCK.lock().await;
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join(".git")).unwrap();
        let log = dir.path().join("pids");
        let program = executable(
            dir.path(),
            &format!("#!/bin/sh\necho $$ >> '{}'\nexec sleep 60\n", log.display()),
        );
        let start = Instant::now();
        let context = ProbeContext {
            slots: &PROBE_SLOTS,
            program: program.as_os_str(),
            read_timeout: Duration::from_secs(60),
            batch_deadline: start + BATCH_TIMEOUT,
        };
        let path = dir.path().to_str().unwrap();
        let first_request = join_all((0..6).map(|_| inspect_path(path, &context)));
        let second_request = join_all((0..6).map(|_| inspect_path(path, &context)));
        let (first, second, ()) = tokio::join!(first_request, second_request, async {
            tokio::time::sleep(Duration::from_millis(200)).await;
            let started = std::fs::read_to_string(&log).unwrap().lines().count();
            assert!(
                started > 0 && started <= 4,
                "process-global maximum is four: {started}"
            );
        });
        assert!(first
            .into_iter()
            .chain(second)
            .all(|result| result.is_err()));
        assert!(
            start.elapsed() >= Duration::from_secs(24) && start.elapsed() < Duration::from_secs(28),
            "queueing must obey batch deadline"
        );
        let pids = std::fs::read_to_string(log).unwrap();
        assert!(
            pids.lines().count() <= 4,
            "queued probes must not spawn after deadline"
        );
        #[cfg(target_os = "linux")]
        for pid in pids.lines() {
            assert!(!Path::new(&format!("/proc/{pid}")).exists());
        }
    }
}
