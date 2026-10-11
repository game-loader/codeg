use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(RemoteWorkspaceConnection::Table)
                    .add_column(
                        ColumnDef::new(RemoteWorkspaceConnection::ConfigRevision)
                            .string()
                            .not_null()
                            .default(""),
                    )
                    .to_owned(),
            )
            .await?;
        // Revisions are independent of tokens and metadata timestamps. Give
        // saved connections a stable initial revision during upgrade.
        manager.get_connection().execute_unprepared(
            "UPDATE remote_workspace_connection SET config_revision = lower(hex(randomblob(16)))",
        ).await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(RemoteWorkspaceConnection::Table)
                    .drop_column(RemoteWorkspaceConnection::ConfigRevision)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum RemoteWorkspaceConnection {
    Table,
    ConfigRevision,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migration::Migrator;

    #[tokio::test]
    async fn remote_connection_revision_upgrade_preserves_saved_connections() {
        let db = sea_orm::Database::connect("sqlite::memory:").await.unwrap();
        let previous = Migrator::migrations().len() as u32 - 1;
        Migrator::up(&db, Some(previous)).await.unwrap();
        db.execute_unprepared("INSERT INTO remote_workspace_connection (name, base_url, token, created_at, updated_at) VALUES ('saved', 'http://localhost:9999', 'test-token', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')").await.unwrap();
        Migrator::up(&db, None).await.unwrap();
        let before = crate::db::service::remote_workspace_connection_service::list(&db)
            .await
            .unwrap();
        assert_eq!(before.len(), 1);
        assert_eq!(before[0].token, "test-token");
        assert_eq!(before[0].config_revision.len(), 32);
        let again = crate::db::service::remote_workspace_connection_service::list(&db)
            .await
            .unwrap();
        assert_eq!(before[0].config_revision, again[0].config_revision);
    }
}
