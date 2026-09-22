use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AcademicSettings {
    pub agent_type: String,
    pub bridge_port: u16,
    #[serde(default)]
    pub paired: bool,
}
impl Default for AcademicSettings {
    fn default() -> Self {
        Self {
            agent_type: "codex".into(),
            bridge_port: 23119,
            paired: false,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AcademicCollection {
    pub key: String,
    pub name: String,
    pub parent_key: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AcademicItem {
    pub key: String,
    pub title: String,
    #[serde(default)]
    pub abstract_text: String,
    #[serde(default)]
    pub authors: Vec<String>,
    pub doi: Option<String>,
    pub url: Option<String>,
    #[serde(default)]
    pub extra: String,
    #[serde(default)]
    pub collections: Vec<String>,
    pub version: i64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AcademicLibrary {
    pub library_id: i64,
    pub instance_id: String,
    pub collections: Vec<AcademicCollection>,
    pub items: Vec<AcademicItem>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ArxivCandidate {
    pub id: String,
    pub title: String,
    pub authors: Vec<String>,
    pub summary: String,
    pub pdf_url: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AcademicConversation {
    pub id: i32,
    pub folder_id: i32,
    pub agent_type: String,
    pub title: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AcademicPaper {
    pub id: String,
    pub item_key: String,
    pub library_id: i64,
    pub title: String,
    pub authors: Vec<String>,
    pub abstract_text: String,
    pub doi: Option<String>,
    pub arxiv_id: Option<String>,
    pub pdf_path: Option<String>,
    pub text_path: Option<String>,
    pub context_path: Option<String>,
    pub repo_url: Option<String>,
    pub repo_path: Option<String>,
    pub folder_id: Option<i32>,
    pub status: String,
    pub error: Option<String>,
    pub analysis: Option<String>,
    pub analysis_conversation_id: Option<i32>,
    pub candidates: Vec<ArxivCandidate>,
    #[serde(default)]
    pub repo_candidates: Vec<RepositoryCandidate>,
    #[serde(default)]
    pub conversations: Vec<AcademicConversation>,
    // Persist the Zotero installation identity; never merge equal item keys from distinct installations.
    #[serde(default)]
    pub instance_id: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct OpenTarget {
    pub paper_id: String,
    pub agent_type: String,
    pub folder_id: Option<i32>,
    pub working_dir: Option<String>,
}
#[derive(Clone, Debug, Deserialize)]
pub struct Attachment {
    pub path: Option<String>,
    pub text: Option<String>,
}
#[derive(Clone, Debug, Deserialize)]
pub struct AgentAnalysis {
    pub analysis: String,
    #[serde(default)]
    pub repo_candidates: Vec<RepositoryCandidate>,
    #[serde(default)]
    pub project_pages: Vec<ProjectPage>,
    pub repo_url: Option<String>,
    #[serde(default)]
    pub evidence_quote: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RepositoryCandidate {
    pub url: String,
    pub evidence_quote: String,
    pub source_url: Option<String>,
    /// Public availability does not imply an open-source license.
    pub license: Option<String>,
}
#[derive(Clone, Debug, Deserialize)]
pub struct ProjectPage {
    pub url: String,
    pub evidence_quote: String,
}

/// Composer preferences are captured once when enqueueing, never re-read mid-job.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct AcademicAgentPreferences {
    pub agent_type: String,
    pub mode_id: Option<String>,
    #[serde(default)]
    pub config_values: std::collections::BTreeMap<String, String>,
}
