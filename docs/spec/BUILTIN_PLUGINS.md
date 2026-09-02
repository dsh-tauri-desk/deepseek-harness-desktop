# Built-in (Internal) Plugins

Built-in plugins（内置插件）are plugins bundled with the installed desktop app and treated as part of the application itself. Their source is the monorepo workspace packages under `packages/`; at build time `scripts/build-plugins.ts` uses `pnpm deploy` to pack the plugins listed in `packages/dsh-tauri-bundle/package.json` into `src-tauri/resources/node_modules/<name>`, which is shipped with the installer via `bundle.resources`, and them auto-installed (and auto-healed) at service start by `src-tauri/src/service/plugin/internal.rs`.

Examples today: `dsh-tauri`, `dsh-tauri-ui`, `dsh-tauri-worktree`, `dsh-tauri-panel`, `dsh-tauri-panel-extension`, `dsh-tauri-panel-scheduler`, `dsh-tauri-session`, and `dsh-tauri-rightclick`.

## Built-in vs. normal preset plugin

| | Normal preset plugin | Built-in (internal) plugin |
| --- | --- | --- |
| Manifest | `preset-plugins.json` | `internal-plugins.json` |
| Source | npm / GitHub, installed at first-launch onboarding | Workspace package under `packages/`, bundled in the installer, auto-installed at startup |
| Shown in the first-launch checklist | Yes (`recommended` / `fix` / `defaultChecked` chips) | No — they are mandatory (filtered out in `installed.rs`) |
| User can uninstall | Yes | Effectively no — restored on the next launch |
| Version source | Resolved at install time from the declared `spec` | Bundled artifact shipped with the app |

## How the mechanism works

**Build time** — `scripts/build-plugins.ts` is run automatically by `pnpm build` (the `prebuild` script, which pnpm runs automatically before `build`). It:

1. builds every runtime plugin package (`dsh-tauri-bundle` and `dsh-tauri-tsdown` are excluded),
2. runs `pnpm --filter dsh-tauri-bundle deploy --prod --config.inject-workspace-packages=true <temp>` to pack only the plugins listed in `dsh-tauri-bundle`'s `dependencies` (plus their real production closure) into a temporary directory — the injected deploy avoids dragging the whole workspace's UI stack into the bundle,
3. verifies each bundled package, then materializes the temporary `node_modules` (dereferencing any links) into `src-tauri/resources/node_modules`.

The built-in plugin set is the workspace packages that contain a `dsh` object in their `package.json`. `packages/dsh-tauri-bundle` is a private aggregation package whose `dependencies` enumerate exactly which of those should be bundled; the running plugin packages are TS modules that declare their dsh manifest and a `main` entry.

**Runtime** — before the harness service launches, `service::plugin::internal::ensure` checks each internal plugin: ① it is declared in the current profile's `package.json` `dependencies`, ② the declared dependency value still points at the current bundled dir (`link:<abspath>`), ③ `node_modules/<package>` actually exists. If any check fails (missing / path changed / user removed it / `node_modules` wiped), it forces a reinstall through the normal install flow with a `link:` spec.

## Add a new built-in plugin

### 1. Create (or reuse) a workspace package under `packages/`

The package must be a workspace member (implicit via `pnpm-workspace.yaml`'s `packages: ['packages/*']`) and:

- its `package.json` has a `main` field pointing at the built entry (e.g. `./dist/index.js`),
- its `package.json` has a non-empty `dsh` object (the runtime plugin manifest),
- it is **not** `private: true` (private packages — the bundler `dsh-tauri-bundle`, the tooling `dsh-tauri-tsdown`, and the demo placeholder `dsh-tauri-panel-placeholder` — are not built-in plugins),
- it declares a `build` script (e.g. `tsdown`) so `build:plugins` can produce its `dist`.

### 2. Declare it in `packages/dsh-tauri-bundle/package.json`

Add it to that package's `dependencies` as `workspace:*`. This is the source both for `pnpm deploy` (what gets bundled) and for release `internal-plugins.json` (what gets self-healed).

### 3. Add a release manifest entry in `src-tauri/resources/internal-plugins.json`

```json
{
  "id": "dsh-my-plugin",
  "spec": "dsh-my-plugin",
  "name": "DSH My Plugin",
  "description": "What the plugin does",
  "repoUrl": "https://github.com/you/dsh-my-plugin"
}
```

Field reference:

- `id` — unique preset id (the repo jump / lookup key; also the default npm package name used for install-state detection). Ids must be unique across the list (enforced by the `plugin_manifest_ids_are_unique_across_files` unit test).
- `spec` — the install dependency key. For built-in plugins it must match the package's real npm name (usually the same as the id, or a scoped `@scope/name`).
- `name`, `description`, `repoUrl` — display metadata. `repoUrl` is used for the repo-jump link in the UI.
- `package` — optional. When the real npm package name differs from `id` (typical for scoped `@scope/name`), declare it here; it is used for install-state detection and self-heal matching. Defaults to `id`.
- Chip flags `recommended` / `fix` / `defaultChecked` — not meaningful for internal plugins (they never appear in the checklist) but harmless to keep.

### 4. Bundle it at build time

No manual step. `pnpm tauri build` runs `pnpm build`, whose `prebuild` runs `pnpm build:plugins` (`tsx scripts/build-plugins.ts`) and packs all `dsh-tauri-bundle` dependencies into `src-tauri/resources/node_modules/`. The build machine needs `pnpm` on PATH; the plugin packages are local, so no network access to GitHub/npm is required for the runtime plugins themselves.

The bundled directory is shipped with the installer via `bundle.resources` (`"resources": ["resources/**/*"]` in `src-tauri/tauri.conf.json`).

### 5. Runtime auto-install handles the rest

On startup, `service::plugin::internal::ensure` verifies the plugin is installed and that the installed spec points at the bundled dir; if not, it reinstalls automatically. No UI work and no onboarding checkbox — a user can never be left without a built-in plugin.

## Development (debug) iteration

In a debug build the runtime discovers built-in plugins directly from the workspace: any non-private `packages/*` package whose `package.json` has a `dsh` object is automatically an internal plugin. `bundled_plugin_dir` maps its id to that source directory, so the install target is the plugin source (a pnpm directory junction) — editing the source and restarting the service hot-reloads the plugin. No `.env`, no sub-plugin git commit, and no build-time bundling.

Rules:

- Discovery reads `package.json` only; it ignores directories without a `dsh` object, directories with an unparseable manifest, and `private: true` packages.
- The plugin id is the real `package.name`, not the directory name; ids are deduplicated (a second package declaring the same name is skipped with a `DEV_INTERNAL_PLUGIN_DUPLICATE` warning).
- If a release-only plugin id is missing from `packages/`, the runtime falls back to the packaged `resources/node_modules/<name>`.

## Gotchas

- **Why `link:` and not `file:`** — pnpm resolves `file:D:/...` (a Windows drive-absolute path) as a *relative* path and fails (`scandir <cwd>\D:\... ENOENT`), while `link:<abspath>` resolves the absolute path correctly and creates a directory junction. `bundled_dep_spec` also strips the Windows `\\?\` verbatim prefix via `dunce::simplified` so the junction is not corrupted; otherwise the self-heal reinstalls on every launch (an infinite loop). The spec is compared case-insensitively on Windows, tolerating `link:`/`file:` mix and trailing-slash differences.
- **Paths with spaces** — the install dir (e.g. `G:\Deepseek Harness Desktop\...`) often contains spaces; `dsh plugin add` passes the spec through a shell, so `install.rs` wraps such specs in embedded double quotes (`shell_quote_spec`). Don't remove that.
- **build:plugins fails loudly** — `scripts/build-plugins.ts` exits non-zero on any failure so the build breaks rather than shipping a broken internal plugin. If a bundled dir is still missing at runtime in a release build, the log emits `INTERNAL_PLUGIN_BUNDLE_MISSING`.
- **Keep ids unique** — the manifest unit tests require unique ids. Publishing and version-bumping the plugin itself happens in its own repo, outside this one.

## Reference

- `packages/dsh-tauri-bundle/package.json` — declares which workspace packages are bundled (via `dependencies`).
- `scripts/build-plugins.ts` — build-time bundling (builds plugin packages, `pnpm deploy` into `resources/node_modules`).
- `src-tauri/resources/internal-plugins.json` — the release internal plugin manifest.
- `src-tauri/src/service/plugin/preset.rs` — manifest parsing, dev `packages/*` discovery, bundled-dir resolution, and the `link:` spec builder.
- `src-tauri/src/service/plugin/internal.rs` — runtime self-heal.
- `src-tauri/src/service/plugin/install.rs` — the install orchestration reused by the self-heal.
