# Phase 3：SDK stdio 桥 —— dsh-sdk-* 接口盘点单（评估/预留）

> 状态：**接口盘点 + 复用性评估（未实现代码）**。对应 [issue #286](https://github.com/dsh-tauri-desk/deepseek-harness-desktop/issues/286)
> 「Phase 3: SDK stdio 桥 —— `dsh-sdk-jsonrpc-server` 作为 web 端口之外的第二条交互通道」。本文只做盘点与选型判断，不改代码。

## 1. 结论速览（TL;DR）

- **协议面小且稳定**：stdio 通道只暴露 3 个请求（`initialize` / `session/prompt` / `shutdown`）和 4 个服务端通知（`session.event` / `session.status` / `subagent.started` / `subagent.finished`）。`dsh-sdk-protocol` + `dsh-sdk-jsonrpc-server` 的公开 API 已在下方 `dsh-sdk-protocol` / `dsh-sdk-jsonrpc-server` / `dsh-sdk-client` 三节完整盘点。
- **深挖结论**：桌面端直接依赖 Rust 开源 crate `deepseek-harness-sdk` 的**协议层可复用性中等**，但**不建议直接依赖其高层 `DeepSeekHarness` API**。理由见 §4：
  1. 桌面端是 Windows 主力（Tauri），而该 crate 的**自带 runtime 没有 Windows 发行版**（`deepseek-harness-runtime-bin` wheel 只有 linux-x64 / linux-arm64 / macos-arm64）；桌面端还需用自己打包的 Node + `@deepseek-ai/dsh` 走 `--profile sdk`（与 TS `dsh-sdk-client` 同路）。
  2. crate 仍是预发布线（最新 `0.1.0` 为 2026-08-17 经 GH Action trustpub 发布，接口仍可能变动）。
  3. 桌面端已有成熟的 `win_spawn` 隐藏控制台 + 进程树终结基础设施，stdout/stderr 管道读取也现成；**协议信封解析/握手很简单（3 个方法），不值得为它引入对上游独立 runtime 的依赖耦合**。
- **选型判断（与 issue 验收一致）**：**保持预留**。仅当出现明确场景（web 端口 3080/3081 不可用时的降级 / CI 脚本 / 外挂进程）才转正。推荐落地路径见 §5（优先复用桌面既有 `dsh --profile sdk` + 手写最小 JSON-RPC，而非依赖 `deepseek-harness-sdk` crate 的高层 API）。

## 2. dsh-sdk-* 公开 API 面盘点

来源：上游 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) `packages/sdk/`（protocol / server / client 三包，实地读取 `master` 源码核实），版本号经 npm registry 核实：

| 包 | npm 名 | 实测最新版本 |
| --- | --- | --- |
| 协议 | `@deepseek-ai/dsh-sdk-protocol` | `0.0.1-rc.1` |
| 服务端插件 | `@deepseek-ai/dsh-sdk-jsonrpc-server` | `0.0.1-rc.5` |
| TS 客户端 | `@deepseek-ai/dsh-sdk-client` | 随同发布（`0.0.1-rc.5` 线） |
| App（Cordis host） | `@deepseek-ai/dsh-sdk-app` | `0.1.2-alpha.2` |
| 最小运行时 | `@deepseek-ai/dsh-sdk-minimal` | `0.1.2-alpha.2` |
| 独立运行时代理 | `@deepseek-ai/dsh-sdk-jsonrpc-demo` | `0.0.1-rc.5`（bin 为 `dsh-jsonrpc-agent`） |

> 版本线分两路：`dsh-sdk-protocol`/`jsonrpc-server`/`client`/`jsonrpc-demo` 走 `0.0.1-rc.x`（stdlib 线）；`dsh-sdk-app`/`minimal` 走 `0.1.2-alpha.x`（Cordis host 线）。桌面端「预留」附着在 rc 线即可。上游主线已推进到 `0.1.2-alpha.4`，接口若有漂移以源码为准。

### 2.1 dsh-sdk-protocol（`JsonRpcLineTransport` 与命名类型）

`@module @deepseek-ai/dsh-sdk-protocol`，新行分隔 JSON-RPC 2.0（`\n` 分行；`stdout` 只承载协议帧，禁止 stdout logger）。

**导出的类 / 类型：**
- `class JsonRpcLineTransport implements JsonRpcTransportPeer`：`constructor(input: Readable, output: Writable)`；方法 `start()`（幂等挂监听）、`close()`（拆监听并 `failPending`）、`onRequest(handler)`、`onNotification(handler)`、`request(method, params, signal?)`、`notify(method, params?)`、`flush()`。
- `class JsonRpcResponseError extends Error`：保存线缆 `code` 与可选 `data`。
- `interface JsonRpcTransportPeer`：`request(method, params) => Promise<unknown>`、`notify(method, params?)`。
- 命名类型：`InitializeParams` / `InitializeResult`、`SessionPromptParams` / `SessionPromptResult`、`SdkEncodedImageBlock`、`SdkPromptContentBlock`、`SdkRunStatus`、`SessionEventNotification`、`SessionStatusNotification`、`SubagentStartedNotification`、`SubagentFinishedNotification`、`HarnessSdkRequestMap`、`HarnessSdkNotificationMap`。

**帧判定：** 含 `id`+`method` = 请求；仅 `id` = 响应；仅 `method` = 通知。畸形行忽略；handler 抛错 → `-32603`；缺 handler → `-32601`。

**请求/结果对（`HarnessSdkRequestMap`）：**
| 方法 | 参数 | 结果 |
| --- | --- | --- |
| `initialize` | `{ cwd, provider, model, reasoningEffort?, maxTokens? }` | `{ serverInfo: { name, version } }` |
| `session/prompt` | `{ sessionId, contentBlocks }` | `{ messageId }` |
| `shutdown` | — | `{}`（`Record<string, never>`） |

**通知（`HarnessSdkNotificationMap`）：**
| 方法 | 载荷要点 |
| --- | --- |
| `session.event` | `{ sessionId, event }`（任意运行时 session 的 session-log 事件） |
| `session.status` | `{ sessionId, status: 'idle' \| 'running' }` |
| `subagent.started` | `{ parentSessionId, childSessionId }` |
| `subagent.finished` | `{ provider, agentId, parentSessionId, childSessionId, status: 'ok'\|'error', stopReason, lastAssistantMessage? }` |

**关键 wire 常量：** `initialize` 返回的 `serverInfo.name` 恒为 `deepseek-harness-sdk-runtime`，`version` 需存在（`0.0.1` 预发布）；协议**无版本协商**，客户端可严格校验 name。

### 2.2 dsh-sdk-jsonrpc-server（`HarnessSdkJsonRpcServer` 与插件）

Cordis 插件 `@module @deepseek-ai/dsh-sdk-jsonrpc-server`：

- 插件常量：`export const name = 'sdk-jsonrpc-server'`；`inject = ['agents']`；**无默认导出**（保留 `name`/`inject`/`Config`/`apply` 命名导出供 Loader `unwrapExports`）。
- 配置 `JsonRpcConfig`：`maxTokensAsSuccess?: boolean`（默认 false——是否把 max-token 终止映射为成功结果）；`input`/`output`/`exit` 为测试注入点（生产用 `process.stdin`/`process.stdout`/`process.exit`）。
- `function apply(ctx, config)`：构建 `JsonRpcLineTransport(input, output)` + `HarnessSdkJsonRpcServer`；`initialize` 请求前先 `await ctx.get('loader')?.await()`（保证整棵 Loader 树就绪才对外宣称 ready）；`shutdown` 响应 flush 后 dispose 根 runtime 并以 `exit(0)`（还差 `transport.flush()` + `rootFiber.dispose()`）。
- `class HarnessSdkJsonRpcServer`：
  - `constructor(ctx, transport, options?)`：订阅 `session/event`、`agent/status`、`session/created`、`subagent/end` 并转成上述通知。
  - `async initialize(params): Promise<InitializeResult>`：校验 provider/model 路由，必要时挂载 DeepSeek fallback adapter；写死返回 `serverInfo { name: 'deepseek-harness-sdk-runtime', version: '0.0.1' }`。
  - `async prompt(params): Promise<SessionPromptResult>`：`getOrCreateSession` → `createUserMessage` → `agent.followup` → 返回 `{ messageId }`。
  - `async shutdown(): Promise<Record<string, never>>`：依次 `awaitPromise.allSettled` 所有 session 创建 → 移除订阅 disposer → dispose 各 `AgentHandle` + LLM fiber。
  - `async handleRequest(method, params)`：路由 `initialize` / `session/prompt` / `shutdown`，未知方法抛错（→ `-32603`）。

### 2.3 dsh-sdk-client（TS 客户端，桌面端可参考的「正路」）

`@deepseek-ai/dsh-sdk-client`（纯库，不注册 Cordis 上下文）：spawn **同版本的 `@deepseek-ai/dsh` CLI** 以 `--profile sdk` 作为子进程，经 stdio JSON-RPC 驱动 agent turn。

- 高层 `DeepSeekHarness`（惰性 `start()`：首次使用时 spawn + `initialize` 握手引线）+ `HarnessSession.run(Input)` → `RunResult`。
- 底层 `HarnessClient`：`start()` spawn（`spawn(command, args, { cwd, env: environment(), stdio: ['pipe','pipe','pipe'] })`）→ `JsonRpcLineTransport(child.stdout, child.stdin)`；`initialize` / `prompt` / `request(method, params, timeoutMs?)` / `subscribe(filter)` / `subscribeSessionTree(sessionId)` / `close()`。
- 错误类型：`TransportClosedError` / `RequestTimeoutError` / `SdkProtocolError` /（透传 `JsonRpcResponseError`）。
- `resolveDshLaunch`（`launch.ts`）：**默认 profile = `'sdk'`**；argv 形如 `node …bin… --profile sdk [--patch …]`；环境注入 `DSH_HOME`、`DSH_CWD` 等；默认 `initializeTimeoutMs = 10_000`。
- **close 阶梯（TS/Rust 一致）**：`shutdown` 请求（默认 1s）→ 关 stdin（EOF）→ 等 `eof_grace`（默认 6s，让 runtime 落盘持久化）→ `SIGTERM` → 等 `term_grace`（默认 3s）→ `SIGKILL` → 等。幂等、无条件兜底回收。

> **关键结论**：TS 客户端走的是「主 `dsh` CLI + `--profile sdk`」，其 runtime 是 **Node 程序**（`@deepseek-ai/dsh`），可运行在 Windows 上——**这与桌面端现状完全同构**（桌面端已打包 Node + `@deepseek-ai/dsh`，用 `node bin.js --profile web …` 启动）。见 §4。

## 3. 桌面端现状对照

- 桌面端 Rust 侧当前所有交互走 web 通道：`src-tauri/src/service/workflow/launch.rs` 以 `--profile web --host 127.0.0.1 --port <port>` 启动核心；前端 iframe + Tauri invoke/listen 经 HTTP/WebSocket 通信。
- 子进程生命周期基建已成熟：`process.rs`（`terminate_pid_tree`/`set_owned_process*`/`stop`）、`launch.rs`、`win_spawn.rs`（`spawn_with_hidden_console_owned`，返回 `(stdout_file, stderr_file, pid, handle)`）、`utils.rs::spawn_output_readers`。
- **现状缺口**：无 stdio JSON-RPC 通道；核心 web 服务一旦异常，桌面端无旁路交互手段。
- `Cargo.toml` 现有依赖（`tokio` full、`serde_json`、`futures-util` 等）已足够手写最小 JSON-RPC 解析，无需新增重型依赖。

### 3.1 复用「桌面自带的 dsh」作 runtime 的契合点

桌面端已打包的 `@deepseek-ai/dsh`（`dependencies/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js`）与 TS `dsh-sdk-client` 启动的是**同一个包**。因此理论落地场景：

```
node …/bin.js --profile sdk            # stdio 通道（stdin/stdout 为 JSON-RPC 帧）
node …/bin.js --profile web --host 127.0.0.1 --port <port>   # 现状 web 通道
```

两者可**并行**由桌面端以不同 profile 各起一个子进程；`dsh` 本身支持按 profile 选择 Cordis 组合（`cordis.patch.yml` 挂载不同插件集）。stdio 模式需**关闭 stdout logger**（`dsh-sdk-jsonrpc-server` 文档明确 stdout 只承载协议帧）。

## 4. deepseek-harness-sdk（Rust crate）复用性评估

来源：crates.io API + 仓库 [42ch-dev/dsh-rust-sdk](https://github.com/42ch-dev/dsh-rust-sdk) README 实地核实。

- **最新版本**：`0.1.0`（2026-08-17，Apache-2.0，trustpub 经 GH Action 发布；另有 `0.1.0-alpha.1/2`）。`cargo add deepseek-harness-sdk` 可获取。
- **两层 API**：
  - 高层（Python 对齐）：`DeepSeekHarness::start(config)`（**eager**：解析 runtime → spawn → 完成 `initialize` 握手）→ `start_session()` → `Session::run(Input::Text(...))` → `RunResult`。`Config` 关键字段：`runtime_bin` / `launch_args_override` / `request_timeout` / `cwd` / `env`（可注入 `DEEPSEEK_API_KEY`）。
  - 底层 `HarnessClient`：spawn runtime、持有 stdio transport、`initialize`/`prompt`/`request`、`subscribe*`、`close`。自定义 RPC 走 `HarnessClient::request`。
  - 错误枚举：`RuntimeNotFound` / `TransportClosed` / `RequestTimeout` / `SdkProtocol` / `JsonRpc` / `Io` / `Json`。
- **runtime 解析**：`launch_args_override` → `runtime_bin` → 环境变量 `DSH_RUNTIME_BIN`；`cwd`/`env` 可配置注入。
- **bring-your-own runtime**：该 crate **自带 runtime 无 Windows 发行**——上游 `deepseek-harness-runtime-bin` wheel 只有 **linux-x64 / linux-arm64 / macos-arm64**（macOS 需同目录 `-spawn-helper`）；npm 路线（`dsh-jsonrpc-agent`，Node ≥ 22.19）可跨平台但没有内置插件树、插件解析失败即 fatal。
- **结论**：
  - ✅ **协议层逻辑（spawn + 3 方法 + close 阶梯）可参考**——它把 TS/Python client 的协议语义移植到了 Rust，桌面端对照其语义手写即可，无需重复设计。
  - ⚠️ **不建议直接依赖 crate**：① 高层 `DeepSeekHarness` 是 eager 重 API，与桌面端「自己掌控 spawn/退出树」的主权冲突；crate 虽允许 `launch_args_override`/`runtime_bin` 注入，但自带的独立 runtime 无 Windows 发行，天然把桌面端锁到非 Windows 平台，或逼迫桌面端继续走 `dsh --profile sdk`（那也就不需要该 crate 的 runtime 解析了）。② 预发布期接口仍会变动，桌面引入后要随上游 crates.io 动线升级。③ 桌面端已内置 Node + dsh，用 crate 反而引入一层与本机 dsh CLI 的双重来源。

## 5. 推荐落地路径（转正时）

保持预留；一旦出现明确场景（如 web 端口不可用降级 / CI 脚本 / 外挂进程），按以下顺序落地：

1. **复用桌面自身 `dsh --profile sdk`**（推荐，Windows 可跑）：
   - 在 `win_spawn.rs` 已有 `spawn_with_hidden_console_owned` 基础上，以 profile `sdk` 起第二个子进程；stdout 接 `JsonRpcLineTransport` 式逐行解析，stdin 写请求帧。
   - 关闭该子进程 stdout logger（避免污染协议帧）；stderr 走既有 `spawn_output_readers` 诊断日志。
2. **手写最小 JSON-RPC 请求/响应**（约 3 个方法）：`initialize` / `session/prompt` / `shutdown`，加 4 个通知订阅——规模足够小，无需新依赖。错误信封按 `-32601`/`-32603` 处理。
3. 仅在**纯协议层**确有价值时，参考 `deepseek-harness-sdk` 的 Rust `HarnessClient` 语义作对照实现，但不直接依赖该 crate 高层 API。
4. 生命周期：复用 `terminate_pid_tree` + 既有 close 阶梯语义（`shutdown` → EOF → SIGTERM → SIGKILL）；不要擅自改 `process.rs`/`launch.rs` 现有 web 主链路。

## 6. 危险点 / 风险

- **stdout 污染**：stdio 模式下 stdout 必须只放 JSON-RPC 帧；dsh 插件的 stdout logger 会导致解析崩溃。落地时需显式关闭。
- **Windows 发行缺口**：`deepseek-harness-sdk` 自带 runtime 无 Windows 版；桌面端 Windows 主力，故强调走 `dsh --profile sdk` 而非依赖其自带 runtime。
- **`DEEPSEEK_API_KEY` / 凭据**：stdio runtime 需模型凭据（`DEEPSEEK_API_KEY` 或 `base_url`+`api_key`），与桌面端现有凭据注入可能冲突，落地时需对齐来源。
- **版本协商缺失**：协议无 version negotiation，`serverInfo.name`/`version` 须与 runtime 版本保持同步。
- **预发布漂移**：`dsh-sdk-*` rpm（`0.0.1-rc.x`）与 crate（`0.1.0`）接口仍在变动；转正前必须重新对照当前版本核实。

## 7. 验收对照（issue #286）

- [x] 产出 `dsh-sdk-*` 接口盘点单（本文档），含 `deepseek-harness-sdk` 复用性评估。
- [ ] （可选）stdio JSON-RPC 最小闭环 PoC——**未实现**，保持预留，不阻塞 alpha.3 主线。
- [x] 不阻塞主线（当前状态：预留）。
```