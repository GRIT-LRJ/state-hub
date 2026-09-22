const SERVICE: &str = "dev.statehub.desktop";

trait CredentialStore {
    fn set(&self, reference: &str, value: &str) -> Result<(), ()>;
    fn exists(&self, reference: &str) -> Result<bool, ()>;
    fn delete(&self, reference: &str) -> Result<(), ()>;
}

struct OsCredentialStore;

fn credential_entry(reference: &str) -> keyring::Result<keyring::Entry> {
    keyring::Entry::new(SERVICE, reference)
}

impl CredentialStore for OsCredentialStore {
    fn set(&self, reference: &str, value: &str) -> Result<(), ()> {
        credential_entry(reference)
            .map_err(|_| ())?
            .set_password(value)
            .map_err(|_| ())
    }

    fn exists(&self, reference: &str) -> Result<bool, ()> {
        match credential_entry(reference).map_err(|_| ())?.get_password() {
            Ok(_) => Ok(true),
            Err(keyring::Error::NoEntry) => Ok(false),
            Err(_) => Err(()),
        }
    }

    fn delete(&self, reference: &str) -> Result<(), ()> {
        match credential_entry(reference)
            .map_err(|_| ())?
            .delete_credential()
        {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(()),
        }
    }
}

fn valid_reference(reference: &str) -> bool {
    if reference.len() > 256 {
        return false;
    }
    let mut chars = reference.chars();
    chars
        .next()
        .is_some_and(|first| first.is_ascii_alphanumeric())
        && chars.all(|next| next.is_ascii_alphanumeric() || "._:-".contains(next))
}

fn save(store: &impl CredentialStore, reference: &str, value: &str) -> Result<(), String> {
    if !valid_reference(reference) || value.is_empty() {
        return Err("INVALID_CREDENTIAL_INPUT".into());
    }
    store
        .set(reference, value)
        .map_err(|_| "CREDENTIAL_STORE_UNAVAILABLE".into())
}

fn status(store: &impl CredentialStore, reference: &str) -> Result<bool, String> {
    if !valid_reference(reference) {
        return Err("INVALID_CREDENTIAL_INPUT".into());
    }
    store
        .exists(reference)
        .map_err(|_| "CREDENTIAL_STORE_UNAVAILABLE".into())
}

fn remove(store: &impl CredentialStore, reference: &str) -> Result<(), String> {
    if !valid_reference(reference) {
        return Err("INVALID_CREDENTIAL_INPUT".into());
    }
    store
        .delete(reference)
        .map_err(|_| "CREDENTIAL_STORE_UNAVAILABLE".into())
}

#[tauri::command]
pub(crate) fn store_secret(reference: String, value: String) -> Result<(), String> {
    save(&OsCredentialStore, &reference, &value)
}

#[tauri::command]
pub(crate) fn secret_status(reference: String) -> Result<bool, String> {
    status(&OsCredentialStore, &reference)
}

#[tauri::command]
pub(crate) fn delete_secret(reference: String) -> Result<(), String> {
    remove(&OsCredentialStore, &reference)
}

#[cfg(test)]
mod tests {
    use super::{remove, save, status, CredentialStore};
    use std::cell::{Cell, RefCell};

    #[derive(Default)]
    struct FakeStore {
        entries: RefCell<std::collections::HashMap<String, String>>,
        fail_read: Cell<bool>,
        fail_write: Cell<bool>,
    }

    impl CredentialStore for FakeStore {
        fn set(&self, reference: &str, value: &str) -> Result<(), ()> {
            if self.fail_write.get() {
                return Err(());
            }
            self.entries
                .borrow_mut()
                .insert(reference.into(), value.into());
            Ok(())
        }
        fn exists(&self, reference: &str) -> Result<bool, ()> {
            if self.fail_read.get() {
                return Err(());
            }
            Ok(self.entries.borrow().contains_key(reference))
        }
        fn delete(&self, reference: &str) -> Result<(), ()> {
            self.entries.borrow_mut().remove(reference);
            Ok(())
        }
    }

    #[test]
    fn saves_replaces_checks_and_deletes_without_returning_values() {
        let store = FakeStore::default();
        assert_eq!(status(&store, "pushplus:main"), Ok(false));
        assert_eq!(save(&store, "pushplus:main", "first-secret"), Ok(()));
        assert_eq!(status(&store, "pushplus:main"), Ok(true));
        assert_eq!(save(&store, "pushplus:main", "replacement"), Ok(()));
        assert_eq!(store.entries.borrow()["pushplus:main"], "replacement");
        assert_eq!(remove(&store, "pushplus:main"), Ok(()));
        assert_eq!(status(&store, "pushplus:main"), Ok(false));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn tauri_saved_secret_is_readable_by_core_keyring() {
        use std::process::Command;

        let reference = format!("statehub-interoperability-test:{}", std::process::id());
        let secret = "test-only-credential-value";
        let store = super::OsCredentialStore;
        save(&store, &reference, secret).expect("save test credential");
        let result = Command::new("node")
            .current_dir(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../core"))
            .env("STATE_HUB_TEST_SERVICE", super::SERVICE)
            .env("STATE_HUB_TEST_REF", &reference)
            .env("STATE_HUB_TEST_VALUE", secret)
            .arg("-e")
            .arg(r#"const { AsyncEntry } = require('@napi-rs/keyring'); new AsyncEntry(process.env.STATE_HUB_TEST_SERVICE, process.env.STATE_HUB_TEST_REF).getPassword().then(value => { if (value !== process.env.STATE_HUB_TEST_VALUE) process.exitCode = 1; }).catch(() => { process.exitCode = 2; });"#)
            .status();
        let cleanup = remove(&store, &reference);
        assert_eq!(cleanup, Ok(()));
        assert_eq!(result.expect("run Core keyring client").code(), Some(0));
    }

    #[test]
    fn read_and_write_failures_are_fixed_codes_without_secrets() {
        let store = FakeStore::default();
        store.fail_write.set(true);
        assert_eq!(
            save(&store, "pushplus:main", "sensitive-value"),
            Err("CREDENTIAL_STORE_UNAVAILABLE".into())
        );
        store.fail_read.set(true);
        assert_eq!(
            status(&store, "pushplus:main"),
            Err("CREDENTIAL_STORE_UNAVAILABLE".into())
        );
        assert_eq!(
            save(&store, "bad/ref", "value"),
            Err("INVALID_CREDENTIAL_INPUT".into())
        );
    }
}
