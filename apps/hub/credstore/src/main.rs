// Keychain custody for the hub's claude.ai session keys (ADR-0035, ADR-0138
// §6). The hub is a compiled Bun binary with no portable keychain access, so
// this helper owns the OS credential store round-trip. Secret travels over
// stdin/stdout only — NEVER argv (visible in process lists). The argument is
// the entry's account name, which is not secret: `usage-credential` (the
// legacy key), `usage-credential/<accountUuid>` (one Account's key) or
// `gateway-credential/<gatewayId>` (one Gateway's management key, ADR-0141 §7,
// its id 16 lowercase hex digits).
//
//   maxprice-credstore get    [<account>]  → secret on stdout; exit 3 if no entry
//   maxprice-credstore set    [<account>]  → secret read from stdin to EOF
//   maxprice-credstore delete [<account>]  → ok even if no entry
//
// An account name that is neither form is a usage error (exit 2), so no
// argument can name another service's entry. With no argument the account is
// `usage-credential`, or MAXPRICE_CREDSTORE_ACCOUNT when it is set (tests
// only, so a test round-trip never touches the real hub credential slot); the
// override never applies to an explicit argument.
use std::io::Read;
use std::process::exit;

const SERVICE: &str = "maxprice-hub";
const ACCOUNT: &str = "usage-credential";
const GATEWAY_ACCOUNT: &str = "gateway-credential";

// The Desktop client's rule for an account uuid (`valid_account_uuid`): 8 to
// 64 hex digits and dashes.
fn valid_account_uuid(uuid: &str) -> bool {
    (8..=64).contains(&uuid.len()) && uuid.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

// A Gateway's id (`gatewayId` in packages/shared/src/gateway.ts): exactly 16
// lowercase hex digits.
fn valid_gateway_id(id: &str) -> bool {
    id.len() == 16 && id.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f'))
}

// Whether `account` names one of the hub's entries.
fn valid_account(account: &str) -> bool {
    if account == ACCOUNT {
        return true;
    }
    if let Some(id) = account
        .strip_prefix(GATEWAY_ACCOUNT)
        .and_then(|rest| rest.strip_prefix('/'))
    {
        return valid_gateway_id(id);
    }
    match account
        .strip_prefix(ACCOUNT)
        .and_then(|rest| rest.strip_prefix('/'))
    {
        Some(uuid) => valid_account_uuid(uuid),
        None => false,
    }
}

// The entry's account: the argument when given (validated), else the
// override or the legacy name.
fn resolve_account(arg: Option<String>, env_override: Option<String>) -> Result<String, String> {
    match arg {
        Some(account) if valid_account(&account) => Ok(account),
        Some(_) => Err("invalid account name".to_string()),
        None => Ok(env_override.unwrap_or_else(|| ACCOUNT.to_string())),
    }
}

fn entry(account: &str) -> keyring::Entry {
    keyring::Entry::new(SERVICE, account).unwrap_or_else(|e| {
        eprintln!("keyring init: {e}");
        exit(2);
    })
}

fn usage() -> ! {
    eprintln!("usage: maxprice-credstore <get|set|delete> [<account>]");
    exit(2);
}

fn main() {
    let mut args = std::env::args().skip(1);
    let op = args.next().unwrap_or_default();
    let arg = args.next();
    if args.next().is_some() {
        usage();
    }
    if !matches!(op.as_str(), "get" | "set" | "delete") {
        usage();
    }
    let account = match resolve_account(arg, std::env::var("MAXPRICE_CREDSTORE_ACCOUNT").ok()) {
        Ok(account) => account,
        Err(message) => {
            eprintln!("{message}");
            exit(2);
        }
    };
    match op.as_str() {
        "get" => match entry(&account).get_password() {
            Ok(secret) => print!("{secret}"),
            Err(keyring::Error::NoEntry) => exit(3),
            Err(e) => {
                eprintln!("keyring read: {e}");
                exit(2);
            }
        },
        "set" => {
            let mut secret = String::new();
            if std::io::stdin().read_to_string(&mut secret).is_err() {
                eprintln!("stdin read failed");
                exit(2);
            }
            let trimmed = secret.trim_end_matches('\n');
            if let Err(e) = entry(&account).set_password(trimmed) {
                eprintln!("keyring write: {e}");
                exit(2);
            }
        }
        _ => match entry(&account).delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(e) => {
                eprintln!("keyring delete: {e}");
                exit(2);
            }
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_legacy_name_and_an_account_name_are_valid() {
        assert!(valid_account("usage-credential"));
        assert!(valid_account(
            "usage-credential/acc0fa4e-0000-4000-8000-000000000001"
        ));
        assert!(valid_account("usage-credential/ABCDEF01"));
    }

    #[test]
    fn anything_else_is_refused() {
        for bad in [
            "",
            "usage-credential/",
            "usage-credential/1234567",
            &format!("usage-credential/{}", "a".repeat(65)),
            "usage-credential/acc0fa4e-0000-4000-8000-00000000000g",
            "usage-credential/../other",
            "usage-credential//acc0fa4e",
            "usage-credentialx",
            "other-credential/acc0fa4e",
            "usage-credential/acc0fa4e/extra",
        ] {
            assert!(!valid_account(bad), "{bad:?} should be refused");
        }
    }

    #[test]
    fn a_gateway_name_is_valid() {
        assert!(valid_account("gateway-credential/0123456789abcdef"));
        assert!(valid_account("gateway-credential/ffffffffffffffff"));
    }

    #[test]
    fn a_malformed_gateway_name_is_refused() {
        for bad in [
            "gateway-credential",
            "gateway-credential/",
            "gateway-credential/0123456789abcde",
            "gateway-credential/0123456789abcdef0",
            "gateway-credential/0123456789ABCDEF",
            "gateway-credential/0123456789abcdeg",
            "gateway-credential/../usage-cred",
            "gateway-credential//0123456789abcdef",
            "gateway-credential/0123456789abcdef/extra",
            "gateway-credentialx/0123456789abcdef",
            "usage-credential/gateway-credential",
        ] {
            assert!(!valid_account(bad), "{bad:?} should be refused");
        }
    }

    #[test]
    fn the_override_applies_only_with_no_argument() {
        assert_eq!(
            resolve_account(None, Some("test-slot".to_string())),
            Ok("test-slot".to_string())
        );
        assert_eq!(resolve_account(None, None), Ok(ACCOUNT.to_string()));
        assert_eq!(
            resolve_account(
                Some("usage-credential/acc0fa4e".to_string()),
                Some("test-slot".to_string())
            ),
            Ok("usage-credential/acc0fa4e".to_string())
        );
        assert!(resolve_account(Some("bad".to_string()), Some("test-slot".to_string())).is_err());
    }
}
