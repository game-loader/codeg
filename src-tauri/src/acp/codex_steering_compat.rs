//! Process-local codex-acp compatibility. The loader patches only verified
//! bundles in memory and advertises its idle-race guarantee at initialize.
//! Keep the registry's upstream version policy closed until upstream ships it.

use std::path::Path;

const LOADER: &str = include_str!("codex-steering-loader.mjs");

pub async fn configure(env: &mut Vec<(String, String)>, scratch: Option<&Path>) {
    let Some(scratch) = scratch else { return };
    let path = scratch.join("codex-steering-loader.mjs");
    if let Err(error) = tokio::fs::write(&path, LOADER).await {
        tracing::warn!("[ACP] Unable to prepare Codex steering compatibility: {error}");
        return;
    }
    let Ok(url) = url::Url::from_file_path(&path) else {
        return;
    };
    let existing = env
        .iter()
        .rev()
        .find(|(key, _)| key == "NODE_OPTIONS")
        .map(|(_, value)| value.clone())
        .or_else(|| std::env::var("NODE_OPTIONS").ok())
        .unwrap_or_default();
    env.retain(|(key, _)| key != "NODE_OPTIONS");
    // The file URL percent-encodes spaces and quotes, including Windows paths.
    env.push(("NODE_OPTIONS".into(), format!("{existing} --loader={url}")));
}

pub fn supports_native_steering(
    meta: Option<&serde_json::Map<String, serde_json::Value>>,
    version: Option<&str>,
) -> bool {
    matches!(version, Some("1.13.1" | "2.0.0" | "2.0.1"))
        && meta
            .and_then(|m| m.get("steering"))
            .and_then(|s| s.get("codegPromptRequired"))
            .and_then(serde_json::Value::as_u64)
            == Some(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requires_a_patched_known_adapter() {
        let patched = serde_json::json!({"steering": {"codegPromptRequired": 1}});
        for version in ["1.13.1", "2.0.0", "2.0.1"] {
            assert!(supports_native_steering(patched.as_object(), Some(version)));
            assert!(!supports_native_steering(None, Some(version)));
            let stock = serde_json::json!({"steering": {"supported": true}});
            assert!(!supports_native_steering(stock.as_object(), Some(version)));
        }
        assert!(!supports_native_steering(
            patched.as_object(),
            Some("2.0.2")
        ));
        assert!(!supports_native_steering(patched.as_object(), None));
    }
}
