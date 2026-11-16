// One keychain entry per Account (ADR-0138 §2, §6; #633). Each Account's
// credential lives in the OS keychain under service `maxprice-desktop`,
// account `usage-credential/<accountUuid>`, as the JSON the renderer wrote
// (`accountCredentialSchema`: `{ sessionKey, kind, setAt, orgId? }`), which
// Rust stores as an opaque string. One entry per key keeps each far under
// Windows Credential Manager's 2560-byte blob cap, which one entry for every
// key would reach at a handful.
//
// The keyring cannot list its entries on every platform, so the uuids, which
// are not secret, are kept in `usage-credentials.json` beside settings.json:
// `{ "version": 1, "accounts": [uuid, ...] }`, sorted, written atomically.
// A set writes the entry, then lists it; a delete unlists it, then deletes the
// entry. So a crash between the two leaves at worst an entry no list names
// (invisible, and overwritten by the next Connect of that Account), never a
// listed uuid with no entry that a read would trip on; and a read that finds
// one anyway (a keychain the user edited) skips it and drops it from the list.
//
// A uuid is validated before it names an entry, so a renderer bug cannot
// reach another account name in the same service (`hub-password`, the legacy
// `usage-credential`). The legacy entry stays readable and deletable through
// lib.rs's get/set_credential until the renderer moves it (§12).

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Manager};

const SERVICE: &str = "maxprice-desktop";
const ENTRY_PREFIX: &str = "usage-credential/";
const LIST_FILE: &str = "usage-credentials.json";
const LIST_VERSION: u64 = 1;

// Serializes every list read-modify-write in this process.
static LIST_LOCK: Mutex<()> = Mutex::new(());

/// One Account's stored credential, as `list_account_credentials` answers it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountCredentialValue {
    pub account_uuid: String,
    pub value: String,
}

/// Whether `uuid` may name an entry: 8 to 64 ASCII hex digits and dashes.
pub fn valid_account_uuid(uuid: &str) -> bool {
    (8..=64).contains(&uuid.len()) && uuid.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
}

fn entry_name(uuid: &str) -> String {
    format!("{ENTRY_PREFIX}{uuid}")
}

/// The uuids a list file's text names: only valid ones, sorted, each once.
/// Tolerant, like settings.json: a malformed file or a wrong version names
/// none, so it self-heals on the next set rather than failing every read.
pub fn parse_account_list(text: &str) -> Vec<String> {
    let value: serde_json::Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[credentials] ignoring malformed {LIST_FILE} ({e})");
            return Vec::new();
        }
    };
    if value.get("version").and_then(|v| v.as_u64()) != Some(LIST_VERSION) {
        eprintln!("[credentials] ignoring {LIST_FILE} of an unknown version");
        return Vec::new();
    }
    let mut out: Vec<String> = value
        .get("accounts")
        .and_then(|a| a.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str())
                .filter(|uuid| valid_account_uuid(uuid))
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    out.sort();
    out.dedup();
    out
}

/// The list file's text for `accounts` (sorted, each once).
pub fn account_list_json(accounts: &[String]) -> serde_json::Value {
    let mut sorted = accounts.to_vec();
    sorted.sort();
    sorted.dedup();
    serde_json::json!({ "version": LIST_VERSION, "accounts": sorted })
}

/// `list` with `uuid` in it (sorted, each once).
pub fn with_account(list: &[String], uuid: &str) -> Vec<String> {
    let mut out = list.to_vec();
    out.push(uuid.to_owned());
    out.sort();
    out.dedup();
    out
}

/// `list` without `uuid`.
pub fn without_account(list: &[String], uuid: &str) -> Vec<String> {
    list.iter()
        .filter(|u| u.as_str() != uuid)
        .cloned()
        .collect()
}

/// The list at `path`; an absent file is the empty list.
pub fn read_account_list_at(path: &Path) -> Result<Vec<String>, String> {
    match fs::read_to_string(path) {
        Ok(text) => Ok(parse_account_list(&text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(format!("{LIST_FILE} read error: {e}")),
    }
}

/// Writes the list at `path` atomically (settings.json's temp-and-rename).
pub fn write_account_list_at(path: &Path, accounts: &[String]) -> Result<(), String> {
    crate::write_json_atomic(path, &account_list_json(accounts))
}

fn list_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir unavailable: {e}"))?;
    Ok(dir.join(LIST_FILE))
}

fn entry(uuid: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, &entry_name(uuid)).map_err(|e| format!("keyring init: {e}"))
}

fn lock() -> std::sync::MutexGuard<'static, ()> {
    LIST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[tauri::command]
pub fn list_account_credentials(
    window: tauri::Window,
    app: AppHandle,
) -> Result<Vec<AccountCredentialValue>, String> {
    crate::require_main_window(window.label(), "list_account_credentials")?;
    let _guard = lock();
    let path = list_path(&app)?;
    let listed = read_account_list_at(&path)?;
    let mut out = Vec::new();
    let mut missing = Vec::new();
    for uuid in &listed {
        match entry(uuid)?.get_password() {
            Ok(value) => out.push(AccountCredentialValue {
                account_uuid: uuid.clone(),
                value,
            }),
            Err(keyring::Error::NoEntry) => missing.push(uuid.clone()),
            // Any other failure is the keychain's, not the list's: the uuid
            // stays listed for the next read.
            Err(e) => return Err(format!("keyring read: {e}")),
        }
    }
    if !missing.is_empty() {
        let kept: Vec<String> = listed
            .iter()
            .filter(|u| !missing.contains(u))
            .cloned()
            .collect();
        write_account_list_at(&path, &kept)?;
    }
    Ok(out)
}

#[tauri::command]
pub fn set_account_credential(
    window: tauri::Window,
    app: AppHandle,
    account_uuid: String,
    value: Option<String>,
) -> Result<(), String> {
    crate::require_main_window(window.label(), "set_account_credential")?;
    if !valid_account_uuid(&account_uuid) {
        return Err("invalid account uuid".into());
    }
    let _guard = lock();
    let path = list_path(&app)?;
    let entry = entry(&account_uuid)?;
    match value {
        Some(secret) => {
            entry
                .set_password(&secret)
                .map_err(|e| format!("keyring write: {e}"))?;
            let listed = read_account_list_at(&path)?;
            if !listed.contains(&account_uuid) {
                write_account_list_at(&path, &with_account(&listed, &account_uuid))?;
            }
            Ok(())
        }
        None => {
            let listed = read_account_list_at(&path)?;
            if listed.contains(&account_uuid) {
                write_account_list_at(&path, &without_account(&listed, &account_uuid))?;
            }
            match entry.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(e) => Err(format!("keyring delete: {e}")),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_uuid_is_8_to_64_hex_digits_and_dashes() {
        assert!(valid_account_uuid("0b9c6f2e-1d4a-4c7e-9f3b-2a8d5e6c7b10"));
        assert!(valid_account_uuid("ABCDEF12"));
        assert!(valid_account_uuid(&"a".repeat(64)));
        assert!(!valid_account_uuid("abcdef1"));
        assert!(!valid_account_uuid(&"a".repeat(65)));
        assert!(!valid_account_uuid(""));
        // Nothing that could name another entry, or a path.
        assert!(!valid_account_uuid("../hub-password"));
        assert!(!valid_account_uuid("abcdefgh"));
        assert!(!valid_account_uuid("abcd ef12"));
        assert!(!valid_account_uuid("abcdef12/"));
        assert!(!valid_account_uuid("ａｂｃｄｅｆ１２"));
    }

    #[test]
    fn an_entry_is_named_under_the_prefix() {
        assert_eq!(entry_name("abcdef12"), "usage-credential/abcdef12");
    }

    #[test]
    fn the_list_parses_sorted_valid_and_once() {
        let text = r#"{"version":1,"accounts":["bbbbbbbb","aaaaaaaa","bbbbbbbb","not a uuid",7]}"#;
        assert_eq!(parse_account_list(text), vec!["aaaaaaaa", "bbbbbbbb"]);
    }

    #[test]
    fn a_malformed_or_unknown_list_names_none() {
        assert!(parse_account_list("{ not json").is_empty());
        assert!(parse_account_list(r#"{"version":2,"accounts":["aaaaaaaa"]}"#).is_empty());
        assert!(parse_account_list(r#"{"accounts":["aaaaaaaa"]}"#).is_empty());
        assert!(parse_account_list(r#"{"version":1}"#).is_empty());
    }

    #[test]
    fn adding_and_removing_keep_the_list_sorted_and_unique() {
        let list = vec!["bbbbbbbb".to_string()];
        let added = with_account(&list, "aaaaaaaa");
        assert_eq!(added, vec!["aaaaaaaa", "bbbbbbbb"]);
        assert_eq!(with_account(&added, "aaaaaaaa"), added);
        assert_eq!(without_account(&added, "aaaaaaaa"), vec!["bbbbbbbb"]);
        assert_eq!(without_account(&added, "cccccccc"), added);
    }

    #[test]
    fn the_list_file_round_trips_and_an_absent_one_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(LIST_FILE);
        assert!(read_account_list_at(&path).unwrap().is_empty());
        write_account_list_at(&path, &["cccccccc".into(), "aaaaaaaa".into()]).unwrap();
        assert_eq!(
            read_account_list_at(&path).unwrap(),
            vec!["aaaaaaaa", "cccccccc"]
        );
        let text = fs::read_to_string(&path).unwrap();
        let value: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(
            value,
            serde_json::json!({ "version": 1, "accounts": ["aaaaaaaa", "cccccccc"] })
        );
        // Written atomically: no temp sibling is left behind.
        let leftovers = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .count();
        assert_eq!(leftovers, 0);
    }

    #[test]
    fn the_answer_is_camel_case() {
        let value = AccountCredentialValue {
            account_uuid: "aaaaaaaa".into(),
            value: "{}".into(),
        };
        assert_eq!(
            serde_json::to_value(&value).unwrap(),
            serde_json::json!({ "accountUuid": "aaaaaaaa", "value": "{}" })
        );
    }
}
