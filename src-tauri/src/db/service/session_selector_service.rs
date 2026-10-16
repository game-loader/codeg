//! The composer selectors (mode + config option values) each agent session
//! last ran with, so a conversation resumes with its own settings on whichever
//! device opens it next.
//!
//! Clients keep their picks per agent type on the device (web `localStorage`,
//! iOS `UserDefaults`) and send them on every `acp_connect`. Those are the right
//! defaults for a NEW session, but on a resume they are merely whatever that
//! device used last — so a conversation run in `bypassPermissions` + Opus on the
//! desktop came back on the phone in the phone's own mode and model. The
//! lifecycle worker records the live selectors here as they change, and
//! [`resolve_connect_prefs`] lets them win over the device defaults on resume.

use std::collections::BTreeMap;

use chrono::Utc;
use sea_orm::sea_query::OnConflict;
use sea_orm::{ConnectionTrait, EntityTrait, Set};

use crate::db::entities::session_selector_state;
use crate::db::error::DbError;
use crate::models::AgentType;

/// One session's selectors, in the shape `acp_connect` takes them.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SessionSelectors {
    pub mode_id: Option<String>,
    pub config_values: BTreeMap<String, String>,
}

impl SessionSelectors {
    pub fn is_empty(&self) -> bool {
        self.mode_id.is_none() && self.config_values.is_empty()
    }
}

/// Same spelling `conversation.agent_type` stores (the serde form).
fn agent_type_key(agent_type: AgentType) -> String {
    serde_json::to_value(agent_type)
        .ok()
        .and_then(|v| v.as_str().map(String::from))
        .unwrap_or_default()
}

pub async fn upsert<C: ConnectionTrait>(
    conn: &C,
    agent_type: AgentType,
    external_id: &str,
    selectors: &SessionSelectors,
) -> Result<(), DbError> {
    let config_values = serde_json::to_string(&selectors.config_values)
        .map_err(|e| DbError::Validation(format!("encode selector config values: {e}")))?;
    session_selector_state::Entity::insert(session_selector_state::ActiveModel {
        agent_type: Set(agent_type_key(agent_type)),
        external_id: Set(external_id.to_string()),
        mode_id: Set(selectors.mode_id.clone()),
        config_values: Set(config_values),
        updated_at: Set(Utc::now()),
    })
    .on_conflict(
        OnConflict::columns([
            session_selector_state::Column::AgentType,
            session_selector_state::Column::ExternalId,
        ])
        .update_columns([
            session_selector_state::Column::ModeId,
            session_selector_state::Column::ConfigValues,
            session_selector_state::Column::UpdatedAt,
        ])
        .to_owned(),
    )
    .exec(conn)
    .await?;
    Ok(())
}

pub async fn get<C: ConnectionTrait>(
    conn: &C,
    agent_type: AgentType,
    external_id: &str,
) -> Result<Option<SessionSelectors>, DbError> {
    let row = session_selector_state::Entity::find_by_id((
        agent_type_key(agent_type),
        external_id.to_string(),
    ))
    .one(conn)
    .await?;
    Ok(row.map(|row| SessionSelectors {
        mode_id: row.mode_id,
        // A row this build cannot read restores nothing rather than failing
        // the connect; the next selector event rewrites it.
        config_values: serde_json::from_str(&row.config_values).unwrap_or_default(),
    }))
}

/// Combine a connecting client's per-device defaults with the session's own
/// stored selectors. The session wins wherever it has a value; the client's
/// defaults fill in only what it never recorded (an option an agent upgrade
/// introduced since). Values the agent no longer accepts are dropped later by
/// the connect-time replay itself (`apply_preferred_session_options`).
pub fn merge_connect_prefs(
    client_mode_id: Option<String>,
    client_config_values: BTreeMap<String, String>,
    stored: Option<SessionSelectors>,
) -> (Option<String>, BTreeMap<String, String>) {
    let Some(stored) = stored else {
        return (client_mode_id, client_config_values);
    };
    let mut config_values = client_config_values;
    config_values.extend(stored.config_values);
    (stored.mode_id.or(client_mode_id), config_values)
}

/// The selectors `acp_connect` should replay: the client's defaults for a new
/// session, the session's own last selectors (over those defaults) for a
/// resume. A failed read falls back to the client's defaults — losing the
/// restore is better than failing the connect.
pub async fn resolve_connect_prefs<C: ConnectionTrait>(
    conn: &C,
    agent_type: AgentType,
    session_id: Option<&str>,
    client_mode_id: Option<String>,
    client_config_values: BTreeMap<String, String>,
) -> (Option<String>, BTreeMap<String, String>) {
    let stored = match session_id.filter(|sid| !sid.is_empty()) {
        Some(sid) => match get(conn, agent_type, sid).await {
            Ok(stored) => stored,
            Err(e) => {
                tracing::warn!(
                    "[ACP] reading stored selectors for {agent_type:?} session {sid} failed: {e}"
                );
                None
            }
        },
        None => None,
    };
    merge_connect_prefs(client_mode_id, client_config_values, stored)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_helpers::fresh_in_memory_db;

    fn values(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    fn selectors(mode: Option<&str>, pairs: &[(&str, &str)]) -> SessionSelectors {
        SessionSelectors {
            mode_id: mode.map(String::from),
            config_values: values(pairs),
        }
    }

    #[tokio::test]
    async fn upsert_round_trips_and_overwrites() {
        let db = fresh_in_memory_db().await;
        let first = selectors(Some("default"), &[("model", "sonnet")]);
        upsert(&db.conn, AgentType::ClaudeCode, "s1", &first)
            .await
            .unwrap();
        assert_eq!(
            get(&db.conn, AgentType::ClaudeCode, "s1").await.unwrap(),
            Some(first)
        );

        let second = selectors(
            Some("bypassPermissions"),
            &[("model", "opus"), ("effort", "max")],
        );
        upsert(&db.conn, AgentType::ClaudeCode, "s1", &second)
            .await
            .unwrap();
        assert_eq!(
            get(&db.conn, AgentType::ClaudeCode, "s1").await.unwrap(),
            Some(second)
        );
    }

    #[tokio::test]
    async fn sessions_are_scoped_per_agent() {
        let db = fresh_in_memory_db().await;
        upsert(
            &db.conn,
            AgentType::ClaudeCode,
            "shared-id",
            &selectors(None, &[("model", "opus")]),
        )
        .await
        .unwrap();
        assert_eq!(
            get(&db.conn, AgentType::Codex, "shared-id").await.unwrap(),
            None
        );
        assert_eq!(
            get(&db.conn, AgentType::ClaudeCode, "other-id")
                .await
                .unwrap(),
            None
        );
    }

    #[test]
    fn merge_prefers_the_session_over_device_defaults() {
        let (mode, config) = merge_connect_prefs(
            Some("default".into()),
            values(&[("model", "sonnet"), ("effort", "high"), ("fast", "true")]),
            Some(selectors(
                Some("bypassPermissions"),
                &[("model", "opus"), ("effort", "max")],
            )),
        );
        assert_eq!(mode.as_deref(), Some("bypassPermissions"));
        // `fast` was never recorded for this session, so the device default stays.
        assert_eq!(
            config,
            values(&[("model", "opus"), ("effort", "max"), ("fast", "true")])
        );
    }

    #[test]
    fn merge_keeps_device_defaults_without_a_stored_session() {
        let client = values(&[("model", "sonnet")]);
        let (mode, config) = merge_connect_prefs(Some("plan".into()), client.clone(), None);
        assert_eq!(mode.as_deref(), Some("plan"));
        assert_eq!(config, client);

        // A stored row without a mode leaves the client's mode in place.
        let (mode, _) = merge_connect_prefs(
            Some("plan".into()),
            BTreeMap::new(),
            Some(selectors(None, &[("model", "opus")])),
        );
        assert_eq!(mode.as_deref(), Some("plan"));
    }

    #[tokio::test]
    async fn resolve_restores_only_for_a_known_session() {
        let db = fresh_in_memory_db().await;
        upsert(
            &db.conn,
            AgentType::ClaudeCode,
            "resumed",
            &selectors(Some("bypassPermissions"), &[("model", "opus")]),
        )
        .await
        .unwrap();
        let client = values(&[("model", "sonnet")]);

        let resumed = resolve_connect_prefs(
            &db.conn,
            AgentType::ClaudeCode,
            Some("resumed"),
            Some("default".into()),
            client.clone(),
        )
        .await;
        assert_eq!(resumed.0.as_deref(), Some("bypassPermissions"));
        assert_eq!(resumed.1, values(&[("model", "opus")]));

        for session_id in [None, Some(""), Some("never-seen")] {
            let fresh = resolve_connect_prefs(
                &db.conn,
                AgentType::ClaudeCode,
                session_id,
                Some("default".into()),
                client.clone(),
            )
            .await;
            assert_eq!(fresh, (Some("default".into()), client.clone()));
        }
    }
}
