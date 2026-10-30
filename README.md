# MaxPrice (Release Repo)

**[User guide](https://meschoening.github.io/MaxPrice-Release/)**: how to install, set up and use each MaxPrice product.

Release code and binaries for MaxPrice, a Claude Code cost/token tracker.

**Transparency Note: This project was entirely generated and is entirely maintained through the use of Anthropic's Claude and OpenAI's GPT AI models. However, a human is always behind these AI-made changes.**

## Features:

- Plots token usage and price of usage as if you had to pay API rates.
- Pulls latest (USD) model pricing from LiteLLM, supports every Claude Haiku/Sonnet/Opus/Fable model.
- Allows split by model, machine, cache type, or git/folder-defined project.
- Connects to claude.ai for convenient comparison to account limits.
- (Optional) Hub app connects and tracks project usage across multiple devices.
- And more!

## Supported Platforms:

### Client:

- macOS (Universal .dmg, Intel or Apple Silicon): [install](https://meschoening.github.io/MaxPrice-Release/desktop-client/install.html#macos)
- Windows (Installer, portable coming soon): [install](https://meschoening.github.io/MaxPrice-Release/desktop-client/install.html#windows)
- Linux (.deb Installer): [install](https://meschoening.github.io/MaxPrice-Release/desktop-client/install.html#linux)
- Linux servers (Headless client: the `maxprice` terminal binary, x64): [install](https://meschoening.github.io/MaxPrice-Release/headless-client/overview.html#get-started), [manual](apps/cli/README.md)

### Hub:

- Windows (Installer): [install](https://meschoening.github.io/MaxPrice-Release/hub-tray-app/install.html)
- Linux servers (Headless Hub: the `maxprice-hub` terminal binary, x64): [install](https://meschoening.github.io/MaxPrice-Release/headless-hub/overview.html#get-started), [manual](apps/hub/README.md)

## Building from source

Requires [Bun](https://bun.sh) >= 1.3.14 and a stable Rust toolchain.

```sh
bun install --frozen-lockfile
bun run build        # desktop app -> apps/desktop/src-tauri/target/release/bundle/
bun run build:hub    # hub tray app -> apps/hub-desktop/src-tauri/target/release/bundle/
bun run build:cli    # Headless client -> apps/cli/binaries/maxprice
bun apps/hub/scripts/build-binaries.ts linux-x64   # Headless Hub -> apps/hub/binaries/maxprice-hub-x86_64-unknown-linux-gnu
```
