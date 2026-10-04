//! Where the desktop app keeps a server graph's device token: the system keychain (macOS Keychain,
//! Windows Credential Manager), one item per graph address, never `desktop.json` (ADR 032).
//!
//! Why not the file: it is plain JSON in the user's config directory, readable by anything running
//! as the user and swept into backups and dotfile repos. Before proposal 005 the token lived in
//! each server origin's localStorage inside the webview's data store, which is no better; the
//! keychain is the one place on the Mac meant for it.
//!
//! A trait so the list logic can be tested without touching the real keychain (a test run must not
//! leave items in the developer's login keychain, nor trigger a macOS access prompt).

#[cfg(test)]
use std::collections::HashMap;
#[cfg(test)]
use std::sync::Mutex;

/// The keychain item's service name; the account is the graph's address.
pub const SERVICE: &str = "com.nooklet.desktop";

pub trait TokenStore: Send + Sync {
    fn get(&self, address: &str) -> Result<Option<String>, String>;
    fn set(&self, address: &str, token: &str) -> Result<(), String>;
    /// Removing a token that is not there is not an error.
    fn delete(&self, address: &str) -> Result<(), String>;
}

/// The real one. On macOS a generic password in the login keychain; on Windows a generic
/// credential. Linux is not a release target; there the `keyring` crate with no platform feature
/// keeps nothing across launches, which `get` then reports as "no token" (the add form asks again).
pub struct Keychain;

impl Keychain {
    fn entry(address: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(SERVICE, address).map_err(|e| format!("keychain: {e}"))
    }
}

impl TokenStore for Keychain {
    fn get(&self, address: &str) -> Result<Option<String>, String> {
        match Self::entry(address)?.get_password() {
            Ok(token) => Ok(Some(token)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("keychain: {e}")),
        }
    }

    fn set(&self, address: &str, token: &str) -> Result<(), String> {
        Self::entry(address)?.set_password(token).map_err(|e| format!("Could not save the token in the keychain: {e}"))
    }

    fn delete(&self, address: &str) -> Result<(), String> {
        match Self::entry(address)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("keychain: {e}")),
        }
    }
}

/// For tests.
#[cfg(test)]
#[derive(Default)]
pub struct MemoryStore(Mutex<HashMap<String, String>>);

#[cfg(test)]
impl TokenStore for MemoryStore {
    fn get(&self, address: &str) -> Result<Option<String>, String> {
        Ok(self.0.lock().unwrap().get(address).cloned())
    }

    fn set(&self, address: &str, token: &str) -> Result<(), String> {
        self.0.lock().unwrap().insert(address.to_string(), token.to_string());
        Ok(())
    }

    fn delete(&self, address: &str) -> Result<(), String> {
        self.0.lock().unwrap().remove(address);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_memory_store_behaves_like_the_keychain_contract() {
        let store = MemoryStore::default();
        assert_eq!(store.get("https://a.example.com/g/default"), Ok(None));
        store.set("https://a.example.com/g/default", "nk_one").unwrap();
        store.set("https://a.example.com/g/default", "nk_two").unwrap();
        assert_eq!(store.get("https://a.example.com/g/default"), Ok(Some("nk_two".into())));
        store.delete("https://a.example.com/g/default").unwrap();
        store.delete("https://a.example.com/g/default").unwrap();
        assert_eq!(store.get("https://a.example.com/g/default"), Ok(None));
    }

    /// The real keychain, end to end. Ignored by default: it writes to the login keychain of
    /// whoever runs it and may raise a macOS access prompt. Run by hand with
    /// `cargo test -- --ignored the_real_keychain`.
    #[test]
    #[ignore]
    fn the_real_keychain_round_trips() {
        let address = format!("https://keychain-test.example.invalid/g/t{}", std::process::id());
        let store = Keychain;
        assert_eq!(store.get(&address), Ok(None));
        store.set(&address, "nk_test").unwrap();
        assert_eq!(store.get(&address), Ok(Some("nk_test".into())));
        store.delete(&address).unwrap();
        assert_eq!(store.get(&address), Ok(None));
    }
}
