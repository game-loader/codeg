use std::sync::Arc;

use axum::{extract::Extension, Json};
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::notifications::bark::{self, BarkSettings};

pub async fn list_bark_notification_settings(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<Vec<bark::BarkDevice>>, AppCommandError> {
    Ok(Json(bark::list_devices(&state.db.conn).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceParams {
    pub device_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsParams {
    pub device_id: String,
    pub settings: BarkSettings,
}

pub async fn get_bark_notification_settings(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<DeviceParams>,
) -> Result<Json<BarkSettings>, AppCommandError> {
    Ok(Json(
        bark::load_settings(&state.db.conn, &params.device_id).await?,
    ))
}

pub async fn set_bark_notification_settings(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<SettingsParams>,
) -> Result<Json<BarkSettings>, AppCommandError> {
    Ok(Json(
        bark::save_settings(&state.db.conn, &params.device_id, params.settings).await?,
    ))
}

pub async fn test_bark_notification(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<DeviceParams>,
) -> Result<Json<()>, AppCommandError> {
    bark::test_notification(&state.db.conn, &params.device_id).await?;
    Ok(Json(()))
}
