use sea_orm::entity::prelude::*;

/// The composer selectors an agent session last ran with. See the
/// `m20261015_000001_session_selector_state` migration for why it is keyed by
/// the agent's session id instead of the conversation row.
#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "session_selector_state")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub agent_type: String,
    #[sea_orm(primary_key, auto_increment = false)]
    pub external_id: String,
    pub mode_id: Option<String>,
    /// JSON object `{config_id: value_id}`.
    pub config_values: String,
    pub updated_at: DateTimeUtc,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
