// One keychain entry per Gateway (ADR-0141 §7; #651), on the model of the
// per-Account keys (account_credentials.rs, ADR-0138 §6). Each Gateway's
// management key lives in the OS keychain under service `maxprice-desktop`,
// account `gateway-credential/<id>`, where `<id>` is the Gateway's id: the
// first 16 hex digits of the SHA-256 of its normalized URL, which the
// renderer derives (`gatewayId`, packages/shared/src/gateway.ts). Rust checks
// only the id's shape and trusts its derivation, as it trusts an Account's
// uuid.
//
// The keyring cannot list its entries on every platform, and an entry name
// carries no URL, so the Gateways, which are not secret, are kept in
// `gateways.json` beside settings.json: `{ "version": 1, "gateways": [{ "id",
// "url" }, ...] }`, sorted by id, written atomically. As for the Accounts, a
// set writes the entry, then lists it; a delete unlists it, then deletes the
// entry; and a read that finds a listed Gateway with no entry skips it and
// drops it from the list. The file is first written by the first set, and the
// last delete leaves it empty.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Manager};

const SERVICE: &str = "maxprice-desktop";
const ENTRY_PREFIX: &str = "gateway-credential/";
const LIST_FILE: &str = "gateways.json";
const LIST_VERSION: u64 = 1;
// `GATEWAY_URL_MAX` in packages/shared/src/gateway.ts.
const URL_MAX: usize = 2048;

// Serializes every list read-modify-write in this process.
static LIST_LOCK: Mutex<()> = Mutex::new(());

/// One listed Gateway: its id and the normalized URL the renderer gave.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ListedGateway {
    pub id: String,
    pub url: String,
}

/// One Gateway's stored credential, as `list_gateway_credentials` answers it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayCredentialValue {
    pub id: String,
    pub url: String,
    pub management_key: String,
}

/// Whether `id` may name an entry: exactly 16 lowercase hex digits
/// (`GATEWAY_ID_PATTERN`).
pub fn valid_gateway_id(id: &str) -> bool {
    id.len() == 16 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Whether `url` may be listed: an http(s) URL of at most 2048 bytes with no
/// control characters. The renderer normalizes it (`normalizeGatewayUrl`);
/// this only keeps the list file from holding anything else.
pub fn valid_gateway_url(url: &str) -> bool {
    url.len() <= URL_MAX
        && (url.starts_with("http://") || url.starts_with("https://"))
        && !url.chars().any(char::is_control)
}

/// Whether `key` may be stored: printable ASCII with no spaces, 1 to 512
/// characters (`gatewayManagementKeySchema`).
pub fn valid_management_key(key: &str) -> bool {
    (1..=512).contains(&key.len()) && key.bytes().all(|b| (0x21..=0x7e).contains(&b))
}

fn entry_name(id: &str) -> String {
    format!("{ENTRY_PREFIX}{id}")
}

/// The Gateways a list file's text names: only valid ones, sorted by id, each
/// id once (the first wins). Tolerant, like settings.json: a malformed file
/// or a wrong version names none, so it self-heals on the next set.
pub fn parse_gateway_list(text: &str) -> Vec<ListedGateway> {
    let value: serde_json::Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[gateways] ignoring malformed {LIST_FILE} ({e})");
            return Vec::new();
        }
    };
    if value.get("version").and_then(|v| v.as_u64()) != Some(LIST_VERSION) {
        eprintln!("[gateways] ignoring {LIST_FILE} of an unknown version");
        return Vec::new();
    }
    let items: Vec<ListedGateway> = value
        .get("gateways")
        .and_then(|a| a.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let id = item.get("id")?.as_str()?;
                    let url = item.get("url")?.as_str()?;
                    (valid_gateway_id(id) && valid_gateway_url(url)).then(|| ListedGateway {
                        id: id.to_owned(),
                        url: url.to_owned(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    sorted_unique(items)
}

fn sorted_unique(items: Vec<ListedGateway>) -> Vec<ListedGateway> {
    let mut out: Vec<ListedGateway> = Vec::new();
    for item in items {
        if !out.iter().any(|g| g.id == item.id) {
            out.push(item);
        }
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

/// The list file's JSON for `gateways` (sorted by id, each id once).
pub fn gateway_list_json(gateways: &[ListedGateway]) -> serde_json::Value {
    let sorted = sorted_unique(gateways.to_vec());
    serde_json::json!({ "version": LIST_VERSION, "gateways": sorted })
}

/// `list` with `gateway` in it, replacing a listed Gateway of the same id.
pub fn with_gateway(list: &[ListedGateway], gateway: &ListedGateway) -> Vec<ListedGateway> {
    let mut out = vec![gateway.clone()];
    out.extend(list.iter().filter(|g| g.id != gateway.id).cloned());
    sorted_unique(out)
}

/// `list` without the Gateway of `id`.
pub fn without_gateway(list: &[ListedGateway], id: &str) -> Vec<ListedGateway> {
    list.iter().filter(|g| g.id != id).cloned().collect()
}

/// The list at `path`; an absent file is the empty list.
pub fn read_gateway_list_at(path: &Path) -> Result<Vec<ListedGateway>, String> {
    match fs::read_to_string(path) {
        Ok(text) => Ok(parse_gateway_list(&text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(format!("{LIST_FILE} read error: {e}")),
    }
}

/// Writes the list at `path` atomically (settings.json's temp-and-rename).
pub fn write_gateway_list_at(path: &Path, gateways: &[ListedGateway]) -> Result<(), String> {
    crate::write_json_atomic(path, &gateway_list_json(gateways))
}

fn list_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir unavailable: {e}"))?;
    Ok(dir.join(LIST_FILE))
}

fn entry(id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, &entry_name(id)).map_err(|e| format!("keyring init: {e}"))
}

fn lock() -> std::sync::MutexGuard<'static, ()> {
    LIST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[tauri::command]
pub fn list_gateway_credentials(
    window: tauri::Window,
    app: AppHandle,
) -> Result<Vec<GatewayCredentialValue>, String> {
    crate::require_main_window(window.label(), "list_gateway_credentials")?;
    let _guard = lock();
    let path = list_path(&app)?;
    let listed = read_gateway_list_at(&path)?;
    let mut out = Vec::new();
    let mut missing = Vec::new();
    for gateway in &listed {
        match entry(&gateway.id)?.get_password() {
            Ok(management_key) => out.push(GatewayCredentialValue {
                id: gateway.id.clone(),
                url: gateway.url.clone(),
                management_key,
            }),
            Err(keyring::Error::NoEntry) => missing.push(gateway.id.clone()),
            // Any other failure is the keychain's, not the list's: the
            // Gateway stays listed for the next read.
            Err(e) => return Err(format!("keyring read: {e}")),
        }
    }
    if !missing.is_empty() {
        let kept: Vec<ListedGateway> = listed
            .iter()
            .filter(|g| !missing.contains(&g.id))
            .cloned()
            .collect();
        write_gateway_list_at(&path, &kept)?;
    }
    Ok(out)
}

#[tauri::command]
pub fn set_gateway_credential(
    window: tauri::Window,
    app: AppHandle,
    id: String,
    url: String,
    management_key: String,
) -> Result<(), String> {
    crate::require_main_window(window.label(), "set_gateway_credential")?;
    if !valid_gateway_id(&id) {
        return Err("invalid gateway id".into());
    }
    if !valid_gateway_url(&url) {
        return Err("invalid gateway url".into());
    }
    if !valid_management_key(&management_key) {
        return Err("invalid management key".into());
    }
    let _guard = lock();
    let path = list_path(&app)?;
    entry(&id)?
        .set_password(&management_key)
        .map_err(|e| format!("keyring write: {e}"))?;
    let listed = read_gateway_list_at(&path)?;
    let gateway = ListedGateway { id, url };
    if !listed.contains(&gateway) {
        write_gateway_list_at(&path, &with_gateway(&listed, &gateway))?;
    }
    Ok(())
}

#[tauri::command]
pub fn delete_gateway_credential(
    window: tauri::Window,
    app: AppHandle,
    id: String,
) -> Result<(), String> {
    crate::require_main_window(window.label(), "delete_gateway_credential")?;
    if !valid_gateway_id(&id) {
        return Err("invalid gateway id".into());
    }
    let _guard = lock();
    let path = list_path(&app)?;
    let listed = read_gateway_list_at(&path)?;
    if listed.iter().any(|g| g.id == id) {
        write_gateway_list_at(&path, &without_gateway(&listed, &id))?;
    }
    match entry(&id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("keyring delete: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gw(id: &str, url: &str) -> ListedGateway {
        ListedGateway {
            id: id.into(),
            url: url.into(),
        }
    }

    const A: &str = "aaaaaaaaaaaaaaaa";
    const B: &str = "0123456789abcdef";

    #[test]
    fn an_id_is_16_lowercase_hex_digits() {
        assert!(valid_gateway_id(A));
        assert!(valid_gateway_id(B));
        assert!(!valid_gateway_id("0123456789ABCDEF"));
        assert!(!valid_gateway_id("0123456789abcde"));
        assert!(!valid_gateway_id("0123456789abcdef0"));
        assert!(!valid_gateway_id(""));
        // Nothing that could name another entry, or a path.
        assert!(!valid_gateway_id("../hub-password0"));
        assert!(!valid_gateway_id("0123456789abcde/"));
        assert!(!valid_gateway_id("0123456789abcdeg"));
    }

    #[test]
    fn a_url_is_http_or_https_bounded_and_without_controls() {
        assert!(valid_gateway_url("http://box:8317"));
        assert!(valid_gateway_url("https://gw.example.com/base"));
        assert!(!valid_gateway_url("ftp://box"));
        assert!(!valid_gateway_url("box:8317"));
        assert!(!valid_gateway_url("http://box\n"));
        assert!(!valid_gateway_url(&format!(
            "http://{}",
            "a".repeat(URL_MAX)
        )));
    }

    #[test]
    fn a_management_key_is_printable_ascii_without_spaces() {
        assert!(valid_management_key("k"));
        assert!(valid_management_key(&"~".repeat(512)));
        assert!(!valid_management_key(""));
        assert!(!valid_management_key(&"a".repeat(513)));
        assert!(!valid_management_key("a b"));
        assert!(!valid_management_key("a\tb"));
        assert!(!valid_management_key("é"));
    }

    #[test]
    fn an_entry_is_named_under_the_prefix() {
        assert_eq!(entry_name(B), "gateway-credential/0123456789abcdef");
    }

    #[test]
    fn the_list_parses_sorted_valid_and_once() {
        let text = format!(
            r#"{{"version":1,"gateways":[
                {{"id":"{A}","url":"http://a"}},
                {{"id":"{B}","url":"http://b"}},
                {{"id":"{A}","url":"http://dup"}},
                {{"id":"not an id","url":"http://c"}},
                {{"id":"{B}"}},
                {{"id":"bbbbbbbbbbbbbbbb","url":"ftp://x"}},
                7
            ]}}"#
        );
        assert_eq!(
            parse_gateway_list(&text),
            vec![gw(B, "http://b"), gw(A, "http://a")]
        );
    }

    #[test]
    fn a_malformed_or_unknown_list_names_none() {
        assert!(parse_gateway_list("{ not json").is_empty());
        let v2 = format!(r#"{{"version":2,"gateways":[{{"id":"{A}","url":"http://a"}}]}}"#);
        assert!(parse_gateway_list(&v2).is_empty());
        let unversioned = format!(r#"{{"gateways":[{{"id":"{A}","url":"http://a"}}]}}"#);
        assert!(parse_gateway_list(&unversioned).is_empty());
        assert!(parse_gateway_list(r#"{"version":1}"#).is_empty());
    }

    #[test]
    fn adding_replaces_by_id_and_removing_drops_it() {
        let list = vec![gw(A, "http://a")];
        let added = with_gateway(&list, &gw(B, "http://b"));
        assert_eq!(added, vec![gw(B, "http://b"), gw(A, "http://a")]);
        assert_eq!(with_gateway(&added, &gw(B, "http://b")), added);
        // A set of a listed id with a new URL replaces its URL.
        assert_eq!(
            with_gateway(&added, &gw(A, "http://a2")),
            vec![gw(B, "http://b"), gw(A, "http://a2")]
        );
        assert_eq!(without_gateway(&added, A), vec![gw(B, "http://b")]);
        assert_eq!(without_gateway(&added, "cccccccccccccccc"), added);
    }

    #[test]
    fn the_list_file_round_trips_and_an_absent_one_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(LIST_FILE);
        assert!(read_gateway_list_at(&path).unwrap().is_empty());
        write_gateway_list_at(&path, &[gw(A, "http://a"), gw(B, "http://b")]).unwrap();
        assert_eq!(
            read_gateway_list_at(&path).unwrap(),
            vec![gw(B, "http://b"), gw(A, "http://a")]
        );
        let text = fs::read_to_string(&path).unwrap();
        let value: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "version": 1,
                "gateways": [{ "id": B, "url": "http://b" }, { "id": A, "url": "http://a" }]
            })
        );
        // The last delete leaves it empty, not absent.
        write_gateway_list_at(&path, &[]).unwrap();
        assert!(read_gateway_list_at(&path).unwrap().is_empty());
        let value: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(value, serde_json::json!({ "version": 1, "gateways": [] }));
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
        let value = GatewayCredentialValue {
            id: A.into(),
            url: "http://a".into(),
            management_key: "k".into(),
        };
        assert_eq!(
            serde_json::to_value(&value).unwrap(),
            serde_json::json!({ "id": A, "url": "http://a", "managementKey": "k" })
        );
    }
}
