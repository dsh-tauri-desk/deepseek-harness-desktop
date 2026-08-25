<p align="center">
  <a href="https://github.com/hairyf/deepseek-harness-desktop">
    <img src="public/favicon.svg" width="96" alt="DeepSeek Harness Desktop" />
  </a>
</p>

<h1 align="center">DeepSeek Harness Desktop</h1>

<p align="center">
  Run <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a> on your desktop, instantly —<br />
  no Node.js, no pnpm, no Docker. Download, install, go.
</p>

<p align="center">
  <a href="https://github.com/hairyf/deepseek-harness-desktop/releases">
    <img src="https://img.shields.io/github/v/release/hairyf/deepseek-harness-desktop?style=flat-square&label=release&color=4D6BFE" alt="Release" />
  </a>
  <img src="https://img.shields.io/github/downloads/hairyf/deepseek-harness-desktop/total?style=flat-square&label=downloads&color=4D6BFE" alt="Downloads" />
  <img src="https://img.shields.io/github/stars/hairyf/deepseek-harness-desktop?style=flat-square&label=stars&color=4D6BFE" alt="Stars" />
  <img src="https://img.shields.io/github/license/hairyf/deepseek-harness-desktop?style=flat-square&label=license&color=4D6BFE" alt="MIT License" />
  <img src="https://img.shields.io/badge/Windows%20%7C%20macOS%20%7C%20Linux-black?style=flat-square" alt="Windows | macOS | Linux" />
</p>

<p align="center">
  <samp><strong>English</strong> · <a href="./README.md">中文</a></samp>
</p>

<p align="center">
  <img src="./docs/images/hero-en.png" width="100%" alt="DSH Desktop English promotional banner" />
</p>

> [More preview images](./docs/PREVIEW.md)

## Features

- ⚡️ **Zero setup** — First launch needs no Node runtime or Harness core; uses the local environment by default and does not modify your existing system environment.
- 🔄 **Core update** — Syncs the latest upstream Harness version in-app, so upstream updates take effect without reinstalling; supports managing multiple core versions.
- 🖥️ **Config** — One dialog for Debug / Profiles / Plugins / Core, with bilingual (zh/en) UI labels and dark-mode support.
- 🗂️ **Profile isolation** — Profiles are isolated from each other in the config; plugins, patches, and settings stay independent and do not interfere.
- 🧩 **Plugin management** — The plugin panel manages installed plugins; when something misbehaves it offers upgrade / uninstall entry points plus error details.
- 🎁 **Built-in plugins** — Ships with bundled plugins; more high-quality built-in plugins are coming in the future.
- 🪶 **Native & lightweight** — A Tauri 2 shell (not Electron): smaller installers, lower memory, native windows.
- ⌨️ **CLI integration** — Install automatically registers the `dsh` command, ready in a new terminal; does not overwrite your existing shell config.
- 🧭 **Launch wizard** — On first launch, choose recommended plugins, or re-select them later in config.
- 🚀 **Self-update** — In-app updates; no need to re-download.

## Presets

Plugins offered in the first-run wizard; select what you need and install on demand:

- [DSH Win Terminal Inspector](https://github.com/clearkurt/dsh-win-terminal-inspector) — Windows-only fix for Minimal mode
- [DSH Market](https://github.com/dsh-market/dsh-market) — browse, search, and one-click install community plugins (Recommended)
- [DSH Better Sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) — a VSCode-like right sidebar, isolated per session (Recommended)
- [DSH Notification](https://github.com/omdsh-dev/dsh-notification) — desktop notifications when a turn completes
- [DSH Session Context Menu](https://github.com/baihejiangnan/dsh-session-context-menu) — DSH right-click menu: adds common actions for sessions, workspaces, the input box, and links

> Want to add new presets? Modify [preset-plugins.json](https://github.com/hairyf/deepseek-harness-desktop/blob/main/src-tauri/resources/preset-plugins.json) and submit a PR — once approved, it will be added as a preset in a future version.

## Built-in plugins

First-party plugins bundled with the installer:

- [DSH Tauri](https://github.com/dsh-tauri-desk/dsh-tauri) — provides a communication channel with the Tauri 2 shell
- [DSH Tauri UI](https://github.com/dsh-tauri-desk/dsh-tauri-ui) — provides a custom settings sidebar for the Tauri 2 shell
- [DSH Tauri Worktree](https://github.com/dsh-tauri-desk/dsh-tauri-worktree) — creates an isolated Git worktree per session, with checkout to a local branch or archive-and-abandon flows
- More coming soon...

## Quick Start

Download the installer for your platform from [Releases](https://github.com/hairyf/deepseek-harness-desktop/releases), install, and launch.

**macOS (Homebrew):** you can also install it in one command via Homebrew:

```bash
brew install dsh-tauri-desk/desktop/deepseek-harness
```

The first run downloads the Node runtime and Harness core (if `dsh` is already installed, the installed version is used), then takes you straight into the harness at `http://127.0.0.1:3080`; after that everything runs locally — no network required.

**System requirements:** Windows 10+ · macOS 10.15+ · Linux (AppImage / .deb) · network on first launch

> **Linux Wayland note (PikaOS / GNOME Wayland / Ubuntu 22.04+):** AppImage may crash or render black on Wayland due to WebKitGTK; the app auto-fixes the common case. <details><summary>If it still crashes / renders black:</summary><br>**Prefer `.deb`** (verified on PikaOS 4 Wayland), or manually run `WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1 GDK_BACKEND=x11 ./AppImage`. If icons do not appear, copy the app's `hicolor` icons to `~/.local/share/icons` and run `update-desktop-database`.<br></details>

## Dev

Want to get involved in development? See [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md).

## How It Works

```text
┌──────────────────────────────────────────────┐
│ Tauri WebView (React)                        │
│   setup state machine → progress → iframe    │
│   loads the dsh web UI + sidebar controls    │
└──────────────────────┬───────────────────────┘
                       │ invoke commands + events
┌──────────────────────┴───────────────────────┐
│ Tauri Rust backend                           │
│   service/download  installer + extraction   │
│   service/core      Harness core versions    │
│   service/profile   dsh profile management   │
│   service/plugin    plugin remove / upgrade  │
│   service/cli       dsh command shim + PATH  │
│   service/update    desktop self-update      │
│   service/workflow  dsh process lifecycle    │
│   task              dsh health checks        │
└──────┬───────────────────────────┬───────────┘
       │                           │
  runtime/ (Node.js v22.22.0)   dependencies/dsh/ (prebuilt bundle)
       └─────────────┬─────────────┘
                     ▼
   dsh --profile <profile> --host 127.0.0.1 --port 3080
                     │  DSH_HOME=~/.dsh
                     ▼
        http://127.0.0.1:3080/  ← embedded UI
```

The prebuilt Harness bundle is published by [deepseek-harness-pkg](https://github.com/dsh-tauri-desk/deepseek-harness-pkg). Every launch compares against the latest release and prompts you to download the update when the local one is outdated — keeping the local install when GitHub is unreachable. A local core installed globally via the CLI is preferred when present.

## Notes

> [!WARNING]
> **Developer preview** — upstream `dsh` is evolving fast with breaking changes; this project tracks it closely.

> [!NOTE]
> **Security** — `dsh` can execute code locally. For learning / research / testing only; run it in a trusted, isolated environment.

## Related

- [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) — the upstream `dsh` agent platform
- [deepseek-harness-pkg](https://github.com/dsh-tauri-desk/deepseek-harness-pkg) — prebuilt Harness bundles consumed by this app
- [n8n-desktop](https://github.com/tangtao646/n8n-desktop) — reference implementation

## License

[MIT](./LICENSE) with a [Non-Commercial Condition](./LICENSE.details) © deepseek-harness-desktop contributors
