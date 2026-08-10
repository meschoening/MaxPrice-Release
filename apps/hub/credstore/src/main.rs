// Keychain custody for the hub's claude.ai session key (ADR-0035). The hub is
// a compiled Bun binary with no portable keychain access, so this helper owns
// the OS credential store round-trip. Secret travels over stdin/stdout only —
// NEVER argv (visible in process lists).
//
//   maxprice-credstore get     → secret on stdout; exit 3 if no entry
//   maxprice-credstore set     → secret read from stdin to EOF
//   maxprice-credstore delete  → ok even if no entry
//
// MAXPRICE_CREDSTORE_ACCOUNT overrides the account name (tests only, so a test
// round-trip never touches the real hub credential slot).
use std::io::Read;
use std::process::exit;

const SERVICE: &str = "maxprice-hub";
const ACCOUNT: &str = "usage-credential";

fn entry() -> keyring::Entry {
    let account =
        std::env::var("MAXPRICE_CREDSTORE_ACCOUNT").unwrap_or_else(|_| ACCOUNT.to_string());
    keyring::Entry::new(SERVICE, &account).unwrap_or_else(|e| {
        eprintln!("keyring init: {e}");
        exit(2);
    })
}

fn main() {
    let op = std::env::args().nth(1).unwrap_or_default();
    match op.as_str() {
        "get" => match entry().get_password() {
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
            if let Err(e) = entry().set_password(trimmed) {
                eprintln!("keyring write: {e}");
                exit(2);
            }
        }
        "delete" => match entry().delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(e) => {
                eprintln!("keyring delete: {e}");
                exit(2);
            }
        },
        _ => {
            eprintln!("usage: maxprice-credstore <get|set|delete>");
            exit(2);
        }
    }
}
