# Built-in (Internal) Plugins

Built-in plugins（内置插件）are plugins bundled with the installed desktop app and treated as part of the application itself. They are declared in `src-tauri/resources/internal-plugins.json`, fetched at build time by `scripts/prebuild.ts` into `src-tauri/resources/internal-plugins/<id>/`, shipped with the installer via `bundle.resources`, and auto-installed (and auto-healed) at service start by `src-tauri/src/service/plugin/internal.rs`.

Examples today: `dsh-tauri`, `dsh-tauri-ui`, `dsh-tauri-worktree`, `dsh-tauri-panel`, and `dsh-tauri-panel-extension`.

## Built-in vs. normal preset plugin

| | Normal preset plugin | Built-in (internal) plugin |
| --- | --- | --- |
| Manifest | `preset-plugins.json` | `internal-plugins.json` |
| Source | npm / GitHub, installed at first-launch onboarding | Bundled in the installer, auto-installed at startup |
| Shown in the first-launch checklist | Yes (`recommended` / `fix` / `defaultChecked` chips) | No — they are mandatory (filtered out in `installed.rs`) |
| User can uninstall | Yes | Effectively no — restored on the next launch |
| Version source | Resolved at install time from the declared `spec` | Bundled artifact shipped with the app |

## How the mechanism works

**Build time** — `scripts/prebuild.ts` is run automatically by `pnpm build` (the `prebuild` script, which Tauri invokes as its `beforeBuildCommand` = `pnpm build`). For each entry in `internal-plugins.json` it produces `src-tauri/resources/internal-plugins/<id>/`:

- `github:owner/repo[#ref]` — validate the ref, run `git clone --depth 1 --single-branch`, verify the manifest's full commit SHA, then run `pnpm install` → `pnpm run build` (if a `build` script exists) → copy the build output plus `package.json`.
- `name@version` (npm, incl. scoped `@scope/name`) — download the exact tarball with `npm pack`, verify its manifest `sha512` integrity, then let `pnpm` install that verified local tarball with scripts disabled.

**Runtime** — before the harness service launches, `service::plugin::internal::ensure` checks each internal plugin: ① it is declared in the current profile's `package.json` `dependencies`, ② the declared dependency value still points at the current bundled dir (`link:<abspath>`), ③ `node_modules/<package>` actually exists. If any check fails (missing / path changed / user removed it / `node_modules` wiped), it forces a reinstall through the normal install flow with a `link:` spec.

## Add a new built-in plugin

### 1. Declare it in `src-tauri/resources/internal-plugins.json`

Append an entry:

```json
{
  "id": "dsh-my-plugin",
  "spec": "github:you/dsh-my-plugin#v1.0.0",
  "commit": "0123456789abcdef0123456789abcdef01234567",
  "name": "DSH My Plugin",
  "description": "What the plugin does",
  "repoUrl": "https://github.com/you/dsh-my-plugin"
}
```

Field reference:

- `id` — unique preset id (the repo jump / lookup key; also the default npm package name used for install-state detection). Ids must be unique across the list (enforced by the `preset_json_ids_are_unique` unit test).
- `spec` — the source. Either `github:owner/repo[#ref]` (source form) or an exact npm package version `name@version` (published form, skips the build). This is what `prebuild.ts` feeds to git/npm/pnpm.
- `integrity` — required for an exact npm source. It must be the tarball's `sha512-...` integrity string from the public npm registry.
- `commit` — required for a Git source. It must be the full 40-character commit SHA; an optional `#ref` is validated and checked out before this SHA is compared.
- `name`, `description`, `repoUrl` — display metadata. `repoUrl` is used for the repo-jump link in the UI.
- `package` — optional. When the real npm package name differs from `id` (typical for scoped `@scope/name`), declare it here; it is used for install-state detection and self-heal matching. Defaults to `id`.
- Chip flags `recommended` / `fix` / `defaultChecked` — not meaningful for internal plugins (they never appear in the checklist) but harmless to keep.

### 2. Bundle it at build time

No manual step. `pnpm tauri build` runs `pnpm build` → `pnpm prebuild` → `tsx scripts/prebuild.ts`, which reads the internal manifest and produces `src-tauri/resources/internal-plugins/<id>/`. The build machine needs `git`, `npm`, and `pnpm` on PATH and network access to GitHub (for `github:` sources) and npm (for package-name sources).

The bundled directory is shipped with the installer via `bundle.resources` (`"resources": ["resources/**/*"]` in `src-tauri/tauri.conf.json`). The build accepts only literal, safe relative paths from a package's `files` array and rejects absolute paths, traversal, and symbolic links.

The plugin's `package.json` should declare a `files` whitelist so prebuild copies only the runtime-necessary files; when absent it copies the whole directory minus `node_modules` / `.git` / `.npmrc` etc. `package.json` is always copied last so it is guaranteed present (it is the package-name/entry source for `pnpm add link:<dir>`).

### 3. Runtime auto-install handles the rest

On startup, `service::plugin::internal::ensure` verifies the plugin is installed and that the installed spec points at the bundled dir; if not, it reinstalls automatically. No UI work and no onboarding checkbox — a user can never be left without a built-in plugin.

## Development (debug) iteration

For fast iteration in a debug build, set the `DEV_INTERNAL_PLUGINS_DIR` key in the repo-root `.env` (see `.env.example`) to a local directory holding the plugin sources. For each internal plugin the runtime looks up `<dir>/<id>`; if present, that local source dir becomes the install target (a pnpm directory junction), so editing the source and restarting the service hot-reloads the plugin — no sub-plugin git commit and no `prebuild`.

Rules:

- `.env` is gitignored and local-only; the key is only read in `debug_assertions` builds (release always uses the packaged dir).
- If the id is missing in `<dir>`, the plugin is skipped rather than falling back to the packaged dir, so the misconfiguration is noticed explicitly.
- Setting it empty or deleting the key disables the override (falls back to the packaged `resources/internal-plugins/<id>`).

## Gotchas

- **Why `link:` and not `file:`** — pnpm resolves `file:D:/...` (a Windows drive-absolute path) as a *relative* path and fails (`scandir <cwd>\D:\... ENOENT`), while `link:<abspath>` resolves the absolute path correctly and creates a directory junction. `bundled_dep_spec` also strips the Windows `\\?\` verbatim prefix via `dunce::simplified` so the junction is not corrupted; otherwise the self-heal reinstalls on every launch (an infinite loop). The spec is compared case-insensitively on Windows, tolerating `link:`/`file:` mix and trailing-slash differences.
- **Paths with spaces** — the install dir (e.g. `G:\Deepseek Harness Desktop\...`) often contains spaces; `dsh plugin add` passes the spec through a shell, so `install.rs` wraps such specs in embedded double quotes (`shell_quote_spec`). Don't remove that.
- **prebuild fails loudly** — `scripts/prebuild.ts` exits non-zero on any failure so the build breaks rather than shipping a broken internal plugin. If a bundled dir is still missing at runtime in a release build, the log emits `INTERNAL_PLUGIN_BUNDLE_MISSING`.
- **Build machine access** — prebuild needs network access to GitHub/npm and `git`/`npm`/`pnpm` on PATH; it only uses Node built-ins (no new deps).
- **Keep ids unique** — the manifest unit tests require unique ids. Publishing and version-bumping the plugin itself happens in its own repo, outside this one.

## Reference

- `src-tauri/resources/internal-plugins.json` — the internal plugin manifest you edit.
- `scripts/prebuild.ts` — build-time bundling (git / npm sources).
- `src-tauri/src/service/plugin/preset.rs` — manifest parsing, bundled-dir discovery, and the `link:` spec builder.
- `src-tauri/src/service/plugin/internal.rs` — runtime self-heal.
- `src-tauri/src/service/plugin/install.rs` — the install orchestration reused by the self-heal.
