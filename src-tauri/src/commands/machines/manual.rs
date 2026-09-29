//! Persistent manual-machine metadata and separate credential storage.
use std::sync::OnceLock;

use sea_orm::DatabaseConnection;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use uuid::Uuid;

use super::{validate_ssh_host, validate_ssh_user, Machine};
use crate::app_error::AppCommandError;
use crate::db::service::app_metadata_service;

const MANUAL_MACHINES_KEY: &str = "machines.manual.v1";
static WRITE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

// Deliberately neither Debug nor Serialize: request passwords must not enter
// logs, public inventory, database metadata, or conversation snapshots.
#[derive(Clone, Deserialize)]
pub struct ManualMachineInput {
    pub id: Option<String>,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: Option<String>,
    #[serde(default)]
    pub auth_method: AuthMethod,
    pub private_key: Option<String>,
    pub passphrase: Option<String>,
    pub jump_host: Option<JumpHostInput>,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AuthMethod {
    #[default]
    Password,
    PrivateKey,
}

#[derive(Clone, Deserialize)]
pub struct JumpHostInput {
    pub host: String,
    pub port: u16,
    pub username: String,
    #[serde(default)]
    pub auth_method: AuthMethod,
    pub password: Option<String>,
    pub private_key: Option<String>,
    pub passphrase: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct JumpHost {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: AuthMethod,
}

// Secret types deliberately do not implement Debug.
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "method", rename_all = "snake_case")]
pub(super) enum Credential {
    Password {
        password: String,
    },
    PrivateKey {
        private_key: String,
        passphrase: String,
    },
}

#[derive(Serialize, Deserialize)]
pub(super) struct Credentials {
    pub target: Credential,
    pub jump: Option<Credential>,
}

impl Credentials {
    pub fn redact(&self, text: &str) -> String {
        let mut result = text.to_string();
        for credential in std::iter::once(&self.target).chain(self.jump.iter()) {
            let values = match credential {
                Credential::Password { password } => vec![password.as_str()],
                Credential::PrivateKey {
                    private_key,
                    passphrase,
                } => vec![private_key.as_str(), passphrase.as_str()],
            };
            for value in values.into_iter().filter(|value| !value.is_empty()) {
                result = result.replace(value, "[redacted]");
            }
        }
        result
    }
}

fn validate_endpoint(
    host: &mut String,
    port: u16,
    username: &mut String,
) -> Result<(), AppCommandError> {
    let trimmed = host.trim();
    let unbracketed = trimmed
        .strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
        .unwrap_or(trimmed);
    *host = unbracketed
        .parse::<std::net::IpAddr>()
        .map(|ip| ip.to_string())
        .unwrap_or_else(|_| unbracketed.to_ascii_lowercase());
    validate_ssh_host(host)?;
    if port == 0 {
        return Err(AppCommandError::invalid_input(
            "SSH port must be between 1 and 65535",
        ));
    }
    *username = username.trim().to_string();
    validate_ssh_user(username)
}

fn validate_auth(
    method: AuthMethod,
    password: Option<&str>,
    key: Option<&str>,
    passphrase: Option<&str>,
) -> Result<(), AppCommandError> {
    for value in [password, passphrase].into_iter().flatten() {
        if value.len() > 4096 || value.contains(['\0', '\r', '\n']) {
            return Err(AppCommandError::invalid_input(
                "Password or passphrase must be at most 4096 bytes without null bytes or newlines",
            ));
        }
    }
    if method == AuthMethod::Password && password == Some("") {
        return Err(AppCommandError::invalid_input("Password must not be empty"));
    }
    if let Some(key) = key {
        let size = key.len();
        let key = key.trim();
        let valid_format = [
            "OPENSSH PRIVATE KEY",
            "RSA PRIVATE KEY",
            "EC PRIVATE KEY",
            "DSA PRIVATE KEY",
            "PRIVATE KEY",
            "ENCRYPTED PRIVATE KEY",
        ]
        .iter()
        .any(|label| {
            key.starts_with(&format!("-----BEGIN {label}-----"))
                && key.ends_with(&format!("-----END {label}-----"))
        });
        if size > 64 * 1024 || key.contains('\0') || !valid_format {
            return Err(AppCommandError::invalid_input("Enter an OpenSSH or PEM private key (at most 64 KiB), not a public key or a file path"));
        }
    }
    Ok(())
}

fn merge_credential(
    method: AuthMethod,
    password: Option<String>,
    private_key: Option<String>,
    passphrase: Option<String>,
    previous: Option<&Credential>,
) -> Result<Credential, AppCommandError> {
    match method {
        AuthMethod::Password => {
            let password = password
                .or_else(|| match previous {
                    Some(Credential::Password { password }) => Some(password.clone()),
                    _ => None,
                })
                .ok_or_else(|| {
                    AppCommandError::invalid_input("Enter a password for this SSH connection")
                })?;
            Ok(Credential::Password { password })
        }
        AuthMethod::PrivateKey => {
            let replacing = private_key.is_some();
            let (old_key, old_passphrase) = match previous {
                Some(Credential::PrivateKey {
                    private_key,
                    passphrase,
                }) => (Some(private_key.clone()), passphrase.clone()),
                _ => (None, String::new()),
            };
            let private_key = private_key.or(old_key).ok_or_else(|| {
                AppCommandError::invalid_input("Enter a private key for this SSH connection")
            })?;
            // Replacing the key resets its passphrase unless a new one is supplied.
            let passphrase = passphrase.unwrap_or(if replacing {
                String::new()
            } else {
                old_passphrase
            });
            Ok(Credential::PrivateKey {
                private_key,
                passphrase,
            })
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
struct Record {
    id: String,
    name: String,
    host: String,
    port: u16,
    username: String,
    #[serde(default)]
    auth_method: AuthMethod,
    #[serde(default)]
    jump_host: Option<JumpHost>,
    #[serde(default)]
    credentials_version: u8,
}

impl Record {
    fn machine(&self) -> Machine {
        Machine {
            id: self.id.clone(),
            name: self.name.clone(),
            dns_name: String::new(),
            addresses: vec![self.host.clone()],
            os: String::new(),
            online: None,
            last_seen: None,
            is_self: false,
            source: "manual".into(),
            ssh_port: self.port,
            ssh_user: Some(self.username.clone()),
            auth_method: Some(self.auth_method),
            jump_host: self.jump_host.clone(),
        }
    }
}

impl ManualMachineInput {
    fn validate(mut self) -> Result<Self, AppCommandError> {
        if let Some(id) = &self.id {
            validate_id(id)?;
        }
        self.name = self.name.trim().into();
        if self.name.is_empty() || self.name.len() > 128 || self.name.chars().any(char::is_control)
        {
            return Err(AppCommandError::invalid_input(
                "Machine name must contain 1–128 characters without control characters",
            ));
        }
        validate_endpoint(&mut self.host, self.port, &mut self.username)?;
        validate_auth(
            self.auth_method,
            self.password.as_deref(),
            self.private_key.as_deref(),
            self.passphrase.as_deref(),
        )?;
        if self.id.is_none() {
            merge_credential(
                self.auth_method,
                self.password.clone(),
                self.private_key.clone(),
                self.passphrase.clone(),
                None,
            )?;
        }
        if let Some(jump) = &mut self.jump_host {
            validate_endpoint(&mut jump.host, jump.port, &mut jump.username)?;
            validate_auth(
                jump.auth_method,
                jump.password.as_deref(),
                jump.private_key.as_deref(),
                jump.passphrase.as_deref(),
            )?;
        }
        Ok(self)
    }
}

fn validate_id(id: &str) -> Result<(), AppCommandError> {
    if id
        .strip_prefix("manual:")
        .is_none_or(|value| Uuid::parse_str(value).is_err())
    {
        return Err(AppCommandError::invalid_input("Invalid manual machine ID"));
    }
    Ok(())
}

fn secret_name(id: &str) -> String {
    format!("machine-password:{id}")
}

trait SecretStore {
    fn get(&self, key: &str) -> Result<Option<String>, AppCommandError>;
    fn set(&self, key: &str, value: &str) -> Result<(), AppCommandError>;
    fn delete(&self, key: &str) -> Result<(), AppCommandError>;
}

struct NativeSecrets;
impl SecretStore for NativeSecrets {
    fn get(&self, key: &str) -> Result<Option<String>, AppCommandError> {
        crate::keyring_store::get_secret(key)
            .map_err(|_| AppCommandError::io_error("Could not read saved machine credentials"))
    }
    fn set(&self, key: &str, value: &str) -> Result<(), AppCommandError> {
        crate::keyring_store::set_secret(key, value)
            .map_err(|_| AppCommandError::io_error("Could not save machine credentials"))
    }
    fn delete(&self, key: &str) -> Result<(), AppCommandError> {
        crate::keyring_store::delete_secret(key)
            .map_err(|_| AppCommandError::io_error("Could not remove saved machine credentials"))
    }
}

async fn load(conn: &DatabaseConnection) -> Result<Vec<Record>, AppCommandError> {
    let Some(raw) = app_metadata_service::get_value(conn, MANUAL_MACHINES_KEY)
        .await
        .map_err(AppCommandError::db)?
    else {
        return Ok(Vec::new());
    };
    serde_json::from_str(&raw)
        .map_err(|_| AppCommandError::database_error("Stored manual machines are invalid"))
}

async fn persist(conn: &DatabaseConnection, records: &[Record]) -> Result<(), AppCommandError> {
    let raw = serde_json::to_string(records)
        .map_err(|_| AppCommandError::database_error("Could not encode manual machines"))?;
    app_metadata_service::upsert_value(conn, MANUAL_MACHINES_KEY, &raw)
        .await
        .map_err(AppCommandError::db)
}

pub(super) async fn list(conn: &DatabaseConnection) -> Result<Vec<Machine>, AppCommandError> {
    let _guard = WRITE_LOCK.get_or_init(|| Mutex::new(())).lock().await;
    Ok(load(conn).await?.iter().map(Record::machine).collect())
}

pub(super) async fn resolve(
    conn: &DatabaseConnection,
    id: &str,
    ssh_user: Option<&str>,
) -> Result<(Machine, Credentials), AppCommandError> {
    validate_id(id)?;
    let _guard = WRITE_LOCK.get_or_init(|| Mutex::new(())).lock().await;
    let record = load(conn)
        .await?
        .into_iter()
        .find(|record| record.id == id)
        .ok_or_else(|| AppCommandError::not_found("Manual machine was not found"))?;
    if ssh_user.is_some_and(|user| user != record.username) {
        return Err(AppCommandError::invalid_input(
            "Edit the machine to change its saved SSH username",
        ));
    }
    let raw = NativeSecrets.get(&secret_name(id))?.ok_or_else(|| {
        AppCommandError::not_found(
            "Saved credentials are missing; edit the machine to set them again",
        )
    })?;
    let credentials = decode_credentials(&record, &raw)?;
    Ok((record.machine(), credentials))
}

fn decode_credentials(record: &Record, raw: &str) -> Result<Credentials, AppCommandError> {
    if record.credentials_version < 2 {
        Ok(Credentials {
            target: Credential::Password {
                password: raw.to_string(),
            },
            jump: None,
        })
    } else {
        serde_json::from_str(raw).map_err(|_| {
            AppCommandError::io_error("Saved machine credentials are invalid; enter them again")
        })
    }
}

pub async fn save_manual_machine_core(
    conn: &DatabaseConnection,
    input: ManualMachineInput,
) -> Result<Machine, AppCommandError> {
    // Finish the metadata/credential pair even if the HTTP client disconnects.
    let conn = conn.clone();
    tokio::spawn(async move { save_with_store(&conn, input, &NativeSecrets).await })
        .await
        .map_err(|_| AppCommandError::task_execution_failed("Machine save failed"))?
}

async fn save_with_store(
    conn: &DatabaseConnection,
    input: ManualMachineInput,
    secrets: &(impl SecretStore + Sync),
) -> Result<Machine, AppCommandError> {
    let input = input.validate()?;
    let _guard = WRITE_LOCK.get_or_init(|| Mutex::new(())).lock().await;
    let mut records = load(conn).await?;
    let index = if let Some(id) = &input.id {
        Some(
            records
                .iter()
                .position(|record| &record.id == id)
                .ok_or_else(|| AppCommandError::not_found("Manual machine was not found"))?,
        )
    } else {
        None
    };
    let jump_host = input.jump_host.as_ref().map(|jump| JumpHost {
        host: jump.host.clone(),
        port: jump.port,
        username: jump.username.clone(),
        auth_method: jump.auth_method,
    });
    if records.iter().any(|record| {
        Some(&record.id) != input.id.as_ref()
            && record.host == input.host
            && record.port == input.port
            && record.username == input.username
            && record
                .jump_host
                .as_ref()
                .map(|jump| (&jump.host, jump.port, &jump.username))
                == jump_host
                    .as_ref()
                    .map(|jump| (&jump.host, jump.port, &jump.username))
    }) {
        return Err(AppCommandError::already_exists(
            "A machine with this host, port, SSH user and jump host already exists",
        ));
    }
    let record = Record {
        id: input
            .id
            .unwrap_or_else(|| format!("manual:{}", Uuid::new_v4())),
        name: input.name,
        host: input.host,
        port: input.port,
        username: input.username,
        auth_method: input.auth_method,
        jump_host,
        credentials_version: 2,
    };
    let key = secret_name(&record.id);
    let previous = secrets.get(&key)?;
    let old_record = index.map(|index| &records[index]);
    let old_credentials = old_record
        .zip(previous.as_deref())
        .map(|(record, raw)| decode_credentials(record, raw))
        .transpose()?;
    let target = merge_credential(
        input.auth_method,
        input.password,
        input.private_key,
        input.passphrase,
        old_credentials.as_ref().map(|value| &value.target),
    )?;
    let jump = input
        .jump_host
        .map(|jump| {
            let same_endpoint = old_record
                .and_then(|r| r.jump_host.as_ref())
                .is_some_and(|old| {
                    old.host == jump.host && old.port == jump.port && old.username == jump.username
                });
            let previous_jump = if same_endpoint {
                old_credentials.as_ref().and_then(|c| c.jump.as_ref())
            } else {
                None
            };
            merge_credential(
                jump.auth_method,
                jump.password,
                jump.private_key,
                jump.passphrase,
                previous_jump,
            )
        })
        .transpose()?;
    let encoded = serde_json::to_string(&Credentials { target, jump })
        .map_err(|_| AppCommandError::io_error("Could not encode SSH credentials"))?;
    secrets.set(&key, &encoded)?;
    let machine = record.machine();
    if let Some(index) = index {
        records[index] = record;
    } else {
        records.push(record);
    }
    if let Err(error) = persist(conn, &records).await {
        restore_secret(secrets, &key, previous.as_deref())?;
        return Err(error);
    }
    Ok(machine)
}

pub async fn delete_manual_machine_core(
    conn: &DatabaseConnection,
    machine_id: String,
) -> Result<(), AppCommandError> {
    let conn = conn.clone();
    tokio::spawn(async move { delete_with_store(&conn, &machine_id, &NativeSecrets).await })
        .await
        .map_err(|_| AppCommandError::task_execution_failed("Machine removal failed"))?
}

async fn delete_with_store(
    conn: &DatabaseConnection,
    id: &str,
    secrets: &(impl SecretStore + Sync),
) -> Result<(), AppCommandError> {
    validate_id(id)?;
    let _guard = WRITE_LOCK.get_or_init(|| Mutex::new(())).lock().await;
    let mut records = load(conn).await?;
    let index = records
        .iter()
        .position(|record| record.id == id)
        .ok_or_else(|| AppCommandError::not_found("Manual machine was not found"))?;
    let key = secret_name(id);
    let previous = secrets.get(&key)?;
    // Keep the record if credential deletion fails, making retry possible.
    secrets.delete(&key)?;
    records.remove(index);
    if let Err(error) = persist(conn, &records).await {
        restore_secret(secrets, &key, previous.as_deref())?;
        return Err(error);
    }
    Ok(())
}

fn restore_secret(
    secrets: &impl SecretStore,
    key: &str,
    previous: Option<&str>,
) -> Result<(), AppCommandError> {
    let result = match previous {
        Some(value) => secrets.set(key, value),
        None => secrets.delete(key),
    };
    result.map_err(|_| AppCommandError::io_error("Machine metadata could not be saved and credential rollback failed; check saved credentials before retrying"))
}

#[cfg(test)]
#[path = "manual_tests.rs"]
mod tests;
