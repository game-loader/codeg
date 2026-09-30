#[cfg(feature = "tauri-runtime")]
use crate::app_error::AppCommandError;
#[cfg(feature = "tauri-runtime")]
use crate::notifications::bark::{self, BarkDevice, BarkSettings};

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn get_bark_notification_settings(
    db: tauri::State<'_, crate::db::AppDatabase>,
    device_id: String,
) -> Result<BarkSettings, AppCommandError> {
    bark::load_settings(&db.conn, &device_id).await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn set_bark_notification_settings(
    db: tauri::State<'_, crate::db::AppDatabase>,
    device_id: String,
    settings: BarkSettings,
) -> Result<BarkSettings, AppCommandError> {
    bark::save_settings(&db.conn, &device_id, settings).await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn list_bark_notification_settings(
    db: tauri::State<'_, crate::db::AppDatabase>,
) -> Result<Vec<BarkDevice>, AppCommandError> {
    bark::list_devices(&db.conn).await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn test_bark_notification(
    db: tauri::State<'_, crate::db::AppDatabase>,
    device_id: String,
) -> Result<(), AppCommandError> {
    bark::test_notification(&db.conn, &device_id).await
}
