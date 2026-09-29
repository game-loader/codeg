use super::*;
use sea_orm::{ConnectionTrait, Database, DbBackend, Schema, Statement};
use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Default)]
struct MemorySecrets {
    values: Mutex<HashMap<String, String>>,
    fail_delete: bool,
}

impl SecretStore for MemorySecrets {
    fn get(&self, key: &str) -> Result<Option<String>, AppCommandError> {
        Ok(self.values.lock().unwrap().get(key).cloned())
    }
    fn set(&self, key: &str, value: &str) -> Result<(), AppCommandError> {
        self.values.lock().unwrap().insert(key.into(), value.into());
        Ok(())
    }
    fn delete(&self, key: &str) -> Result<(), AppCommandError> {
        if self.fail_delete {
            return Err(AppCommandError::io_error(
                "Simulated unavailable credentials",
            ));
        }
        self.values.lock().unwrap().remove(key);
        Ok(())
    }
}

async fn database() -> DatabaseConnection {
    let conn = Database::connect("sqlite::memory:").await.unwrap();
    let builder = DbBackend::Sqlite;
    let table =
        Schema::new(builder).create_table_from_entity(crate::db::entities::app_metadata::Entity);
    conn.execute(builder.build(&table)).await.unwrap();
    conn
}

fn input() -> ManualMachineInput {
    ManualMachineInput {
        id: None,
        name: " Rented GPU ".into(),
        host: " 203.0.113.8 ".into(),
        port: 2200,
        username: " root ".into(),
        password: Some("test-secret value".into()),
        auth_method: AuthMethod::Password,
        private_key: None,
        passphrase: None,
        jump_host: None,
    }
}

#[test]
fn input_validates_host_port_and_password_protocol() {
    let value = input().validate().unwrap();
    assert_eq!(value.name, "Rented GPU");
    assert_eq!(value.host, "203.0.113.8");
    assert_eq!(value.username, "root");
    for host in ["bad host", "-oProxyCommand=id", "127.0.0.1;id"] {
        assert!(ManualMachineInput {
            host: host.into(),
            ..input()
        }
        .validate()
        .is_err());
    }
    assert!(ManualMachineInput {
        host: "2001:db8::1".into(),
        ..input()
    }
    .validate()
    .is_ok());
    assert!(ManualMachineInput { port: 0, ..input() }
        .validate()
        .is_err());
    for password in ["", "two\nlines", "cr\rvalue", "zero\0byte"] {
        assert!(ManualMachineInput {
            password: Some(password.into()),
            ..input()
        }
        .validate()
        .is_err());
    }
    assert!(ManualMachineInput {
        password: None,
        ..input()
    }
    .validate()
    .is_err());
    assert!(ManualMachineInput {
        username: "root;id".into(),
        ..input()
    }
    .validate()
    .is_err());
}

#[tokio::test]
async fn create_edit_delete_preserve_secrets_outside_metadata() {
    let conn = database().await;
    let secrets = MemorySecrets::default();
    let machine = save_with_store(&conn, input(), &secrets).await.unwrap();
    assert!(machine.id.starts_with("manual:"));
    assert_eq!(machine.source, "manual");
    assert_eq!(machine.ssh_port, 2200);
    assert_eq!(machine.online, None);
    let json = serde_json::to_string(&machine).unwrap();
    assert!(!json.contains("\"password\":"));
    assert!(!json.contains("test-secret"));
    let metadata = app_metadata_service::get_value(&conn, MANUAL_MACHINES_KEY)
        .await
        .unwrap()
        .unwrap();
    assert!(!metadata.contains("\"password\":"));
    assert!(!metadata.contains("test-secret"));
    let updated = save_with_store(
        &conn,
        ManualMachineInput {
            id: Some(machine.id.clone()),
            port: 2222,
            password: None,
            ..input()
        },
        &secrets,
    )
    .await
    .unwrap();
    assert_eq!(updated.id, machine.id);
    assert_eq!(updated.ssh_port, 2222);
    assert_eq!(saved_password(&secrets, &machine.id), "test-secret value");
    assert_eq!(list(&conn).await.unwrap(), vec![updated]);
    delete_with_store(&conn, &machine.id, &secrets)
        .await
        .unwrap();
    assert!(list(&conn).await.unwrap().is_empty());
    assert!(secrets.values.lock().unwrap().is_empty());
}

#[tokio::test]
async fn failed_credential_removal_keeps_machine_record() {
    let conn = database().await;
    let secrets = MemorySecrets {
        fail_delete: true,
        ..Default::default()
    };
    let machine = save_with_store(&conn, input(), &secrets).await.unwrap();
    assert!(delete_with_store(&conn, &machine.id, &secrets)
        .await
        .is_err());
    assert_eq!(list(&conn).await.unwrap(), vec![machine]);
    assert_eq!(secrets.values.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn database_failure_rolls_back_password_changes_and_deletions() {
    let conn = database().await;
    let secrets = MemorySecrets::default();
    let machine = save_with_store(&conn, input(), &secrets).await.unwrap();
    conn.execute(Statement::from_string(DbBackend::Sqlite,
        "CREATE TRIGGER fail_machine_write BEFORE UPDATE ON app_metadata BEGIN SELECT RAISE(FAIL, 'simulated'); END;".to_string()
    )).await.unwrap();
    assert!(save_with_store(
        &conn,
        ManualMachineInput {
            id: Some(machine.id.clone()),
            password: Some("new-secret".into()),
            ..input()
        },
        &secrets
    )
    .await
    .is_err());
    assert_eq!(saved_password(&secrets, &machine.id), "test-secret value");
    assert!(delete_with_store(&conn, &machine.id, &secrets)
        .await
        .is_err());
    assert_eq!(list(&conn).await.unwrap(), vec![machine.clone()]);
    assert_eq!(saved_password(&secrets, &machine.id), "test-secret value");
    assert!(save_with_store(
        &conn,
        ManualMachineInput {
            host: "203.0.113.9".into(),
            ..input()
        },
        &secrets
    )
    .await
    .is_err());
    assert_eq!(secrets.values.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn concurrent_creates_do_not_lose_records() {
    let conn = database().await;
    let secrets = MemorySecrets::default();
    let (one, two) = tokio::join!(
        save_with_store(&conn, input(), &secrets),
        save_with_store(
            &conn,
            ManualMachineInput {
                host: "203.0.113.9".into(),
                ..input()
            },
            &secrets
        ),
    );
    assert!(one.is_ok());
    assert!(two.is_ok());
    assert_eq!(list(&conn).await.unwrap().len(), 2);
}

#[tokio::test]
async fn manual_probe_rejects_username_override_before_accessing_credentials() {
    let conn = database().await;
    let secrets = MemorySecrets::default();
    let machine = save_with_store(&conn, input(), &secrets).await.unwrap();
    let error = resolve(&conn, &machine.id, Some("otheruser"))
        .await
        .err()
        .unwrap();
    assert!(error.message.contains("saved SSH username"));
}

#[tokio::test]
async fn corrupt_storage_is_not_silently_replaced_and_nonmanual_ids_are_rejected() {
    let conn = database().await;
    let secrets = MemorySecrets::default();
    app_metadata_service::upsert_value(&conn, MANUAL_MACHINES_KEY, "invalid")
        .await
        .unwrap();
    assert!(list(&conn).await.is_err());
    assert!(save_with_store(&conn, input(), &secrets).await.is_err());
    assert!(delete_with_store(&conn, "tailscale-id", &secrets)
        .await
        .is_err());
    assert!(secrets.values.lock().unwrap().is_empty());
}

fn saved_password(secrets: &MemorySecrets, id: &str) -> String {
    let raw = secrets.get(&secret_name(id)).unwrap().unwrap();
    let value: Credentials = serde_json::from_str(&raw).unwrap();
    match value.target {
        Credential::Password { password } => password,
        _ => panic!("expected password"),
    }
}

const TEST_KEY: &str = "-----BEGIN OPENSSH PRIVATE KEY-----\nfixture-only-private-key\n-----END OPENSSH PRIVATE KEY-----";

fn key_input() -> ManualMachineInput {
    ManualMachineInput {
        auth_method: AuthMethod::PrivateKey,
        password: None,
        private_key: Some(TEST_KEY.into()),
        passphrase: Some("key-secret".into()),
        jump_host: Some(JumpHostInput {
            host: "bastion.example.com".into(),
            port: 2222,
            username: "jump".into(),
            auth_method: AuthMethod::Password,
            password: Some("jump-secret".into()),
            private_key: None,
            passphrase: None,
        }),
        ..input()
    }
}

#[tokio::test]
async fn keys_and_jump_credentials_stay_private_and_survive_blank_edits() {
    let conn = database().await;
    let secrets = MemorySecrets::default();
    let machine = save_with_store(&conn, key_input(), &secrets).await.unwrap();
    assert_eq!(machine.auth_method, Some(AuthMethod::PrivateKey));
    assert_eq!(
        machine.jump_host.as_ref().unwrap().host,
        "bastion.example.com"
    );
    let metadata = app_metadata_service::get_value(&conn, MANUAL_MACHINES_KEY)
        .await
        .unwrap()
        .unwrap();
    for public in [metadata, serde_json::to_string(&machine).unwrap()] {
        for secret in [TEST_KEY, "key-secret", "jump-secret", "passphrase"] {
            assert!(!public.contains(secret));
        }
    }
    let mut edit = key_input();
    edit.id = Some(machine.id.clone());
    edit.private_key = None;
    edit.passphrase = None;
    edit.jump_host.as_mut().unwrap().password = None;
    let previous = secrets.get(&secret_name(&machine.id)).unwrap();
    save_with_store(&conn, edit.clone(), &secrets)
        .await
        .unwrap();
    assert_eq!(previous, secrets.get(&secret_name(&machine.id)).unwrap());
    // A different bastion must not silently receive the old bastion password.
    edit.jump_host.as_mut().unwrap().host = "other.example.com".into();
    assert!(save_with_store(&conn, edit, &secrets).await.is_err());
    let mut edit = key_input();
    edit.id = Some(machine.id.clone());
    edit.passphrase = None;
    edit.jump_host = None;
    save_with_store(&conn, edit, &secrets).await.unwrap();
    let raw = secrets.get(&secret_name(&machine.id)).unwrap().unwrap();
    let credentials: Credentials = serde_json::from_str(&raw).unwrap();
    assert!(credentials.jump.is_none());
    assert!(
        matches!(credentials.target, Credential::PrivateKey { passphrase, .. } if passphrase.is_empty())
    );
    assert!(!raw.contains("jump-secret"));
    delete_with_store(&conn, &machine.id, &secrets)
        .await
        .unwrap();
    assert!(secrets.values.lock().unwrap().is_empty());
}

#[tokio::test]
async fn legacy_password_records_migrate_without_losing_credentials() {
    let conn = database().await;
    let secrets = MemorySecrets::default();
    let id = format!("manual:{}", Uuid::new_v4());
    let raw = serde_json::json!([{ "id": id, "name": "old", "host": "203.0.113.8", "port": 22, "username": "root" }]).to_string();
    app_metadata_service::upsert_value(&conn, MANUAL_MACHINES_KEY, &raw)
        .await
        .unwrap();
    // Even a legacy password that looks like JSON must remain a password.
    secrets.set(&secret_name(&id), "{legacy-password}").unwrap();
    let record = load(&conn).await.unwrap().remove(0);
    let decoded = decode_credentials(&record, "{legacy-password}").unwrap();
    assert!(
        matches!(decoded.target, Credential::Password { password } if password == "{legacy-password}")
    );
    save_with_store(
        &conn,
        ManualMachineInput {
            id: Some(id.clone()),
            password: None,
            ..input()
        },
        &secrets,
    )
    .await
    .unwrap();
    assert_eq!(saved_password(&secrets, &id), "{legacy-password}");
    assert_eq!(load(&conn).await.unwrap()[0].credentials_version, 2);
    // Changing method requires a credential for that method.
    assert!(save_with_store(
        &conn,
        ManualMachineInput {
            id: Some(id),
            auth_method: AuthMethod::PrivateKey,
            private_key: None,
            ..input()
        },
        &secrets
    )
    .await
    .is_err());
}

#[test]
fn validates_private_key_format_and_rejects_secret_control_characters() {
    for key in [
        "/home/user/.ssh/id_ed25519",
        "ssh-ed25519 public",
        "invalid",
    ] {
        assert!(ManualMachineInput {
            private_key: Some(key.into()),
            ..key_input()
        }
        .validate()
        .is_err());
    }
    assert!(ManualMachineInput {
        passphrase: Some("bad\nphrase".into()),
        ..key_input()
    }
    .validate()
    .is_err());
    for host in ["example.com", "[::1]", "2001:db8::1"] {
        assert!(ManualMachineInput {
            host: host.into(),
            ..key_input()
        }
        .validate()
        .is_ok());
    }
}
