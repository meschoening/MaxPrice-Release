# MaxPrice (Release Repo)

Release code and binaries for MaxPrice, a Claude Code cost/token tracker.

## Features:

- Plots token usage and price of usage as if you had to pay API rates.
- Pulls latest (USD) model pricing from LiteLLM, supports every Claude Haiku/Sonnet/Opus/Fable model.
- Connects to claude.ai for convenient comparison to account limits.
- (Optional) Hub app connects and tracks project usage across multiple devices.
- And more!

## Supported Platforms:

### Client:

- macOS (Intel and Apple Silicon)
- Windows (Installer, portable coming soon)
- Linux (.deb Installer)

### Hub:

- Windows (Installer)
- (Linux coming soon)

## Building from source

Requires [Bun](https://bun.sh) >= 1.3.14 and a stable Rust toolchain.

```sh
bun install --frozen-lockfile
bun run build        # desktop app -> apps/desktop/src-tauri/target/release/bundle/
bun run build:hub    # hub tray app -> apps/hub-desktop/src-tauri/target/release/bundle/
```
