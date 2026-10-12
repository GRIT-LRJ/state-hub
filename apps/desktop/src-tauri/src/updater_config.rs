pub(crate) fn configured(config: Option<&serde_json::Value>) -> bool {
    let Some(config) = config else { return false };
    config.get("active").and_then(|value| value.as_bool()) == Some(true)
        && config.get("pubkey").and_then(|value| value.as_str()).is_some_and(|key| !key.is_empty())
        && config.get("endpoints").and_then(|value| value.as_array()).is_some_and(|urls| !urls.is_empty())
}

#[cfg(test)]
mod tests {
    use super::configured;
    use serde_json::json;

    #[test]
    fn disabled_or_incomplete_updaters_do_not_initialize() {
        assert!(!configured(None));
        assert!(!configured(Some(&json!({"active": false, "endpoints": []}))));
        assert!(!configured(Some(&json!({"active": true, "endpoints": ["https://example.test"]}))));
        assert!(!configured(Some(&json!({"active": true, "pubkey": "key", "endpoints": []}))));
        assert!(configured(Some(&json!({"active": true, "pubkey": "key", "endpoints": ["https://example.test"]}))));
    }
}
