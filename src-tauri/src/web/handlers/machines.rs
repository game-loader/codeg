use std::sync::Arc;

use axum::{extract::Extension, Json};
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::commands::machines::{
    self, Machine, MachineInventory, MachineSnapshot, ManualMachineInput,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeMachineParams {
    pub machine_id: String,
    pub ssh_user: Option<String>,
}

#[derive(Deserialize)]
pub struct SaveManualMachineParams {
    pub input: ManualMachineInput,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteManualMachineParams {
    pub machine_id: String,
}

pub async fn list_machines(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<MachineInventory>, AppCommandError> {
    machines::list_machines_core(&state.db.conn).await.map(Json)
}

pub async fn probe_machine(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<ProbeMachineParams>,
) -> Result<Json<MachineSnapshot>, AppCommandError> {
    machines::probe_machine_core(&state.db.conn, params.machine_id, params.ssh_user)
        .await
        .map(Json)
}

pub async fn save_manual_machine(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<SaveManualMachineParams>,
) -> Result<Json<Machine>, AppCommandError> {
    machines::save_manual_machine_core(&state.db.conn, params.input)
        .await
        .map(Json)
}

pub async fn delete_manual_machine(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<DeleteManualMachineParams>,
) -> Result<Json<()>, AppCommandError> {
    machines::delete_manual_machine_core(&state.db.conn, params.machine_id)
        .await
        .map(Json)
}
