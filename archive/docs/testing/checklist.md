# 测试任务与质量检查清单：deepseek-harness-desktop

> 面向 GitHub 项目管理（Issue / 任务拆分）与质量门禁检查。与 `plan.md`（测试计划）、
> `quality-report.md`（质量报告与度量）配套使用。标签与优先级遵循本文第 8 节约定。

---

## 1. 测试级别 Issue 创建

### 1.1 测试策略 Issue

- [ ] **测试策略整体**：为本项目建立 ISTQB + ISO 25010 测试计划（见 `plan.md` 与 `quality-report.md`）。
  - 标签：`test-strategy`、`istqb`、`iso25010`、`quality-gates`
  - 估算：3 点

### 1.2 单元测试 Issue

- [ ] `config`（Rust）：`setting`/`runtime`/`region`/`format`/`window_state`/`utils` 的路径、端口、数据隔离逻辑单测。
- [ ] `service/download`（Rust）：`Installable` 特征、下载进度、解压、失败重试单测。
- [ ] `service/core`（Rust）：多版本核心的下载/切换/卸载与「全局 dsh 优先」逻辑单测。
- [ ] `service/profile`（Rust）：档案新建/切换/删除与隔离单测。
- [ ] `service/plugin`（Rust）：安装/升级/卸载、`preset` 加载、`recovery`、`installed`、`errors` 单测。
- [ ] `service/cli`（Rust）：`shim` 生成、`path` 注册、`core` 探测单测（含 `%`→`%%`、`'`→`'\''` 转义）。
- [ ] `service/update` / `service/workflow`（Rust）：自更新、进程生命周期、`status`、`utils` 单测。
- [ ] `task/scheduler`（Rust）：健康检查轮询逻辑单测。
- [ ] 前端 `utils`：`iframe`、`logger`、`toast` 单测。
- [ ] 前端 `config/client`：`invoke` 封装与命令参数单测。
- 标签：`unit-test`、`backend-test`/`frontend-test`
- 估算：每组件 0.5–1 点

### 1.3 集成测试 Issue

- [ ] 前后端命令桥集成：`invoke` 命令 ↔ `bridge/*` 参数/返回值契约测试（前端用 `mockIPC` 模拟后端）。
- [ ] 核心切换后服务重启集成：切换 → 进程终止 → 重启 → 健康检查就绪。
- [ ] 档案切换集成：切换 → 服务重启 → WebView 加载对应档案。
- [ ] 插件安装→升级→卸载全链路集成。
- [ ] CLI shim 安装后 → 新终端调用 `dsh` 可用性集成。
- [ ] 预设插件清单（`preset-plugins.json`）与安装/修复流程集成。
- 标签：`integration-test`、`backend-test`、`api-test`
- 估算：每接口 1–2 点

### 1.4 端到端测试 Issue（WebDriver）

- [ ] **首次装配 E2E**：首启自动下载 Node + Harness 内核 → 内嵌 WebView 加载 `127.0.0.1:3080`。
- [ ] **安装状态机 E2E**：下载进度 → 解压 → 装配 → 就绪，含中断/重试。
- [ ] **配置对话框 E2E**：调试/档案/插件/核心各面板操作与保存。
- [ ] **侧边栏与 iframe E2E**：通过消息桥控制 dsh Web 界面。
- [ ] **更新 E2E**：桌面自更新与内核更新流程。
- 标签：`e2e-test`、`webdriver`、`frontend-test`
- 说明：E2E 遵循 Tauri 官方推荐，用 `tauri-driver`（WebDriver）驱动真实桌面窗口；组件级交互用 `@tauri-apps/api/mocks` 的 `mockIPC`/`mockWindows` 模拟。
- 估算：每工作流 2–3 点

### 1.5 性能测试 Issue

- [ ] 首次装配耗时测量（下载/解压/装配）。
- [ ] 内存占用与 CPU 空闲占用测量（较 Electron 基线）。
- [ ] 核心切换重启时间测量。
- 标签：`performance-test`
- 估算：每性能需求 3–5 点

### 1.6 安全测试 Issue

- [ ] `dsh` 本地代码执行能力的风险审查与提示验证。
- [ ] 插件来源白名单校验（仅允许预设清单/受信来源）。
- [ ] WebView 跨源通信与 iframe origin 校验。
- [ ] 配置文件/数据目录权限（`~/.dsh`/`~/.dsh.dev`）检查。
- 标签：`security-test`、`risk-based`
- 估算：每安全需求 2–4 点

### 1.7 可访问性测试 Issue

- [ ] WCAG 合规检查：键盘导航、焦点管理、对比度、暗色模式。
- [ ] 双语界面文案完整性与一致性。
- 标签：`accessibility-test`、`frontend-test`
- 估算：2 点

### 1.8 回归测试 Issue

- [ ] 内核/运行时版本升级后的全量回归。
- [ ] debug 构建热重启 / release 构建隔离回归。
- [ ] 修复关键缺陷后的确认测试（confirmation testing）。
- 标签：`regression-test`、`quality-gate`
- 估算：持续，按变更范围评估

---

## 2. 测试类型识别与优先级

| 优先级 | 范围 | 说明 |
| --- | --- | --- |
| **关键（Critical）** | 功能测试：首次装配、核心/档案切换、插件装卸、CLI、自更新 | 核心业务逻辑与用户主路径 |
| **高（High）** | 非功能：性能、可靠性、安全 | 对稳定性/可用性有重大影响 |
| **中（Medium）** | 结构测试：覆盖率目标、架构验证；可用性、可移植性 | 提升长期可维护性与体验 |
| **低（Low）** | 变更相关测试的低风险回归 | 按风险矩阵动态确定 |

> 维度对应关系：用例级 P1–P5（见 `plan.md` 第五节）为测试用例优先级；本节为任务/Issue 级优先级。

## 3. 测试依赖验证与管理

### 3.1 具体依赖项

- [ ] **实现依赖**：E2E 与集成测试依赖对应后端任务完成（如装配、档案、插件）。
- [ ] **环境依赖**：需要三平台构建环境、断网/占用端口/磁盘满等模拟条件。
- [ ] **工具依赖**：`cargo tarpaulin`、Vitest coverage、`tauri-driver` 及对应 WebDriver（`msedgedriver`/`WebKitWebDriver`/`safaridriver`）安装。
- [ ] **跨团队依赖**：上游 `deepseek-harness-pkg` 发行版、GitHub 网络可达性、外部插件仓库。

### 3.2 依赖管理流程

- [ ] **循环依赖检测**：阻止环路阻塞关系（如 E2E → 集成 → 单元）。
- [ ] **关键路径分析**：识别影响交付节点的测试依赖（装配 → 内核切换 → 档案切换 → 插件 → CLI → 自更新）。
- [ ] **风险评估**：延迟影响分析；如上游 `deepseek-harness-pkg` 或 GitHub 网络不可达。
- [ ] **缓解策略**：保留本地产物、断网降级、插件恢复机制、自更新失败回退。

## 4. 覆盖目标与度量

- [ ] **代码覆盖率**：关键路径行覆盖率 > 80%，分支覆盖率 > 90%。
- [ ] **功能覆盖率**：100% 验收标准被验证。
- [ ] **风险覆盖率**：100% 高风险场景被验证。
- [ ] **质量特性覆盖**：对每个适用 ISO 25010 特性给出验证方式（见 `quality-report.md` 第 2 节）。

## 5. 任务级拆分与估算

### 5.1 测试实现任务

- [ ] 测试用例开发（Rust `#[cfg(test)]` / Vitest `*.test.ts`）。
- [ ] E2E 用例（WebDriver/WebdriverIO Page Object Model、fixture、数据管理）。
- [ ] 测试环境搭建（三平台构建、模拟网络/端口/磁盘异常）。
- [ ] 测试数据准备（隔离档案、插件清单、断网/占用场景）。
- [ ] 测试自动化框架搭建（覆盖率聚合、CI 集成、报告）。

### 5.2 估算指南

| 任务类型 | 估算（story points） |
| --- | --- |
| 单元测试 | 0.5–1 点 / 组件 |
| 集成测试 | 1–2 点 / 接口 |
| E2E 测试 | 2–3 点 / 用户工作流 |
| 性能测试 | 3–5 点 / 性能需求 |
| 安全测试 | 2–4 点 / 安全需求 |

### 5.3 依赖与排序

- **顺序依赖**：E2E 依赖集成/单元通过；装配类 E2E 依赖下载/解压完成。
- **可并行**：单元测试可按模块（`config`/`download`/`plugin`/`cli`）并行开发；前端 `utils` 与后端独立。
- **关键路径**：首次装配 → 安装状态机 → 内核切换 → 档案切换 → 插件 → CLI → 自更新。
- **资源分配**：按团队技能（Rust/React/E2E）匹配；关键路径任务优先。

### 5.4 任务分配策略

- [ ] 技能匹配：后端逻辑归 Rust 成员，前端归 React 成员，E2E 归熟悉 WebDriver 成员。
- [ ] 容量规划：平衡各成员负载，避免关键路径阻塞。
- [ ] 知识转移：资深与初级结对，覆盖高风险模块。
- [ ] 交叉培养：通过配置/插件/核心等关联任务培养整体视角。

## 6. 质量门禁与检查点（Quality Gates）

### 6.1 入口标准（Entry Criteria）

- [ ] 被测功能实现已完成并通过代码评审。
- [ ] 相关单元测试通过且无未处理 panic。
- [ ] `pnpm typecheck`、`pnpm lint`、`cargo check` 通过。
- [ ] 测试环境（三平台、模拟异常条件）就绪。

### 6.2 退出标准（Exit Criteria）

- [ ] 所有测试类型完成且通过率 ≥ 95%。
- [ ] 无 critical / high 级缺陷遗留。
- [ ] 性能基准达标（装配/切换时间、内存占用）。
- [ ] 安全验证通过（无 critical 漏洞、来源白名单生效）。
- [ ] 质量门禁全部健康。

### 6.3 升级流程（Escalation）

- 质量失败 → 记录缺陷（含严重度/复现步骤）→ 按严重度升级 → 阻塞发布直至回归通过。

> 质量度量的具体指标（缺陷密度、性能响应时间、可访问性、安全性）见 `quality-report.md` 第 3 节。

## 7. GitHub Issue 质量标准

- [ ] **模板合规**：所有测试 Issue 遵循本文档结构。
- [ ] **必填字段**：标题、描述、范围、验收标准、标签、估算、依赖均完整且准确。
- [ ] **标签一致**：全项目统一使用第 8 节约定标签。
- [ ] **优先级分配**：按风险矩阵（`plan.md` 第四节风险评估）确定优先级。
- [ ] **价值评估**：标注业务价值与质量影响。

## 8. 标签与优先级规范

### 8.1 测试类型标签

| 标签 | 用途 |
| --- | --- |
| `unit-test` | 组件级单元测试 |
| `integration-test` | 接口/组件间集成测试 |
| `e2e-test` | 端到端用户工作流（WebDriver） |
| `performance-test` | 非功能性能需求 |
| `security-test` | 安全需求与漏洞验证 |

### 8.2 质量标签

| 标签 | 用途 |
| --- | --- |
| `quality-gate` | 质量门禁 |
| `iso25010` | ISO 25010 特性验证 |
| `istqb-technique` | ISTQB 设计技术 |
| `risk-based` | 风险驱动测试 |

### 8.3 优先级标签

- `test-critical`（关键）/ `test-high`（高）/ `test-medium`（中）/ `test-low`（低）。

### 8.4 组件标签

- `frontend-test` / `backend-test` / `api-test` / `database-test`。

## 9. 估算准确性与评审

- [ ] **历史数据分析**：参考过往版本装配/切换/插件耗时。
- [ ] **技术负责人评审**：由 Rust / React / E2E 资深成员复核复杂度估算。
- [ ] **风险缓冲**：对高不确定性任务（如首启装配、Windows 极简修复、自更新）预留缓冲。
- [ ] **估算精化**：每轮迭代回顾实际 vs 估算并精化。

## 10. 测试完成与发布清单

- [ ] 全部测试类型执行完成，通过率达标。
- [ ] 覆盖率与质量度量达标。
- [ ] 关键路径 E2E 冒烟通过（装配/切换/插件/CLI/更新）。
- [ ] 三平台安装包验证通过（Windows / macOS / Linux）。
- [ ] 双语文案与中文注释一致性检查通过。
- [ ] 安全与合规检查无遗留高风险项。
