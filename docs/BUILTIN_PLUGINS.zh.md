# 内置插件（Internal Plugins）

内置插件（built-in plugin）是指随安装包分发、被视作应用本身一部分的插件。它们在 `src-tauri/resources/internal-plugins.json` 中声明，由 `scripts/prebuild.ts` 在构建期拉取到 `src-tauri/resources/internal-plugins/<id>/`，随 `bundle.resources` 一并打进安装包，并在服务启动时由 `src-tauri/src/service/plugin/internal.rs` 自动安装（并自愈）。

目前的内置插件：`dsh-tauri`、`dsh-tauri-ui`、`dsh-tauri-worktree`、`dsh-tauri-panel`、`dsh-tauri-panel-extension`。

## 内置插件 vs. 普通预装插件

| | 普通预装插件 | 内置（internal）插件 |
| --- | --- | --- |
| 清单 | `preset-plugins.json` | `internal-plugins.json` |
| 来源 | npm / GitHub，首次引导时安装 | 随安装包分发，启动时自动安装 |
| 出现在首次引导清单 | 是（`recommended` / `fix` / `defaultChecked` chip） | 否——它们“必装”，在 `installed.rs` 里被过滤掉 |
| 用户可卸载 | 可以 | 基本不行——下次启动自动恢复 |
| 版本来源 | 安装时按声明的 `spec` 解析 | 随安装包分发的捆绑产物 |

## 机制是怎么运作的

**构建期** — `scripts/prebuild.ts` 由 `pnpm build` 自动触发（`prebuild` 脚本，而 Tauri 的 `beforeBuildCommand` 恰好是 `pnpm build`）。对 `internal-plugins.json` 中的每个条目，它产出 `src-tauri/resources/internal-plugins/<id>/`：

- `github:owner/repo[#ref]` — 校验 ref 后执行 `git clone --depth 1 --single-branch`，核对清单中的完整 commit SHA，再执行 `pnpm install` → `pnpm run build`（存在 `build` 脚本时）→ 拷贝构建产物与 `package.json`。
- `name@version`（npm 包名，含 scoped `@scope/name`）— 用 `npm pack` 下载精确 tarball，核对清单中的 `sha512` 完整性摘要，再让 `pnpm` 在禁用脚本的前提下安装已核对的本地 tarball。

**运行期** — 在 harness 服务启动前，`service::plugin::internal::ensure` 逐个核对内部插件：① 它是否在当前档案的 `package.json` `dependencies` 中声明；② 声明值是否仍指向当前捆绑目录（`link:<绝对路径>`）；③ `node_modules/<package>` 是否真实存在。任一不满足（缺失 / 路径变更 / 用户卸载 / node_modules 被清空）→ 走常规安装流程，用 `link:` 依赖强制重装。

## 添加一个新的内置插件

### 1. 在 `src-tauri/resources/internal-plugins.json` 中声明

追加一条：

```json
{
  "id": "dsh-my-plugin",
  "spec": "github:you/dsh-my-plugin#v1.0.0",
  "commit": "0123456789abcdef0123456789abcdef01234567",
  "name": "DSH My Plugin",
  "description": "插件做什么",
  "repoUrl": "https://github.com/you/dsh-my-plugin"
}
```

字段说明：

- `id` — 预设唯一 id（仓库跳转 / 查找键；也是未显式声明 `package` 时的默认包名，用于“已安装”检测）。清单内 id 必须唯一（由 `preset_json_ids_are_unique` 单测保证）。
- `spec` — 来源。要么 `github:owner/repo[#ref]`（源码形态），要么精确 npm 包版本 `name@version`（已发布产物形态，跳过构建）。这是 `prebuild.ts` 喂给 git/npm/pnpm 的值。
- `integrity` — npm 来源必填，填写公共 npm registry 中该 tarball 的 `sha512-...` 完整性字符串。
- `commit` — Git 来源必填，填写完整 40 位 commit SHA；可选的 `#ref` 会先被校验并检出，随后与该 SHA 比对。
- `name`、`description`、`repoUrl` — 展示元数据；`repoUrl` 供界面“仓库跳转”链接使用。
- `package` — 可选。当真实 npm 包名与 `id` 不一致（常见于 scoped 包 `@scope/name`）时在这里声明；用于“已安装”检测与自愈对账。缺省回落 `id`。
- chip 标记 `recommended` / `fix` / `defaultChecked` — 对内置插件无意义（它们不进清单），保留也无妨。

### 2. 构建期打包

无需手工操作。`pnpm tauri build` 会执行 `pnpm build` → `pnpm prebuild` → `tsx scripts/prebuild.ts`，读取内部插件清单并产出 `src-tauri/resources/internal-plugins/<id>/`。构建机需要 PATH 上有 `git`、`npm` 与 `pnpm`，并能访问 GitHub（`github:` 来源）与 npm registry（包名来源）。

捆绑目录通过 `bundle.resources` 随安装包分发（`src-tauri/tauri.conf.json` 中的 `"resources": ["resources/**/*"]`）。`files` 只接受字面量安全相对路径，拒绝绝对路径、目录穿越和符号链接。

插件的 `package.json` 最好声明 `files` 白名单，让 prebuild 只拷贝运行必需文件；未声明时则拷贝整目录但排除 `node_modules` / `.git` / `.npmrc` 等。`package.json` 恒在最后拷贝，保证一定存在（它是 `pnpm add link:<目录>` 的包名/入口来源）。

### 3. 运行期自动安装接管后续

启动时 `service::plugin::internal::ensure` 核对插件已安装且安装 spec 指向捆绑目录；不满足则自动重装。无需任何前端/引导改动——用户不可能缺内置插件。

## 开发（debug）迭代

想在 debug 构建里快速迭代，可在仓库根 `.env`（参考 `.env.example`）里设置 `DEV_INTERNAL_PLUGINS_DIR`，指向存放插件源码的本地目录。对每个内置插件，运行时会查找 `<dir>/<id>`；命中则以该本地源码目录为安装目标（pnpm 目录联接，改源码后重启服务即热更新）——无需提交子插件 git、无需跑 prebuild。

规则：

- `.env` 已被 `.gitignore` 忽略，仅本地生效；该键只在 `debug_assertions` 构建读取（release 恒用随包目录）。
- 若 `<dir>` 缺该 id，则跳过（不回落随包目录），让开发者显式感知配置错误。
- 置空或删除该键 = 关闭覆盖（回落随包分发的 `resources/internal-plugins/<id>`）。

## 常见坑

- **为什么用 `link:` 而不是 `file:`** — pnpm 会把 `file:D:/...`（Windows 盘符绝对路径）当**相对路径**解析而失败（`scandir <cwd>\D:\... ENOENT`），`link:<绝对路径>` 才正确按绝对路径解析并建立目录联接。`bundled_dep_spec` 还会用 `dunce::simplified` 归一化 Windows `\\?\` verbatim 前缀，避免生成坏联接；否则自愈每轮都重装（死循环）。该 spec 在 Windows 上大小写不敏感比对，并容忍 `link:`/`file:` 混写与尾部斜杠差异。
- **路径含空格** — 应用安装目录（如 `G:\Deepseek Harness Desktop\...`）常含空格；`dsh plugin add` 经 shell 传参，`install.rs` 用 `shell_quote_spec` 给这类 spec 加内嵌双引号，不要去掉。
- **prebuild 响亮失败** — `scripts/prebuild.ts` 任何失败都会以非零退出码终止构建，宁可不发也不要发出损坏的内置插件。若 release 运行期仍缺捆绑目录，日志会记 `INTERNAL_PLUGIN_BUNDLE_MISSING`。
- **构建机访问** — prebuild 需要访问 GitHub/npm，PATH 上要有 `git`/`npm`/`pnpm`；它只用 Node 内置模块（零新增依赖）。
- **id 保持唯一** — 清单单测要求 id 唯一。插件自身的发布与版本号变更在其自己的仓库进行，不在本仓库内。

## 参考

- `src-tauri/resources/internal-plugins.json` — 你要编辑的内部插件清单。
- `scripts/prebuild.ts` — 构建期打包（git / npm 两种来源）。
- `src-tauri/src/service/plugin/preset.rs` — 清单解析、捆绑目录发现、`link:` spec 构造。
- `src-tauri/src/service/plugin/internal.rs` — 运行期自愈。
- `src-tauri/src/service/plugin/install.rs` — 自愈复用的安装编排。
