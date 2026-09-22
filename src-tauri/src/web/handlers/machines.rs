use axum::Json;
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::commands::machines::{self, Machine, MachineSnapshot};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeMachineParams {
    pub machine_id: String,
    pub ssh_user: Option<String>,
}

pub async fn list_machines() -> Result<Json<Vec<Machine>>, AppCommandError> {
    machines::list_machines_core().await.map(Json)
}

pub async fn probe_machine(
    Json(params): Json<ProbeMachineParams>,
) -> Result<Json<MachineSnapshot>, AppCommandError> {
    machines::probe_machine_core(params.machine_id, params.ssh_user)
        .await
        .map(Json)
}
