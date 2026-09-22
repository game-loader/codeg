use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared("CREATE TABLE academic_paper (id TEXT PRIMARY KEY NOT NULL, instance_id TEXT NOT NULL, library_id INTEGER NOT NULL, item_key TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE(instance_id, library_id, item_key))").await?;
        db.execute_unprepared("CREATE TABLE academic_conversation (conversation_id INTEGER PRIMARY KEY NOT NULL REFERENCES conversation(id) ON DELETE CASCADE, paper_id TEXT NOT NULL REFERENCES academic_paper(id) ON DELETE CASCADE)").await?;
        db.execute_unprepared(
            "CREATE INDEX academic_conversation_paper ON academic_conversation(paper_id)",
        )
        .await?;
        Ok(())
    }
    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared("DROP TABLE academic_conversation")
            .await?;
        db.execute_unprepared("DROP TABLE academic_paper").await?;
        Ok(())
    }
}
