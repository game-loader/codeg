//! Authenticated HTTP twins of the desktop academic commands. Zotero stays on
//! the backend's loopback interface; bridge credentials never enter responses.
use axum::Json;
use serde::Deserialize;

use crate::academic::types::*;
use crate::app_error::AppCommandError;
use crate::commands::academic;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsParams {
    pub agent_type: String,
    pub bridge_port: u16,
    pub token: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectParams {
    pub item_key: String,
    pub agent_preferences: Option<AcademicAgentPreferences>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperParams {
    pub paper_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportParams {
    pub identifier: String,
    pub collection_key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareParams {
    pub paper_id: String,
    pub arxiv_id: Option<String>,
    pub repo_url: Option<String>,
    pub agent_preferences: Option<AcademicAgentPreferences>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenTargetParams {
    pub paper_id: String,
    pub without_code: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BindParams {
    pub paper_id: String,
    pub conversation_id: i32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationParams {
    pub conversation_id: i32,
}

pub async fn academic_settings_get() -> Result<Json<AcademicSettings>, AppCommandError> {
    academic::academic_settings_get()
        .await
        .map(Json)
        .map_err(AppCommandError::invalid_input)
}

pub async fn academic_settings_set(
    Json(params): Json<SettingsParams>,
) -> Result<Json<AcademicSettings>, AppCommandError> {
    academic::academic_settings_set(params.agent_type, params.bridge_port, params.token)
        .await
        .map(Json)
        .map_err(AppCommandError::invalid_input)
}

pub async fn academic_library() -> Result<Json<AcademicLibrary>, AppCommandError> {
    academic::academic_library()
        .await
        .map(Json)
        .map_err(AppCommandError::invalid_input)
}

pub async fn academic_select(
    Json(params): Json<SelectParams>,
) -> Result<Json<AcademicPaper>, AppCommandError> {
    academic::academic_select(params.item_key, params.agent_preferences)
        .await
        .map(Json)
        .map_err(AppCommandError::invalid_input)
}

pub async fn academic_paper_get(
    Json(params): Json<PaperParams>,
) -> Result<Json<AcademicPaper>, AppCommandError> {
    academic::academic_paper_get(params.paper_id)
        .await
        .map(Json)
        .map_err(AppCommandError::invalid_input)
}

pub async fn academic_import(
    Json(params): Json<ImportParams>,
) -> Result<Json<AcademicItem>, AppCommandError> {
    academic::academic_import(params.identifier, params.collection_key)
        .await
        .map(Json)
        .map_err(AppCommandError::invalid_input)
}

pub async fn academic_prepare(
    Json(params): Json<PrepareParams>,
) -> Result<Json<AcademicPaper>, AppCommandError> {
    academic::academic_prepare(
        params.paper_id,
        params.arxiv_id,
        params.repo_url,
        params.agent_preferences,
    )
    .await
    .map(Json)
    .map_err(AppCommandError::invalid_input)
}

pub async fn academic_cancel(Json(params): Json<PaperParams>) -> Result<Json<()>, AppCommandError> {
    academic::academic_cancel(params.paper_id)
        .await
        .map(Json)
        .map_err(AppCommandError::invalid_input)
}

pub async fn academic_open_target(
    Json(params): Json<OpenTargetParams>,
) -> Result<Json<OpenTarget>, AppCommandError> {
    academic::academic_open_target(params.paper_id, params.without_code)
        .await
        .map(Json)
        .map_err(AppCommandError::invalid_input)
}

pub async fn academic_bind_conversation(
    Json(params): Json<BindParams>,
) -> Result<Json<()>, AppCommandError> {
    academic::academic_bind_conversation(params.paper_id, params.conversation_id)
        .await
        .map(Json)
        .map_err(AppCommandError::invalid_input)
}

pub async fn academic_conversation_paper(
    Json(params): Json<ConversationParams>,
) -> Result<Json<Option<AcademicPaper>>, AppCommandError> {
    academic::academic_conversation_paper(params.conversation_id)
        .await
        .map(Json)
        .map_err(AppCommandError::invalid_input)
}
