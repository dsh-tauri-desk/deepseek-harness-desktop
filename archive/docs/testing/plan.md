# 测试计划（DeepSeek Harness 桌面版）

> 目标产品：DeepSeek Harness 桌面版（Tauri 2 外壳 + React 18 前端 + Rust 后端）
> 测试范围：全部核心功能
> 生成方式：基于等价类划分与边界值分析（见 `testcase-generator` skill），并融合 ISTQB 测试生命周期与 ISO 25010 质量模型（见 `quality-report.md`）
> 输出目录：`docs/test-case/`
> 配套文档：`checklist.md`（测试任务清单与质量门禁）、`quality-report.md`（质量报告与 ISO 25010）、`all_cases.md`（全部用例汇总）

---

## 一、产品概述

桌面端一键运行 DeepSeek Harness（`dsh`）：首次启动自动装配内置 Node 运行时与 Harness 内核，无需用户安装 Node/pnpm/Docker；通过 Tauri 2 在 `127.0.0.1` 本地端口提供服务；包含核心多版本管理、档案隔离、插件管理、应用配置中心、命令行集成（`dsh` shim + PATH）、首次启动引导与桌面端自更新。纯本地运行、默认关闭遥测，中英双语界面、支持暗色模式。

- **端口隔离**：release 默认 `3080`，debug（`pnpm tauri dev` / `cargo build`）默认 `3081`，由 `config::setting::default_port()` 用 `cfg!(debug_assertions)` 区分，避免开发时与已运行的桌面端争用端口。
- **数据隔离（核心共用、数据不共用）**：node/`dependencies/dsh`/`dependencies/pnpm` 为共用核心（AppData）；`$DSH_HOME` 默认 `~/.dsh`（release）/`~/.dsh.dev`（debug），store 文件 `.store.dat`/`.store.dev.dat`；debug 不迁移旧数据、不注册/注销 PATH、不写烘焙 DSH_HOME 的 `dsh` shim。
- **Windows 极简模式**：预装插件流程为 Windows 用户列出「修复」项（`dsh-win-terminal-inspector`），确认后 `dsh plugin add github:clearkurt/dsh-win-terminal-inspector` 安装；随后写入 profile `cordis.patch.yml` 挂载行并生成基于 Git Bash + danger-full-access 的用户 preset。

## 二、测试范围与质量目标

### 2.1 测试范围（Testing Scope）

| 维度 | 范围 | 对应代码 |
| --- | --- | --- |
| 后端（Rust/Tauri） | 配置、下载/安装、核心多版本管理、档案管理、插件管理、CLI shim 与 PATH、自更新、进程生命周期、健康检查、Tauri 命令桥、桌面窗口集成、日志 | `src-tauri/src/**` |
| 前端（React） | 安装状态机、下载进度、内嵌 iframe、侧边栏控制、配置对话框（调试/档案/插件/核心）、更新对话框、插件恢复、i18n、主题、store 状态管理 | `src/**` |
| 跨层集成 | 前端 `invoke` 命令 + 事件 ↔ 后端命令桥；WebView 内嵌 dsh UI；进程启动/停止；PATH 注册后的 CLI 可用性 | `bridge/**` + `layout/**` |
| 资源 | 预设插件清单、内嵌 WebView、运行时/发行版产物 | `src-tauri/resources/**` |
| 发布 | release（`:3080` / `~/.dsh`）与 debug（`:3081` / `~/.dsh.dev`）隔离，三平台安装包 | `src-tauri/**` + `dependencies/**` |

### 2.2 质量目标（Quality Objectives）

| 目标 | 可测量成功标准 |
| --- | --- |
| 功能正确性 | 100% 验收标准被测试用例覆盖；首次装配、档案切换、核心切换、插件装卸、自更新等核心路径无失败 |
| 稳定性 | 核心 E2E 场景通过率 ≥ 95%；无 critical / high 级缺陷进入发布 |
| 数据隔离 | release 与 debug 数据/端口互不污染（验证 `.store.dat` 与 `.store.dev.dat`、`~/.dsh` 与 `~/.dsh.dev`） |
| 代码质量 | 关键路径行覆盖率 ≥ 80%、分支覆盖率 ≥ 90%；无未处理 panic |
| 本地化 | 中英双语 key 同步，无硬编码字符串，桌面与后端文案一致 |
| 安全 | 无 critical 级漏洞；本地代码执行能力被限制在可信/隔离环境并给出明确提示 |

## 三、测试策略与设计技术

### 3.1 测试方法（Test Approach）

- **分层测试**：单元 → 集成 → 端到端，由下而上；后端以 `cargo test`，前端以 Vitest，E2E 遵循 Tauri 官方推荐（`@tauri-apps/api/mocks` 的 `mockIPC`/`mockWindows` 或 WebDriver）。
- **风险驱动**：优先覆盖装配、核心/档案切换、插件、CLI、自更新等高风险路径。
- **平台矩阵**：Windows / macOS / Linux；其中 Windows 额外覆盖极简模式与进程树回收。
- **自动化优先**：单元与集成自动化，E2E 对关键路径自动化；其余采用探索性测试补足。
- **隔离验证**：由于 release/debug 使用不同端口与数据目录，测试需分别断言两者互不影响。
- **一次一变量**：一次测试只改变一个变量，其余输入保持有效值（正交干扰最小化）。

### 3.2 测试设计技术（Test Design Techniques）

以等价类划分法为主、边界值分析法为辅，纳入 ISTQB 各设计技术：

| 技术 | 适用场景 | 典型用例 |
| --- | --- | --- |
| **等价类划分** | 端口号、版本号、档案名、插件开关等输入域 | 合法/非法端口（`default_port`）、合法/非法档案名 |
| **边界值分析** | 端口边界、下载大小、超时阈值、版本号上下限 | `3080`/`3081` 边界；超时 `0`、`1`、`MAX`；下载大小 `0`/正好/超限 |
| **决策表测试** | 安装状态机、配置项组合（调试/档案/插件/核心）、插件修复项 | 首启装配各状态组合；`fix` 与 `recommended` 勾选组合 |
| **状态转换测试** | 安装状态机（下载→解压→装配→就绪）；核心切换后服务重启；窗口生命周期 | 装配各状态转移；下载中断/重试；核心切换前后状态 |
| **基于经验的测试** | 探索性验证：断网、磁盘满、进程被手动杀掉、端口被外部占用 | 异常路径手工探索 |

### 3.3 测试类型覆盖矩阵（Test Types Coverage Matrix）

| 测试类型 | 后端 | 前端 | 覆盖重点 |
| --- | --- | --- | --- |
| **功能测试** | ● | ● | 装配、档案、核心、插件、CLI、更新全部功能 |
| **非功能测试** | ● | ● | 首次启动性能、内存占用、UI 响应、暗色/双语一致性 |
| **结构测试** | ● | ● | 关键路径行/分支覆盖率（Rust `tarpaulin` / Vitest coverage） |
| **变更相关测试** | ● | ● | 每次版本升级后的回归；调试/生产构建隔离回归 |

## 四、风险评估（Risk Assessment）

| 风险 | 等级 | 影响 | 缓解策略 |
| --- | --- | --- | --- |
| 首次装配下载失败 / 网络不可达 | 高 | 无法进入 Harness 界面 | 失败可重试、保留本地已装配产物；前置断网场景测试 |
| 内核版本切换后服务未重启或端口被占 | 高 | 界面无法加载、进程残留 | 进程树回收（`taskkill /T /F`）、`WM_SETTINGCHANGE`、健康检查轮询 |
| PATH 注册 / shim 失效 | 高 | 新终端无法使用 `dsh` | 安装后 `cli::ensure`；检查 `%LOCALAPPDATA%\deepseek-harness\bin` 与 shim 转义 |
| 插件安装/升级/卸载异常 | 中 | 插件损坏、面板异常 | 插件恢复（recovery）、只读展示 + 升级/卸载入口、错误详情同步 |
| 档案配置污染 | 中 | 各档案插件/补丁/设置互相干扰 | 档案隔离验证、切换后服务重启 |
| Windows 极简模式不支持 `win32` | 中 | 持久 shell 报错 | `win-terminal-inspector` 预设修复（仅 Windows，幂等） |
| 自更新失败 / 版本回退 | 中 | 无法获取新版本 | 独立检查 GitHub 最新版、失败保留本地、开发/生产构建端口与数据隔离 |
| iframe 跨源通信 / 消息桥失效 | 高 | 侧边栏控制不起作用 | iframe origin 校验、消息桥（dsh-tauri）契约测试 |
| 安全声明：`dsh` 具备本地代码执行能力 | 高 | 代码执行风险 | 文档声明 + 隔离环境 + 安装来源白名单（预设插件清单） |

> ITEM 级风险详见「五、测试项与测试点」各表「风险」列。

## 五、测试项（ITEM）与测试点（POINT）

> 目录映射：`docs/test-case/<ITEM 目录>/<POINT 文件>.md`
> 优先级：P1 核心正向 / P2 基本正向 / P3 核心异常 / P4 边界 / P5 低频

### ITEM 1：安装与首次启动（目录 `01-install`，风险：高）

| # | 测试点（POINT） | 风险 | 输入项/关注点 |
|---|--------------|------|--------------|
| 1 | 运行时与内核依赖安装 | 高 | 首次启动自动下载内置 Node 运行时与 Harness 内核；安装状态机（Initial→Installing→Running）；`install_dependencies` 返回 bool |
| 2 | 下载与解压进度 | 高 | 两阶段进度（下载 0–50、解压 50–100）；进度事件实时推送；失败重试（官方直连→ghfast.top 镜像兜底） |
| 3 | 本机 Node/Pnpm 复用 | 高 | 本机已有兼容 Node/pnpm 时直接复用，不修改系统环境；未检测到才走内置运行时 |
| 4 | 首次启动预设插件引导 | 高 | 预设清单（`resources/preset-plugins.json`）；`get_preinstall_plugins`/`install_preinstall_plugins`/`skip_preinstall_plugins`/`cancel_preinstall_plugins`/`get_preinstall_pending`/`open_preinstall_repo`；指纹（preset_hash）决定重新进入引导 |
| 5 | 安装失败与网络异常处理 | 高 | GitHub 不可达；下载/校验/解压失败；镜像兜底失败；提示与重试 |

### ITEM 2：Harness 核心管理（目录 `02-core`，风险：高）

| # | 测试点（POINT） | 风险 | 输入项/关注点 |
|---|--------------|------|--------------|
| 1 | 核心列表展示 | 高 | `get_cores`；本地核心（local）与预打包（app/app-<tag>）；同版本 tag 去重；离线/限流时降级磁盘扫描 |
| 2 | 激活核心切换 | 高 | `set_active_core`；local/app/app-<tag> 目录互换；切换前停服务；失败回滚 |
| 3 | 历史版本下载 | 高 | `download_core`（tag）；SHA-256 摘要校验（缺失安全中止）；幂等（已下载直接返回）；两阶段进度 |
| 4 | 历史版本卸载 | 中 | `remove_core`；激活中版本不可卸载；先停服务防句柄锁定；删除失败提示 |
| 5 | 本地核心更新 | 中 | `update_local_core`；npm/pnpm 布局探测；`@latest` 升级；失败返回输出尾部 |

### ITEM 3：进程生命周期与健康检查（目录 `03-lifecycle`，风险：高）

| # | 测试点（POINT） | 风险 | 输入项/关注点 |
|---|--------------|------|--------------|
| 1 | 服务启动 | 高 | `launch_harness`；`dsh --profile <当前档案> --host 127.0.0.1 --port <port>`；启动成功进入 Running |
| 2 | 服务停止与重启 | 高 | `shutdown_harness`/`restart_harness`；Windows 下 `taskkill /T /F` 杀进程树防 DLL 锁；重启后状态恢复 |
| 3 | 状态流转与健康检查 | 高 | `get_dsh_status`/`dsh-status-updated` 事件；Initial/Installing/Starting/Running/Stopped；定时健康检查与异常自愈 |

### ITEM 4：应用配置中心（目录 `04-config`，风险：中）

| # | 测试点（POINT） | 风险 | 输入项/关注点 |
|---|--------------|------|--------------|
| 1 | 配置对话框与管理 | 中 | `get_app_config`/`update_app_config`；调试/档案/插件/核心四个分页；字段校验与保存 |
| 2 | 语言与主题 | 中 | `set_language`（zh-CN/en）；`get_dsh_theme`（light/dark/system）；界面实时切换；i18n 扁平键 |
| 3 | 侧边栏与偏好设置 | 低 | `toggle_sidebar`；`auto_start`、`cli_link_enabled` 等开关 |
| 4 | 设置持久化 | 中 | `setting_updated` 事件；store 键（installed/port/active_profile/active_core/cli_link_enabled/preinstall_done/preset_hash/dsh_home_migrated/dsh_pkg_tag/dsh_pkg_commit） |

### ITEM 5：档案隔离管理（目录 `05-profile`，风险：高）

| # | 测试点（POINT） | 风险 | 输入项/关注点 |
|---|--------------|------|--------------|
| 1 | 档案列表与展示 | 中 | `get_profiles`；默认档案 web 置顶；稳定排序；空目录/未初始化回退 web |
| 2 | 新建档案 | 高 | `create_profile`（name）；名称规范化（小写、非字母数字转 `-`、去首尾 `-`）；空名/纯无效字符/>64 字符/保留名/重名；初始化官方形态（package.json/cordis.patch.yml/pnpm-workspace.yaml/.npmrc）；幂等 |
| 3 | 切换档案 | 中 | `set_active_profile`；目录不存在报错；持久化到 store；服务重启按新档案 |
| 4 | 删除档案 | 中 | `remove_profile`；默认档案不可删、使用中档案不可删、不存在报错；删除后目录移除 |
| 5 | 档案隔离性 | 高 | 各档案插件/补丁/设置相互独立；切换档案后互不影响 |

### ITEM 6：插件管理（目录 `06-plugin`，风险：高）

| # | 测试点（POINT） | 风险 | 输入项/关注点 |
|---|--------------|------|--------------|
| 1 | 已安装插件列表与监控 | 中 | `get_dsh_plugins` 只读展示；文件监控轮询；`dsh-plugins-updated` 事件 |
| 2 | 插件升级与卸载 | 中 | `update_dsh_plugin`/`remove_dsh_plugin`；异常时提供升级/卸载入口；错误详情实时同步 |
| 3 | 插件异常与恢复 | 中 | `report_plugin_error`/`detect_plugin_recovery`/`recover_plugin`；错误持久化；自动检测损坏并恢复 |
| 4 | 预装插件安装引导 | 高 | `install_preinstall_plugins`（`dsh plugin --profile <当前档案> add <pkg>`）；`preinstall-log` 实时日志；Windows 修复项（dsh-win-terminal-inspector）；取消/跳过 |

### ITEM 7：命令行集成（目录 `07-cli`，风险：中）

| # | 测试点（POINT） | 风险 | 输入项/关注点 |
|---|--------------|------|--------------|
| 1 | dsh 命令链接状态 | 中 | `get_cli_link_status`；`cli_link_enabled` 开关；安装后自动注册 `dsh` 命令 |
| 2 | PATH 注册与 shim | 中 | Win `%LOCALAPPDATA%\deepseek-harness\bin`、Unix `~/.local/bin`；shim 文本纯英文；本地 Node 优先、pnpm 用户优先；安装跳过条件 |

### ITEM 8：端口与数据隔离（目录 `08-isolation`，风险：中）

| # | 测试点（POINT） | 风险 | 输入项/关注点 |
|---|--------------|------|--------------|
| 1 | 端口隔离 | 中 | release 3080 / debug 3081；`cfg!(debug_assertions)` 区分；避免争用 |
| 2 | 数据目录隔离 | 中 | `$DSH_HOME` 默认 `~/.dsh`（release）/`~/.dsh.dev`（debug）；store 文件 `.store.dat`/`.store.dev.dat`；debug 不迁移/不注册 PATH/不写 shim；`~/.dsh.dev/.harness.pid` 精确回收 |

### ITEM 9：隐私与本地化（目录 `09-privacy`，风险：中）

| # | 测试点（POINT） | 风险 | 输入项/关注点 |
|---|--------------|------|--------------|
| 1 | 纯本地与隐私默认 | 中 | 服务仅监听 `127.0.0.1`；profile/会话/设置留在本机；默认关闭遥测 |
| 2 | 中英双语与暗色模式 | 低 | `set_language` 切换中英文；暗色模式适配；dsh 界面主题与桌面端一致 |

### ITEM 10：桌面端自更新（目录 `10-updater`，风险：中）

| # | 测试点（POINT） | 风险 | 输入项/关注点 |
|---|--------------|------|--------------|
| 1 | 版本检查与更新 | 中 | 检查 GitHub 最新版；下载安装包；开发/生产构建端口与数据目录隔离；更新失败处理 |

### ITEM 11：系统集成与兼容（目录 `11-system`，风险：中）

| # | 测试点（POINT） | 风险 | 输入项/关注点 |
|---|--------------|------|--------------|
| 1 | 系统操作集成 | 中 | `open_in_browser`/`copy_service_url`/`reveal_in_folder`/`read_clipboard_image`/`get_runtime_info`/`proxy_health_check` |
| 2 | 跨平台兼容与 Windows 极简模式 | 中 | Windows（MSVC+WebView2）/macOS（Gatekeeper 放行）/Linux（WebKit2GTK）；`win_inspector` 写 profile patch 与极简 preset |

## 六、测试环境与数据

### 6.1 测试环境要求

| 项 | 要求 |
| --- | --- |
| 操作系统 | Windows 10/11、macOS 10.15+、Linux（Ubuntu 22.04+） |
| 应用构建 | release（`:3080`）与 debug（`:3081`，`pnpm tauri dev`）分别验证 |
| 网络 | 首次装配需要网络；断网场景单向验证 |
| 数据目录 | release `~/.dsh`、debug `~/.dsh.dev`；store 文件 `.store.dat` / `.store.dev.dat` |
| 浏览器/WebView | Tauri WebView（遵循宿主 WebView 内核）；E2E 用 WebDriver（Windows `msedgedriver`、Linux `WebKitWebDriver`、macOS `safaridriver`） |

### 6.2 测试数据管理

- **数据集**：预设插件清单（`preset-plugins.json`）作为安装源白名单；模拟断网、磁盘满、端口占用等异常数据。
- **隐私**：测试不使用真实用户会话/档案；档案隔离场景在独立临时目录构造。
- **维护**：每次发行版升级（内核/运行时版本）后重建基线数据。

### 6.3 工具选择

| 层 | 工具 | 用途 |
| --- | --- | --- |
| Rust 单元 | `cargo test` + `cargo tarpaulin` | 后端逻辑与覆盖率 |
| 前端单元 | Vitest + `@tauri-apps/api/mocks` | 组件/工具/存储模块；用 `mockIPC`/`mockWindows` 模拟 Tauri 后端命令 |
| E2E | `tauri-driver`（WebDriver）+ WebdriverIO/Selenium | 关键用户工作流、WebView 嵌入（Windows `msedgedriver`、Linux `WebKitWebDriver`、macOS `safaridriver`） |
| 构建/类型 | `tsc --noEmit`、`eslint`、`knip` | 静态检查门禁 |
| 网络 | 本地代理/断网模拟 | 下载、自更新异常场景 |

> **工具原则**：优先采用 Tauri 官方推荐的两种测试方式——① **Mocking**：单元/组件层用 `@tauri-apps/api/mocks` 的 `mockIPC`、`mockWindows` 模拟 Tauri 后端命令；② **WebDriver**：端到端用 `tauri-driver` 驱动真实桌面窗口。

### 6.4 CI/CD 集成

- 前端：PR 触发 `pnpm typecheck` + `pnpm lint` + `pnpm test`。
- 后端：PR 触发 `cargo check` + `cargo test`。
- 质量门禁：关键覆盖率阈值 + lint 无错误；发布前 E2E 关键路径冒烟。
- 多平台：GitHub Actions 覆盖 Windows / macOS / Linux 三平台构建与冒烟。

## 七、用例生成约定

- 每个 POINT 生成一个 `docs/test-case/<ITEM>/<POINT>.md`，内含 4–8 条用例（依据复杂度）。
- 用例格式（文本协议 v0.2）：

```markdown
## [P1] 验证<行为>
[测试类型] 功能
[前置条件] <分号分隔的必要条件>
[测试步骤] 1. <具体数据操作>。2. <具体数据操作>
[预期结果] 1. <可验证结果>。2. <可验证结果>
```

- 标题以「验证」开头；优先级 P1–P5；反向用例标题加 `[反向]`。
- 测试步骤与预期结果编号连续、数量一致。

## 八、产物与使用

> **执行用法**：进行测试时只需将本 `plan.md` 交给执行 AI；它会按下列映射读取对应用例文件。

- `docs/test-case/plan.md` — **主测试计划**：策略、范围、风险评估、ITEM/POINT 定义与用例文件索引（交给 AI 的主文档）
- `docs/test-case/checklist.md` — 测试任务清单与检查项：Issue 拆分、依赖、覆盖目标、质量门禁、估算、发布清单
- `docs/test-case/quality-report.md` — 质量报告：ISO 25010 验证、质量度量、用例生成统计与校验结论
- `docs/test-case/{ITEM}/{POINT}.md` — 各测试点用例（具体步骤/前置/预期）
- `docs/test-case/all_cases.md` — 全部用例汇总（按 ITEM/POINT 分组，含具体测试步骤，供执行 AI 读取）
