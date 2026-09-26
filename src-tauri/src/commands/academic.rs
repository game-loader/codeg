//! Shared academic commands for desktop IPC and authenticated server HTTP.
//! Zotero itself remains accessible only through backend loopback requests.
use crate::academic::{runtime, store, types::*};

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn academic_settings_get() -> Result<AcademicSettings, String> {
    runtime()?.settings().await
}
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn academic_settings_set(
    agent_type: String,
    bridge_port: u16,
    token: Option<String>,
    mcp_enabled: Option<bool>,
) -> Result<AcademicSettings, String> {
    runtime()?
        .set_settings(agent_type, bridge_port, token, mcp_enabled)
        .await
}
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn academic_library() -> Result<AcademicLibrary, String> {
    runtime()?.library().await
}
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn academic_select(
    item_key: String,
    agent_preferences: Option<AcademicAgentPreferences>,
) -> Result<AcademicPaper, String> {
    runtime()?.select(item_key, agent_preferences).await
}
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn academic_paper_get(paper_id: String) -> Result<AcademicPaper, String> {
    store::get(&runtime()?.db.conn, &paper_id).await
}
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn academic_import(
    identifier: String,
    collection_key: String,
) -> Result<AcademicItem, String> {
    runtime()?.import(identifier, collection_key).await
}
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn academic_prepare(
    paper_id: String,
    arxiv_id: Option<String>,
    repo_url: Option<String>,
    agent_preferences: Option<AcademicAgentPreferences>,
) -> Result<AcademicPaper, String> {
    runtime()?
        .prepare(paper_id, arxiv_id, repo_url, agent_preferences)
        .await
}
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn academic_cancel(paper_id: String) -> Result<(), String> {
    runtime()?.cancel(&paper_id).await
}
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn academic_open_target(
    paper_id: String,
    without_code: bool,
) -> Result<OpenTarget, String> {
    runtime()?.open_target(&paper_id, without_code).await
}
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn academic_bind_conversation(
    paper_id: String,
    conversation_id: i32,
) -> Result<(), String> {
    let runtime = runtime()?;
    store::bind_conversation(&runtime.db.conn, &paper_id, conversation_id).await?;
    runtime.changed(&paper_id);
    Ok(())
}
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn academic_conversation_paper(
    conversation_id: i32,
) -> Result<Option<AcademicPaper>, String> {
    store::conversation_paper(&runtime()?.db.conn, conversation_id).await
}
