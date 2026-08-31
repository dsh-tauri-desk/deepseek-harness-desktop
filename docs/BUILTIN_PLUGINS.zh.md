# 内置插件（Internal Plugins）

内置插件（built-in plugin）是指随安装包分发、被视作应用本身一部分的插件。它们来源于本仓库 workspace 里 `packages/` 下的插件包；构建期由 `scripts/build-plugins.ts` 用 `pnpm deploy` 把 `packages/dsh-tauri-bundle/package.json` 中声明的插件打包到 `src-tauri/resources/node_modules/<name>`，随 `bundle.resources` 一并打进安装包，并在服务启动时由 `src-tauri/src/service/plugin/internal.rs` 自动安装（并自愈）。

目前的内置插件：`dsh-tauri`、`dsh-tauri-ui`、`dsh-tauri-worktree`、`dsh-tauri-panel`、`dsh-tauri-panel-extension`、`dsh-tauri-session`、`dsh-tauri-rightclick`。

## 内置插件 vs. 普通预装插件

| | 普通预装插件 | 内置（internal）插件 |
| --- | --- | --- |
| 清单 | `preset-plugins.json` | `internal-plugins.json` |
| 来源 | npm / GitHub，首次引导时安装 | `packages/` 下的 workspace 包，随安装包分发，启动时自动安装 |
| 出现在首次引导清单 | 是（`recommended` / `fix` / `defaultChecked` chip） | 否——它们“必装”，在 `installed.rs` 里被过滤掉 |
| 用户可卸载 | 可以 | 基本不行——下次启动自动恢复 |
| 版本来源 | 安装时按声明的 `spec` 解析 | 随安装包分发的捆绑产物 |

## 机制是怎么运作的

**构建期** — `scripts/build-plugins.ts` 由 `pnpm build` 自动触发（`prebuild` 脚本，pnpm 会在 `build` 前自动运行）。它：

1. 先构建每个运行插件包（排除 `dsh-tauri-bundle` 与 `dsh-tauri-tsdown`），
2. 再执行 `pnpm --filter dsh-tauri-bundle deploy --prod --config.inject-workspace-packages=true <临时目录>`，只把 `dsh-tauri-bundle` 的 `dependencies` 里列出的插件及其真实生产闭包打包到临时目录（注入式 deploy 避免把整个 workspace 的 UI 栈混进产物），
3. 逐个校验打包产物，然后把临时 `node_modules` 解引用复制（materialize）到 `src-tauri/resources/node_modules`。

内置插件集合 = 那些在 `package.json` 里带 `dsh` 对象的 workspace 包。`packages/dsh-tauri-bundle` 是一个 private 聚合包，它的 `dependencies` 明确列举了要打包哪些；运行插件是声明了 dsh 清单与 `main` 入口的 TS 模块。

**运行期** — 在 harness 服务启动前，`service::plugin::internal::ensure` 逐个核对内部插件：① 它是否在当前档案的 `package.json` `dependencies` 中声明；② 声明值是否仍指向当前捆绑目录（`link:<绝对路径>`）；③ `node_modules/<package>` 是否真实存在。任一不满足（缺失 / 路径变更 / 用户卸载 / node_modules 被清空）→ 走常规安装流程，用 `link:` 依赖强制重装。

## 添加一个新的内置插件

### 1. 在 `packages/` 下创建（或复用）一个 workspace 包

该包必须是 workspace 成员（由 `pnpm-workspace.yaml` 的 `packages: ['packages/*']` 隐式包含），并且：

- 它的 `package.json` 有 `main` 字段指向构建产物（如 `./dist/index.js`）；
- 它的 `package.json` 有非空 `dsh` 对象（运行期插件清单）；
- 它**不是** `private: true`（私有包——打包器 `dsh-tauri-bundle`、工具包 `dsh-tauri-tsdown`、演示占位插件 `dsh-tauri-panel-placeholder`——都不是内置插件）；
- 它声明了 `build` 脚本（如 `tsdown`），让 `build:plugins` 能产出其 `dist`。

### 2. 在 `packages/dsh-tauri-bundle/package.json` 中声明

把它加到该包的 `dependencies`，值为 `workspace:*`。这既是 `pnpm deploy`（打包哪些）的来源，也是 release `internal-plugins.json`（哪些参与自愈）的来源。

### 3. 在 `src-tauri/resources/internal-plugins.json` 中追加 release 清单条目

```json
{
  "id": "dsh-my-plugin",
  "spec": "dsh-my-plugin",
  "name": "DSH My Plugin",
  "description": "插件做什么",
  "repoUrl": "https://github.com/you/dsh-my-plugin"
}
```

字段说明：

- `id` — 预设唯一 id（仓库跳转 / 查找键；也是未显式声明 `package` 时的默认包名，用于“已安装”检测）。清单内 id 必须唯一（由 `plugin_manifest_ids_are_unique_across_files` 单测保证）。
- `spec` — 安装依赖键。内置插件必须匹配包的真实 npm 包名（通常与 id 相同，或 scoped `@scope/name`）。
- `name`、`description`、`repoUrl` — 展示元数据；`repoUrl` 供界面“仓库跳转”链接使用。
- `package` — 可选。当真实 npm 包名与 `id` 不一致（常见于 scoped 包 `@scope/name`）时在这里声明；用于“已安装”检测与自愈对账。缺省回落 `id`。
- chip 标记 `recommended` / `fix` / `defaultChecked` — 对内置插件无意义（它们不进清单），保留也无妨。

### 4. 构建期打包

无需手工操作。`pnpm tauri build` 会执行 `pnpm build`，其 `prebuild` 运行 `pnpm build:plugins`（`tsx scripts/build-plugins.ts`），把 `dsh-tauri-bundle` 的所有依赖打包进 `src-tauri/resources/node_modules/`。构建机需要 PATH 上有 `pnpm`；插件包是本地 workspace，因此运行插件本身无需访问 GitHub/npm（零网络拉取）。

捆绑目录通过 `bundle.resources` 随安装包分发（`src-tauri/tauri.conf.json` 中的 `"resources": ["resources/**/*"]`）。

### 5. 运行期自动安装接管后续

启动时 `service::plugin::internal::ensure` 核对插件已安装且安装 spec 指向捆绑目录；不满足则自动重装。无需任何前端/引导改动——用户不可能缺内置插件。

## 开发（debug）迭代

在 debug 构建里，运行期直接从 workspace 发现内置插件：任何非私有的 `packages/*` 包，只要其 `package.json` 带 `dsh` 对象，就自动成为内置插件。`bundled_plugin_dir` 把它的 id 映射到该源码目录，安装目标即插件源码（pnpm 目录联接，改源码后重启服务即热更新）——无需 `.env`、无需提交子插件 git、无需构建期打包。

规则：

- 发现只读 `package.json`；忽略没有 `dsh` 对象的目录、清单无法解析的目录以及 `private: true` 的包。
- 插件 id 是真实的 `package.name`，而不是目录名；id 会去重（第二个声明重名的包会被跳过并记 `DEV_INTERNAL_PLUGIN_DUPLICATE` 告警）。
- 若某 release 专属插件 id 在 `packages/` 下缺失，运行期回落随包分发的 `resources/node_modules/<name>`。

## 常见坑

- **为什么用 `link:` 而不是 `file:`** — pnpm 会把 `file:D:/...`（Windows 盘符绝对路径）当**相对路径**解析而失败（`scandir <cwd>\D:\... ENOENT`），`link:<绝对路径>` 才正确按绝对路径解析并建立目录联接。`bundled_dep_spec` 还会用 `dunce::simplified` 归一化 Windows `\\?\` verbatim 前缀，避免生成坏联接；否则自愈每轮都重装（死循环）。该 spec 在 Windows 上大小写不敏感比对，并容忍 `link:`/`file:` 混写与尾部斜杠差异。
- **路径含空格** — 应用安装目录（如 `G:\Deepseek Harness Desktop\...`）常含空格；`dsh plugin add` 经 shell 传参，`install.rs` 用 `shell_quote_spec` 给这类 spec 加内嵌双引号，不要去掉。
- **build:plugins 响亮失败** — `scripts/build-plugins.ts` 任何失败都会以非零退出码终止构建，宁可不发也不要发出损坏的内置插件。若 release 运行期仍缺捆绑目录，日志会记 `INTERNAL_PLUGIN_BUNDLE_MISSING`。
- **id 保持唯一** — 清单单测要求 id 唯一。插件自身的发布与版本号变更在其自己的仓库进行，不在本仓库内。

## 参考

- `packages/dsh-tauri-bundle/package.json` — 声明要打包的 workspace 包（通过 `dependencies`）。
- `scripts/build-plugins.ts` — 构建期打包（构建插件包，`pnpm deploy` 到 `resources/node_modules`）。
- `src-tauri/resources/internal-plugins.json` — release 内部插件清单。
- `src-tauri/src/service/plugin/preset.rs` — 清单解析、dev `packages/*` 发现、捆绑目录解析、`link:` spec 构造。
- `src-tauri/src/service/plugin/internal.rs` — 运行期自愈。
- `src-tauri/src/service/plugin/install.rs` — 自愈复用的安装编排。
