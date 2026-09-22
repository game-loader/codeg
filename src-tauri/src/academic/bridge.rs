//! Authenticated, loopback-only Zotero plugin client. Tokens never enter result DTOs.
use super::types::*;
use serde::{de::DeserializeOwned, Deserialize};
use std::time::Duration;
const TOKEN: &str = "academic-zotero-bridge";

pub fn token() -> Result<Option<String>, String> {
    crate::keyring_store::get_secret(TOKEN)
}
pub fn set_token(value: &str) -> Result<(), String> {
    if !(24..=512).contains(&value.len()) || !value.bytes().all(|b| b.is_ascii_graphic()) {
        return Err("Pairing token must contain 24–512 printable non-space characters".into());
    }
    crate::keyring_store::set_secret(TOKEN, value)
}

pub struct Bridge {
    client: reqwest::Client,
    port: u16,
    token: String,
}
impl Bridge {
    pub fn new(settings: &AcademicSettings) -> Result<Self, String> {
        let token = token()?.ok_or("Pair Zotero in Academic settings first")?;
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(90))
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Self {
            client,
            port: settings.bridge_port,
            token,
        })
    }
    async fn call<T: DeserializeOwned>(
        &self,
        endpoint: &str,
        body: serde_json::Value,
    ) -> Result<T, String> {
        let response = self
            .client
            .post(format!(
                "http://127.0.0.1:{}/codeg/v1/{endpoint}",
                self.port
            ))
            .bearer_auth(&self.token)
            .json(&body)
            .send()
            .await
            .map_err(|_| {
                "Could not connect to Zotero. Open Zotero and enable the Codeg plugin.".to_string()
            })?;
        if response.status() == reqwest::StatusCode::UNAUTHORIZED
            || response.status() == reqwest::StatusCode::FORBIDDEN
        {
            return Err("Zotero pairing token was rejected. Pair again in settings.".into());
        }
        if !response.status().is_success() {
            return Err(format!(
                "Zotero {endpoint} returned HTTP {}",
                response.status()
            ));
        }
        // Bound decompressed response size, including chunked responses.
        let mut response = response;
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
            if bytes.len() + chunk.len() > 32 * 1024 * 1024 {
                return Err("Zotero response exceeds 32 MiB".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes)
            .map_err(|e| format!("Invalid Zotero {endpoint} response: {e}"))
    }
    pub async fn library(&self) -> Result<AcademicLibrary, String> {
        #[derive(Deserialize)]
        struct Health {
            version: u32,
            instance_id: String,
        }
        let health: Health = self.call("health", serde_json::json!({})).await?;
        if health.version != 1 {
            return Err("Unsupported Zotero bridge protocol version".into());
        }
        let library: AcademicLibrary = self.call("library", serde_json::json!({})).await?;
        if library.instance_id.is_empty() || library.instance_id != health.instance_id {
            return Err("Zotero installation identity changed during refresh".into());
        }
        Ok(library)
    }
    pub async fn attachment(&self, item: &str) -> Result<Attachment, String> {
        self.call("attachment", serde_json::json!({"item_key":item}))
            .await
    }
    pub async fn attach_arxiv(&self, item: &str, id: &str) -> Result<Attachment, String> {
        self.call("attach-arxiv", serde_json::json!({"item_key":item,"arxiv_id":id,"pdf_url":format!("https://arxiv.org/pdf/{id}")})).await
    }
    pub async fn import(&self, identifier: &str, collection: &str) -> Result<AcademicItem, String> {
        self.call(
            "import",
            serde_json::json!({"identifier":identifier,"collection_key":collection}),
        )
        .await
    }
}
