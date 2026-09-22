//! Persistent manual-machine metadata and separate credential storage.
use std::sync::OnceLock;

use sea_orm::DatabaseConnection;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use uuid::Uuid;

use super::{validate_ssh_user, Machine};
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
}

#[derive(Clone, Serialize, Deserialize)]
struct Record {
    id: String,
    name: String,
    host: String,
    port: u16,
    username: String,
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
        self.host = self
            .host
            .trim()
            .parse::<std::net::IpAddr>()
            .map_err(|_| {
                AppCommandError::invalid_input(
                    "Machine host must be a literal IPv4 or IPv6 address",
                )
            })?
            .to_string();
        if self.port == 0 {
            return Err(AppCommandError::invalid_input(
                "SSH port must be between 1 and 65535",
            ));
        }
        self.username = self.username.trim().into();
        validate_ssh_user(&self.username)?;
        match &self.password {
            Some(password)
                if password.is_empty()
                    || password.len() > 4096
                    || password.contains(['\0', '\r', '\n']) =>
            {
                return Err(AppCommandError::invalid_input(
                    "Password must contain 1–4096 bytes without null bytes or newlines",
                ));
            }
            None if self.id.is_none() => {
                return Err(AppCommandError::invalid_input(
                    "Password is required for a new machine",
                ))
            }
            _ => {}
        }
        Ok(self)
    }
}

fn validate_id(id: &str) -> Result<(), AppCommandError> {
    if !id
        .strip_prefix("manual:")
        .is_some_and(|value| Uuid::parse_str(value).is_ok())
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
            .map_err(|_| AppCommandError::io_error("Could not read saved machine password"))
    }
    fn set(&self, key: &str, value: &str) -> Result<(), AppCommandError> {
        crate::keyring_store::set_secret(key, value)
            .map_err(|_| AppCommandError::io_error("Could not save machine password"))
    }
    fn delete(&self, key: &str) -> Result<(), AppCommandError> {
        crate::keyring_store::delete_secret(key)
            .map_err(|_| AppCommandError::io_error("Could not remove saved machine password"))
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
) -> Result<(Machine, String), AppCommandError> {
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
    let password = NativeSecrets.get(&secret_name(id))?.ok_or_else(|| {
        AppCommandError::not_found(
            "Saved machine password is missing; edit the machine to set it again",
        )
    })?;
    Ok((record.machine(), password))
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
    if records.iter().any(|record| {
        Some(&record.id) != input.id.as_ref()
            && record.host == input.host
            && record.port == input.port
            && record.username == input.username
    }) {
        return Err(AppCommandError::already_exists(
            "A machine with this IP, port and SSH user already exists",
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
    };
    let key = secret_name(&record.id);
    let previous = secrets.get(&key)?;
    if input.password.is_none() && previous.is_none() {
        return Err(AppCommandError::invalid_input(
            "Saved password is missing; enter a password",
        ));
    }
    if let Some(password) = &input.password {
        secrets.set(&key, password)?;
    }
    let machine = record.machine();
    if let Some(index) = index {
        records[index] = record;
    } else {
        records.push(record);
    }
    if let Err(error) = persist(conn, &records).await {
        if input.password.is_some() {
            restore_secret(secrets, &key, previous.as_deref())?;
        }
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
    result.map_err(|_| AppCommandError::io_error("Machine metadata could not be saved and password rollback failed; check saved credentials before retrying"))
}

#[cfg(test)]
#[path = "manual_tests.rs"]
mod tests;
