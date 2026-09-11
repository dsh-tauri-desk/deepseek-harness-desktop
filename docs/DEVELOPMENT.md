# Development

DeepSeek Harness Desktop is a **Tauri 2 + React 19** app: the UI lives in `src/`, the Rust backend in `src-tauri/`. The repository uses pnpm 10 and the desktop's bundled runtime is Node.js 22.22.0.

## Requirements

| Tool | Version |
| --- | --- |
| Node.js | 22.19+ (CI and bundled runtime: 22.22.0) |
| Rust | 1.77.2+ |
| pnpm | 10.x (`pnpm@10.28.2`) |

Plus the platform toolchain:

- **Windows** — MSVC build tools + WebView2
- **macOS** — Xcode Command Line Tools
- **Linux** — WebKit2GTK

## Commands

```bash
pnpm install          # install dependencies
pnpm dev              # frontend dev server (Vite)
pnpm dev:plugins      # watch built-in plugins
pnpm typecheck        # frontend TypeScript check
pnpm build:plugins    # build built-in plugin bundles
pnpm tauri dev        # run the desktop app in debug mode
pnpm tauri build      # build installers
```

Backend checks (from `src-tauri/`):

```bash
cargo check
cargo test
```

For Developer ID signing, notarization, and the required GitHub Actions secrets, see [macOS signing and notarization](./spec/MACOS_SIGNING.md).

To add a new built-in (internal) plugin bundled with the app, see [Built-in (Internal) Plugins](./spec/BUILTIN_PLUGINS.md).

## Tips

- Debug mode serves on port **3081**, release builds on **3080** — the two never clash, so you can run an installed copy and a dev build side by side.
- Debug data is isolated from release data: it uses `~/.dsh.dev` and `.store.dev.dat`; it does not migrate release data or register a production `dsh` PATH shim.
