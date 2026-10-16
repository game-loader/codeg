use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // session_selector_state: the composer selectors (mode + config option
        // values such as model and thinking effort) an agent session last ran
        // with, keyed by the agent's own session id. A resume restores them
        // ahead of the connecting client's per-device defaults, so a
        // conversation keeps its settings across devices (desktop ⇄ iOS).
        //
        // Keyed by `(agent_type, external_id)` rather than by conversation row:
        // the session id exists from `SessionStarted`, before any row is bound,
        // and it is what every client passes back as `sessionId` on resume.
        // Rows are never referenced by anything else and are tiny, so a
        // soft-deleted conversation simply leaves its row behind.
        manager
            .create_table(
                Table::create()
                    .table(SessionSelectorState::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(SessionSelectorState::AgentType)
                            .string()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(SessionSelectorState::ExternalId)
                            .string()
                            .not_null(),
                    )
                    .col(ColumnDef::new(SessionSelectorState::ModeId).string().null())
                    // JSON object `{config_id: value_id}`; booleans as "true"/"false",
                    // the same encoding `acp_connect`'s `preferred_config_values` uses.
                    .col(
                        ColumnDef::new(SessionSelectorState::ConfigValues)
                            .text()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(SessionSelectorState::UpdatedAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .primary_key(
                        Index::create()
                            .col(SessionSelectorState::AgentType)
                            .col(SessionSelectorState::ExternalId),
                    )
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(
                Table::drop()
                    .table(SessionSelectorState::Table)
                    .if_exists()
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum SessionSelectorState {
    Table,
    AgentType,
    ExternalId,
    ModeId,
    ConfigValues,
    UpdatedAt,
}
