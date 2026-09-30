use std::time::Duration;

use sea_orm::{ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::app_error::{AppCommandError, AppErrorCode};
use crate::db::entities::app_metadata;
use crate::db::service::app_metadata_service;

const DEVICE_KEY_PREFIX: &str = "bark_notification_device:";
pub(super) const PREVIEW_CHARS: usize = 300;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct BarkSettings {
    pub enabled: bool,
    pub push_url: String,
    pub include_preview: bool,
    pub language: String,
    pub server_url: String,
    pub source_name: String,
}

impl Default for BarkSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            push_url: String::new(),
            include_preview: false,
            language: "en".into(),
            server_url: String::new(),
            source_name: String::new(),
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BarkDevice {
    pub device_id: String,
    pub settings: BarkSettings,
}

pub(super) fn device_id(id: &str) -> Result<String, AppCommandError> {
    Uuid::parse_str(id)
        .map(|id| id.to_string())
        .map_err(|_| AppCommandError::invalid_input("Invalid notification device ID"))
}

pub(super) fn push_endpoint(input: &str) -> Result<(reqwest::Url, String), AppCommandError> {
    let invalid = || {
        AppCommandError::invalid_input(
            "Use a Bark device URL containing only the server address and device key",
        )
    };
    let mut url = reqwest::Url::parse(input.trim()).map_err(|_| invalid())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || input.len() > 2048
    {
        return Err(invalid());
    }
    let path = url.path().trim_end_matches('/').to_string();
    url.set_path(&path);
    let parts: Vec<_> = url.path_segments().ok_or_else(invalid)?.collect();
    if parts.is_empty()
        || parts.iter().any(|part| part.is_empty())
        || (url.host_str() == Some("api.day.app") && parts.len() != 1)
    {
        return Err(invalid());
    }
    let key = urlencoding::decode(parts.last().ok_or_else(invalid)?)
        .map_err(|_| invalid())?
        .into_owned();
    if key.is_empty()
        || key == "push"
        || !key
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
    {
        return Err(invalid());
    }
    // The pasted device URL is converted to Bark's JSON /push endpoint,
    // preserving an optional reverse-proxy path prefix.
    url.path_segments_mut()
        .map_err(|_| invalid())?
        .pop()
        .push("push");
    Ok((url, key))
}

fn normalize(mut settings: BarkSettings) -> Result<BarkSettings, AppCommandError> {
    settings.source_name = settings.source_name.trim().to_string();
    if settings.source_name.chars().count() > 80
        || settings.source_name.chars().any(char::is_control)
    {
        return Err(AppCommandError::invalid_input(
            "Notification source name must be at most 80 characters on one line",
        ));
    }
    settings.push_url = settings.push_url.trim().trim_end_matches('/').to_string();
    if settings.enabled && settings.push_url.is_empty() {
        return Err(AppCommandError::invalid_input(
            "A Bark device URL is required",
        ));
    }
    if !settings.push_url.is_empty() {
        push_endpoint(&settings.push_url)?;
    }
    if !matches!(settings.language.as_str(), "en" | "zh-Hans") {
        return Err(AppCommandError::invalid_input(
            "Unsupported notification language",
        ));
    }
    settings.server_url = settings.server_url.trim().trim_end_matches('/').to_string();
    if !settings.server_url.is_empty() {
        let url = reqwest::Url::parse(&settings.server_url)
            .map_err(|_| AppCommandError::invalid_input("Invalid Codeg server address"))?;
        if !matches!(url.scheme(), "http" | "https")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(AppCommandError::invalid_input(
                "Invalid Codeg server address",
            ));
        }
    }
    Ok(settings)
}

pub async fn load_settings(
    db: &DatabaseConnection,
    id: &str,
) -> Result<BarkSettings, AppCommandError> {
    let id = device_id(id)?;
    match app_metadata_service::get_value(db, &format!("{DEVICE_KEY_PREFIX}{id}")).await? {
        Some(value) => serde_json::from_str(&value).map_err(|_| {
            AppCommandError::new(
                AppErrorCode::ConfigurationInvalid,
                "Cannot read Bark notification settings",
            )
        }),
        None => Ok(BarkSettings::default()),
    }
}

pub async fn save_settings(
    db: &DatabaseConnection,
    id: &str,
    settings: BarkSettings,
) -> Result<BarkSettings, AppCommandError> {
    let id = device_id(id)?;
    let settings = normalize(settings)?;
    let json = serde_json::to_string(&settings).map_err(|_| {
        AppCommandError::invalid_input("Cannot serialize Bark notification settings")
    })?;
    app_metadata_service::upsert_value(db, &format!("{DEVICE_KEY_PREFIX}{id}"), &json).await?;
    Ok(settings)
}

pub async fn list_devices(db: &DatabaseConnection) -> Result<Vec<BarkDevice>, AppCommandError> {
    let rows = app_metadata::Entity::find()
        .filter(app_metadata::Column::Key.starts_with(DEVICE_KEY_PREFIX))
        .filter(app_metadata::Column::DeletedAt.is_null())
        .all(db)
        .await
        .map_err(crate::db::error::DbError::from)?;
    let mut devices = Vec::new();
    for row in rows {
        let Some(id) = row.key.strip_prefix(DEVICE_KEY_PREFIX) else {
            continue;
        };
        let Ok(id) = device_id(id) else { continue };
        let Ok(settings) = serde_json::from_str::<BarkSettings>(&row.value) else {
            continue;
        };
        if normalize(settings.clone()).is_ok() {
            devices.push(BarkDevice {
                device_id: id,
                settings,
            });
        }
    }
    Ok(devices)
}

pub(super) async fn enabled_devices(
    db: &DatabaseConnection,
) -> Result<Vec<BarkDevice>, AppCommandError> {
    Ok(list_devices(db)
        .await?
        .into_iter()
        .filter(|device| device.settings.enabled)
        .collect())
}

pub(super) fn client() -> Result<reqwest::Client, AppCommandError> {
    reqwest::Client::builder()
        // Proxy route fallback can take more than five seconds before TLS
        // completes. Keep the overall deadline below the iOS request's 30s.
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(25))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| {
            AppCommandError::new(AppErrorCode::NetworkError, "Cannot initialize Bark client")
        })
}

pub(super) fn completion_payload(
    settings: &BarkSettings,
    id: &str,
    conversation_id: i32,
    title: Option<&str>,
    workspace: Option<&str>,
    source_id: &str,
    final_reply: &str,
) -> serde_json::Value {
    let completed = if settings.language == "zh-Hans" {
        "任务已完成"
    } else {
        "Task completed"
    };
    let mut body = completed.to_string();
    if settings.include_preview {
        body.push('\n');
        body.extend(final_reply.trim().chars().take(PREVIEW_CHARS));
    }
    let context: Vec<String> = workspace
        .into_iter()
        .map(|name| name.chars().filter(|c| !c.is_control()).take(60).collect())
        .chain(std::iter::once(
            title
                .unwrap_or(completed)
                .chars()
                .filter(|c| !c.is_control())
                .take(120)
                .collect(),
        ))
        .filter(|name: &String| !name.is_empty())
        .collect();
    let mut payload = serde_json::json!({
        "title": notification_title(settings),
        "subtitle": context.join(" · "),
        "body": body,
        "group": format!("codeg-{source_id}-{conversation_id}"),
        "level": "active",
    });
    if let Some(link) = notification_link(settings, id, &format!("conversation/{conversation_id}"))
    {
        payload["url"] = link.into();
    }
    payload
}

fn notification_title(settings: &BarkSettings) -> String {
    let source = if settings.source_name.is_empty() {
        reqwest::Url::parse(&settings.server_url)
            .ok()
            .and_then(|url| {
                url.host_str().map(|host| match url.port() {
                    Some(port) => format!("{host}:{port}"),
                    None => host.to_string(),
                })
            })
            .unwrap_or_default()
    } else {
        settings.source_name.clone()
    };
    if source.is_empty() {
        "Codeg".into()
    } else {
        format!("Codeg · {}", source.chars().take(80).collect::<String>())
    }
}

/// Stable per-database identity keeps identically numbered conversations on
/// different remote servers in separate Bark notification groups.
pub(super) async fn source_id(db: &DatabaseConnection) -> Result<String, AppCommandError> {
    const KEY: &str = "bark_notification_source_id";
    if let Some(id) = app_metadata_service::get_value(db, KEY).await? {
        if let Ok(id) = Uuid::parse_str(&id) {
            return Ok(id.to_string());
        }
    }
    let id = Uuid::new_v4().to_string();
    app_metadata_service::upsert_value(db, KEY, &id).await?;
    Ok(id)
}

fn notification_link(settings: &BarkSettings, id: &str, target: &str) -> Option<String> {
    if id == "00000000-0000-4000-8000-000000000001" {
        if settings.server_url.is_empty() {
            return None;
        }
        Some(format!(
            "codeg://{target}?server_url={}",
            urlencoding::encode(&settings.server_url)
        ))
    } else {
        Some(format!("codeg://{target}?server_id={id}"))
    }
}

pub(super) async fn send(
    client: &reqwest::Client,
    settings: &BarkSettings,
    mut payload: serde_json::Value,
) -> Result<(), AppCommandError> {
    let (url, key) = push_endpoint(&settings.push_url)?;
    payload["device_key"] = key.into();
    let response = client
        .post(url)
        .json(&payload)
        .send()
        .await
        .map_err(|error| {
            AppCommandError::new(AppErrorCode::NetworkError, "Cannot reach Bark server")
                .with_detail(error.without_url().to_string())
        })?;
    let status = response.status();
    if !status.is_success() {
        return Err(AppCommandError::new(
            AppErrorCode::NetworkError,
            format!("Bark server returned HTTP {}", status.as_u16()),
        ));
    }
    #[derive(Deserialize)]
    struct BarkResponse {
        code: i32,
    }
    let ack: BarkResponse = response.json().await.map_err(|_| {
        AppCommandError::new(AppErrorCode::NetworkError, "Invalid Bark server response")
    })?;
    if ack.code != 200 {
        // Bark's error message can echo submitted secrets, so report the code only.
        return Err(AppCommandError::new(
            AppErrorCode::NetworkError,
            format!("Bark rejected the notification (code {})", ack.code),
        ));
    }
    Ok(())
}

pub async fn test_notification(db: &DatabaseConnection, id: &str) -> Result<(), AppCommandError> {
    let id = device_id(id)?;
    let settings = load_settings(db, &id).await?;
    if settings.push_url.is_empty() {
        return Err(AppCommandError::invalid_input(
            "Save a Bark device URL first",
        ));
    }
    let body = if settings.language == "zh-Hans" {
        "Codeg 完成提醒已连接"
    } else {
        "Codeg completion notifications are connected"
    };
    let mut payload = serde_json::json!({
        "title": notification_title(&settings), "body": body, "group": "codeg-test", "level": "active",
    });
    if let Some(link) = notification_link(&settings, &id, "settings/notifications") {
        payload["url"] = link.into();
    }
    send(&client()?, &settings, payload).await
}

#[cfg(test)]
pub(super) mod tests;
