# dsh-tauri-pet 上游同步日志

> 用途：追踪 `source/dsh-pet` 与 `source/dsh-dafeiyu` 上游变更的采纳进度，
> 供后续轮次直接续接，避免重复调研。
>
> 约定：完成一次上游同步后，更新「同步记录」一节并刷新「同步基线」版本表；
> 未采纳的上游改动在「审查结论与未采纳项」记录原因，防止重复评估。

## 同步基线（固定版本）

| 上游仓库 | 子模块 HEAD | 版本 | 用途 |
| --- | --- | --- | --- |
| `source/dsh-pet` | `e1ff8c1` | v0.2.6 | 预设资产与工作状态语义来源 |
| `source/dsh-dafeiyu` | `f4f4482` | v0.1.9 | 气泡文案/优先级逻辑参考（不下载资产） |

- 预设清单 `src-tauri/resources/preset-pets.json` 的素材地址内嵌 ref
  `e1ff8c1e4001878cbb80441262d530e16541f138`（须与 dsh-pet 已采纳 HEAD 保持一致，
  新 WebM 资产在 `903dfde` 才入库，低于此的 ref 会取不到 6 个工作状态动画）；
  macOS 侧为 `dsh-pet-mov` 的 `be0f3bb494cb71a4c73f916c0b92d25a3ab4d002`。
- 旧研究参考固定 `docs/plugins/expired/pet.todo.md:96` 指向 `899150e`，仅历史参考。

## 同步记录

### 2026 —— 预设宠物改为 dsh-pet-component 直连远端（移除下载/解压链路）

不是上游同步，而是渲染层换实现导致预设获取方式的整体变化，记录在此以便后续核对素材来源与命令面。

- **渲染层**：`src/pet` 整体换成 [`hairyf/dsh-pet-component`](https://github.com/hairyf/dsh-pet-component)
  的 `<Pet>`（npm `dsh-pet-component@^0.1.1`，内部用 `@reause/core`）；`src/pet/components/pet.tsx`
  （681 行）、`src/pet/config/index.ts`（294 行）、`hooks/use-pet.ts` 删除，动画池解析、
  双视频缓冲、雪碧图帧循环、IndexedDB 缓存、双击回应全部由组件接管。`src/pet` 只剩设置状态、
  会话气泡聚合、原生窗口拖拽（reause `useEventListener` + `useTimeoutFn`）与命中穿透。
- **预设不再下载/安装**：`src-tauri/resources/preset-pets.json` 改成组件 props 形状
  （`id` / `name` / `desc` / `image` / `kind` / `size` / `config` / `uri{default,mac}` /
  `ext{default,mac}`），Rust `bridge/preset_pet.rs` 从 2148 行缩到只剩读清单 + 校验；
  `download_preset_pet` / `update_preset_pet` / `get_preset_download_progress` /
  `get_preset_pet_config` / `get_preset_pet_assets` 与 `dsh-pet://` 自定义协议全部删除。
  `uri.mac` / `ext.mac` 继续指向 `dsh-tauri-desk/dsh-pet-mov` 的 HEVC-alpha `.mov`（issue #434 结论不变）。
- **CORS**：`src/pet/main.tsx` 把全局 `fetch` 换成 `@tauri-apps/plugin-http` 的实现
  （请求走 Rust），否则 `raw.githubusercontent.com` 不返回 `Access-Control-Allow-Origin`，
  组件拉配置与抓 blob 会整条失败；能力文件只放开 `https://*.githubusercontent.com/*` scope，
  媒体/图片的 CSP 增加 `blob:` 与 `https://*.githubusercontent.com`。
- **插件前端**：`utils/preset-card.ts`、`utils/availability.ts`（含各自测试）删除——
  预设恒可用、卡片只有「启用 / 已选」两态；store 去掉 `petsAvailable`，侧栏入口常驻。
- 校验：`pnpm typecheck`、`pnpm build`、`pnpm exec eslint src/pet packages/dsh-tauri-pet/src src/hooks/use-iframe-invoke.ts --max-warnings=0`、
  `pnpm exec vitest run`（295+）、`cargo test --lib`（530 passed）。

### 2026 —— 修复 macOS 预设宠物黑底（issue #434，分支 `fix/434-macos-hevc-alpha-mov-pet`）

不是上游同步，而是**素材编码格式**在 macOS 上不可用导致的黑底，记录在此以便后续核对素材来源。

- **现象**：macOS 启用预设桌宠后，宠物是一个黑色矩形（透明区域全黑），Windows/Chromium 正常，且无任何 error 事件。
- **根因**：预设宠物走 `<video>` 播放 VP9-alpha WebM，而 WKWebView（WebKit）解码时**直接丢弃 alpha 平面**
  并按不透明渲染（[WebKit #64837](https://github.com/WebKit/WebKit/pull/64837) 2026 才合入）。窗口/WebView/CSS
  透明链路与 Tauri 均无问题，黑底是视频像素层。Safari 原生支持的透明视频是 **HEVC-with-Alpha**
  （`AVVideoCodecType.hevcWithAlpha`，`hvc1`），而该编码器只有 macOS 有。
- **素材侧**：新建 [`dsh-tauri-desk/dsh-pet-mov`](https://github.com/dsh-tauri-desk/dsh-pet-mov)，
  用 GitHub Actions 的 macOS runner 把上游 `dsh-pet/assets/webm` 批量转码为 `mov/*.mov`
  （`ffmpeg -pix_fmt bgra` 解码 → `swift hevc_alpha_encoder.swift` 编码），
  仓库**只保留 `config.jsonc` 与 `mov/`**（113 个 mov，约 79 MiB）。流水线按周跟随上游 `main` 重编，
  产物由机器人提交回该仓库；桌面端以 codeload tarball 下载，不需要 Release。
- **桌面侧**：
  - `preset-pets.json` 新增 `platforms` 覆盖块：`macos` 换 `repo` = `dsh-tauri-desk/dsh-pet-mov`、
    `ref` = 该仓库已生成的提交、`assets` = `""`（仓库根即素材）、`sizeMb` = 79；其余平台不变。
  - `preset_pet.rs`：`read_platform_catalog` 按 `std::env::consts::OS` 并回覆盖块；
    解压层支持**空前缀**（整个仓库即素材，仍需剥掉 `<repo>-<ref>/` 与安全校验）；
    协议层放开 `mov/` 子目录与 `.mov` 扩展名，MIME 为 `video/quicktime`（WKWebView 才交给 AVFoundation）；
    `get_preset_pet_assets` 改为按 `mov/` → `webm/` 的优先级选源（文件名主名与 `config.jsonc`
    池条目一致，前端无需感知格式）。macOS 用户升级后清单 `ref` 变化会触发设置页的「更新」入口，
    更新即从 webm 安装切到 mov 安装。

### 2026 —— 修复「会话被用户中止后 toast 与动画一直持续」（分支 `fix/pet-abort-hang`）

不是上游同步，而是宿主收尾信号缺失导致的桌宠挂死，记录在此以便后续核对收尾语义。

- **现象**：用户中止一个刚起流的会话后，桌宠气泡（标题 + 档位文案）与循环工作动画
  （thinking/working 档）一直持续，直到会话被销毁或重开桌宠。
- **根因（有抓包与日志证据）**：桌宠展示态只认 `turn/end`，但核心 0.1.5-rc.1 在异常收尾时
  可能**永远不追加** `turn/end`。真实现场 `session-2a2abd15`（用户中止，等待 5 秒的会话）：
  - 宿主 `session/event` 只到 `assistant/attempt{stream:[]}` + `step/end`；SSE 抓包（订阅
    `/api/dsh-pet/session-stream`）在最后一条 `workStatus=thinking` 之后**再无该会话的任何帧**；
  - 会话日志里 `turn/end` 直到 2.5 分钟后该会话被重新加载时才出现，且是崩溃修复补写的
    `{kind:'interrupted'}`；崩溃修复属于构造 seed，**不会再发 `session/event`**，桌宠永远等不到。
  - 结论：`turn/end` 不能作为「回合收尾」的唯一信号，与 turnrewind 宿主侧早就存在的
    `agent/status → idle` 兜底（`packages/dsh-tauri-turnrewind/src/host/apply.ts`）同源。
- **修复**：
  - `src/host/reducer.ts`：抽出 `settleIdle(state)`（turn/end 中断分支与 idle 兜底共用同一份
    收尾语义），新增 `idle(id)` —— 只在会话仍处于「回合内」（`running || turnActive || stepActive`）
    时才落定回空闲并去重转发；`turn/end` 已写好的终态档（success/error）与 blocked 等待态
    必须保留，否则刚弹出的失败/完成气泡与一次性动画会被立刻掐断。
  - `src/index.ts`：`attachSessionEvents` 增加 `ctx.on('agent/status', ...)`，`status==='idle'`
    时用 `agent.session.id` 调 `reducer.idle`；与 `session/event` / `session/disposed` 同生命周期
    （无消费者不订阅）。载荷形状 `{status, agent}` 来自核心 `agentEvents` 的 fused payload，
    0.1.2-rc.1 与 0.1.5-rc.1 一致（旧核心同样是 `dispatch.emit("agent/status", { status })`）。
  - `src/pet/hooks/bubble-copy.ts`：`sessionTitle()` 从 `use-bubble.ts` 迁入（纯函数可单测），
    标题缺失时回落 `UNTITLED_SESSION_TITLE`（「新会话」/「New session」），**不再回落
    `session.id`**（此前把 `session-xxxx-xxxx…` 漏成气泡标题）；`taskCopy()` 按用户反馈去掉
    dsh-dafeiyu 的句末语气词「呢」（`正在处理「…」` 不再以「呢」收尾，三个分支统一）。
  - 测试：reducer.test.ts 新增 4 条（漏发 turn/end 时清空并转发、终态/等待态不被改写、
    未知会话与重复通知不转发、create 仅凭 summary `running=true` 也能回落）；
    bubble-copy.test.ts 新增 3 条（标题优先级、缺失标题回落且不含 `session-`、前缀保留）。

### 2025 —— PR #414（已合并 main，分支 `dsh/pet-work-status`）

预设 ref 升级 + 工作状态 6 档 + 动画/气泡接线：

- `preset-pets.json`：ref 与 image URL 同步升级 `f0f772e` → `e1ff8c1`。
- host reducer（`packages/dsh-tauri-pet/src/host/reducer.ts`）：
  - 新增 `PetWorkStatus='thinking'|'working'|'result'|'waiting'|'success'|'error'`、
    `PET_WORK_STATUS_INDEX`、`PetToolActivity`、`toolActivityOf(name)`、
    `currentTaskFromTodo(data)`。
  - `reduceSessionEvent` 映射：turn/start→thinking（并清 task 与 lastAgentError）；
    step/start、assistant/chunk(reasoning-delta)、assistant/message→thinking；
    tool/call→working（`ask_user_question` 例外→waiting）；tool/result→
    **不写 lastAgentError**（工具级错误不污染回合级终态），openTools 剩→working、
    无→(waitingKind?waiting:result)；approval/asked→waiting、decided→
    (openTools 剩?working:thinking)；todo/write→task 变化即转发；turn/end：
    blocked→waiting、completed→success、error/max-tokens/timeout→error、
    其余(aborted)→undefined 清回空闲。
- 动画/气泡接线：`src/pet/pet-config.ts` `PRESET_SESSION_ANIMATIONS` 指向 6 个新
  webm 名；新增 `isLoopingAnimation` / `spriteStatusFallback`；
  `src/pet/hooks/bubble-copy.ts` 新增（对齐 dsh-dafeiyu 的 `seedNumber` /
  `statusCopy` / `activityCopy` / `taskCopy` / `toolActivityGroup`，
  `taskCopy` 句式：`正在${value}呢`）；`use-bubble.ts` `STATUS_PRIORITY` 对齐
  dsh-dafeiyu 档位（waiting=60>error=50>failed=45>review=40>working=30>result=25>
  thinking=20>running=12>success=10>idle 族=0），`sessionStatus` 优先 `workStatus`，
  并修复用户 bug：`session.running===true` 时 lastAgentError/粗 error 不判 failed
  （会话还在跑 toast 不能消失）；`app.tsx` loop 判定改 `isLoopingAnimation`。
- 测试：reducer.test.ts 19 条、pet-config.test.ts、bubble-copy.test.ts 新增。

### 2025 —— PR #415（未合并，分支 `dsh/pet-update`，12 files +408/-31）

宠物更新功能（检测到 dsh-pet hash 有更新时，已下载用户在「已选」按钮左侧点
「更新」，走同一下载/解压进度条；点击更新时若宠物正在使用则强制停用，
完成后重新启用）：

- Rust `src-tauri/src/bridge/preset_pet.rs`：
  - 新常量 `PRESET_REF_FILE='.preset-ref'`（安装目录根隐藏文件记录已安装版本）；
    `PresetPetListItem` 增 `update_available: bool`。
  - 新函数 `preset_reference(spec)`（ref 过滤空后 unwrap_or "main"）、
    `read_installed_ref(dir)`（空/空白→None）、`write_installed_ref(dir, reference)`、
    `preset_update_available(installed, catalog_ref, installed_ref)`（未安装→false；
    catalog ref 空→false；installed_ref≠catalog ref→true；老安装无记录→true）。
  - `install_staging(root,id,nonce,staging,target,replace)`：target 不存在→rename；
    存在且 !replace→`PET_PRESET_ALREADY_INSTALLED`；replace→两步 rename
    （target→`root/.preset-backup-{id}-{nonce}`，staging→target），失败回滚。
  - 新 `#[tauri::command] update_preset_pet(app, id)`：校验在 catalog+已安装+非 busy；
    快照 `get_pet_status` 得 `was_enabled`；若在用先 `set_pet_enabled(false)` 强制停用；
    `run_preset_download(replace=true)`；done 后 `reload_pet_window(app)`；
    `was_enabled` 时 `set_pet_enabled(true)` 重新启用。
  - `run_preset_download` 增 `replace: bool`；成功路径写 `.preset-ref`；
    `list_preset_pets` 计算 `update_available`；`download_preset_pet` 传 replace=false。
- Rust 其他：`src-tauri/src/desktop/pet.rs` 新增 `reload_pet_window(app)`
  （窗口存在时 `eval("location.reload()")` 刷新 WebView webm 缓存）；
  `desktop/builder.rs` 注册 `update_preset_pet`。
- 插件前端：`constants/index.ts` 增 `CMD_UPDATE_PRESET_PET='update_preset_pet'`；
  `types/index.ts` `PresetPetItem.update_available?`、`LocaleKey 'update'|'updateFailed'`；
  `service/pet.ts` 增 `updatePresetPet(id)`；`utils/preset-card.ts` 新增
  `resolvePresetCardUpdate(item, progress)`（installed && update_available && 非
  downloading/extracting）；`components/pet-settings.tsx`：`PetCard` 增
  `updateDisabled/updateLabel/onUpdate`，动作区包 `<span class="dshp-pet__card-actions">`
  （更新按钮在主动作左侧 `dshp-pet__card-actionUpdate`），`startUpdate(id)` 走
  `updatePresetPet`→`pollPresetDownload` 同一进度轮询，busy 恢复轮询；
  cssr 增 actions（flex gap 6px）与 actionUpdate（次级色）；locales 增
  `update:'更新'/'Update'`、`updateFailed:'更新预设宠物失败'/'Failed to update preset pet'`。
- 宿主壳：`src/hooks/use-iframe-invoke.ts` `ALLOWED_INVOKE_CMDS` 增
  `'update_preset_pet'`，与 service/pet.ts 一一对应注释仍成立。
- 测试：Rust 4 条（`installed_ref_round_trips_and_handles_missing`、
  `update_available_requires_installed_and_differs_from_catalog_ref`、
  `install_staging_replaces_existing_with_backup_and_rolls_back_on_failure`、
  `install_staging_first_install_and_non_replace_reject`）；`preset-card.test.ts`
  新增 `resolvePresetCardUpdate` 5 用例。
- 验证：cargo check --lib / cargo test --lib 493 passed / pnpm typecheck（含 filter）/
  eslint 零警告 / pnpm test 109 passed / pnpm --filter dsh-tauri-pet build 全过。

## 审查结论与未采纳项（防重复评估）

- dsh-pet 的 `workStatusTick` 1s 轮询 `/dsh-pet-7340/work-status`（`ea0ca7e`）：
  **不需要**——本仓库已有事件驱动 host reducer，避免额外轮询。
- dsh-pet 其余提交（`33ca8f2` renderer 拆分、`12d9f44` 气泡样式、`26d8017` 透明窗黑框、
  `e1ff8c1` maxTokens、`a8c2cd0` reasoning-off）属其 Electron helper 或 host LLM 侧，
  与本仓库无关。
- dsh-dafeiyu：气泡文案/优先级逻辑已采纳（见 PR #414）；其 TASK 消息（todo/write →
  `taskCopy(task)` + 已完成 a/b 步）与 multi-session `#select()` 为多会话渲染方案，
  本仓库会话 Toast 一对一定位，未采纳。
- dsh-dafeiyu `taskCopy` 的句末语气词「呢」：**有意去掉**（用户反馈「正在处理 […] 后面的
  『呢』要去掉」）。句式结构（正在+原文 / 正在处理「原文」）仍与上游一致，只是不再带语气词；
  若后续再次同步上游文案，勿把「呢」带回来。

## 后续同步流程

1. 检查上游新提交：
   `git -C source/dsh-pet fetch origin && git -C source/dsh-pet log --oneline e1ff8c1..origin/main`
   （dsh-dafeiyu 同理）。
2. 若 dsh-pet 有新版本：评估影响面（shared/work-status、host 事件映射、client 轮询、
   资产入库 commit），确认新 WebM/config 字段后把 `preset-pets.json` ref 升到新 HEAD。
3. 若预设 ref 升级：Rust `validate_preset_pet_config` 对未知字段自动放行，一般无需改
   Rust；按需补动画/气泡映射与测试。
4. 验证四件套：
   `pnpm --filter dsh-tauri-pet typecheck`、`pnpm typecheck`、
   `pnpm exec eslint src/pet packages/dsh-tauri-pet/src/client packages/dsh-tauri-pet/src/host --max-warnings=0`、
   `pnpm test -- --run`、`pnpm --filter dsh-tauri-pet build`、
   `cargo check --manifest-path src-tauri/Cargo.toml --lib`、
   `cargo test --manifest-path src-tauri/Cargo.toml --lib`、`git diff --check`。
5. 完成后续回填本日志「同步记录」，并刷新「同步基线」。

## dsh-tauri-pet 同步日志（历史记录）

用于记录 `source/dsh-pet`、`source/dsh-dafeiyu` 能力同步到 `packages/dsh-tauri-pet` 的进度，避免后续重复对比或遗漏实现。

### 同步基线

- 参考项目：[`PC2005-cloud/dsh-pet`](https://github.com/PC2005-cloud/dsh-pet)（工作状态 6 档 + 预设资产）
- 本次对比版本：`v0.2.6`
- 本次对比提交：`e1ff8c1`
- 气泡文案参考：[`dsh-dafeiyu`](https://github.com/dsh-tauri-desk/dsh-dafeiyu) `v0.1.9`（`f4f4482`，仅参考不下载资产）
- 预设清单 ref：`src-tauri/resources/preset-pets.json` 的 `ref` = `e1ff8c1e4001878cbb80441262d530e16541f138`
  （新工作状态 WebM 在 dsh-pet `903dfde` 才入库，ref 必须 ≥ 该提交）
- 记录更新时间：2026-09-07

### 已同步

#### P0（预设资产与工作状态 6 档）

- [x] 预设 ref 升级 `f0f772e` → `e1ff8c1`，下载到 6 个新工作状态 WebM（思考冒泡/忙碌点按/清点归档/原地踱步张望/雀跃庆祝/垂头叹气冒汗）。
- [x] host reducer 细分档位：`PetWorkStatus = thinking | working | result | waiting | success | error`，事件映射
  （turn/start→thinking；tool/call→working（`ask_user_question` 例外→waiting）；tool/result→result/working；
  approval→waiting；turn/end：completed→success、error/max-tokens/timeout→error、blocked→waiting、其余→清回空闲）。
- [x] 工具级错误不再写 `lastAgentError`，不污染回合级终态；`turn/start` 清上一回合 `lastAgentError`。
- [x] 动画档位接线：`PRESET_SESSION_ANIMATIONS` 指向 6 个新动画名，`isLoopingAnimation` /
  `spriteStatusFallback`（thinking→waiting、working→running、result→review、success→waving、error→failed）。

#### P1（气泡对齐 dsh-dafeiyu）

- [x] 新增 `src/pet/hooks/bubble-copy.ts`：`seedNumber` / `statusCopy` / `activityCopy` / `taskCopy` /
  `toolActivityGroup`，**句式精确对齐 dsh-dafeiyu**（`正在${value}呢`，无空格）。
- [x] `use-bubble.ts` `STATUS_PRIORITY` 对齐 dsh-dafeiyu 档位：
  waiting=60 > error=50 > failed=45 > review=40 > working=30 > result=25 > thinking=20 > running=12 > success=10 > idle 族=0。
- [x] `sessionStatus` 优先 `workStatus`；修复 bug：`session.running === true` 时 lastAgentError/粗 error 不判 failed
  （会话还在跑时 toast 不消失）。
- [x] `app.tsx` loop 判定改 `isLoopingAnimation`；成功/失败终态动画播一次后回收。

#### P2（宠物更新）

- [x] Rust：`.preset-ref` 记录已安装版本；`preset_update_available` 判定更新可用；`install_staging(replace)` 两步
  rename + 备份回滚；`update_preset_pet` 命令：快照 `get_pet_status` → 在用则 `set_pet_enabled(false)` 强制停用 →
  `run_preset_download(replace=true)` → 成功 `reload_pet_window` → `was_enabled` 时 `set_pet_enabled(true)` 重新启用。
- [x] 前端：设置页「已选」按钮左侧「更新」按钮（`dshp-pet__card-actionUpdate`），复用 `pollPresetDownload`
  下载/解压进度条；`resolvePresetCardUpdate` 控制显隐；i18n `update` / `updateFailed`。
- [x] 宿主壳 `use-iframe-invoke.ts` `ALLOWED_INVOKE_CMDS` 增 `update_preset_pet`。
- [x] Rust `validate_preset_pet_config` 对未知字段自动放行，无需改动。

### 明确未同步（含原因）

- dsh-pet `workStatusTick` 1s 轮询 `/dsh-pet-7340/work-status`（`ea0ca7e`）：不需要——本仓库已有事件驱动 host reducer。
- dsh-pet 其余提交（`33ca8f2` renderer 拆分、`12d9f44` 气泡样式、`26d8017` 透明窗黑框、`e1ff8c1` maxTokens、
  `a8c2cd0` reasoning-off）：属其 Electron helper 或 host LLM 侧，与本仓库无关。
- dsh-dafeiyu TASK 消息（todo/write → `taskCopy(task)` + 已完成 a/b 步）与 multi-session `#select()`：本仓库会话
  气泡是一对一定位（各自 toast），未采纳其多会话顶选渲染方案；`taskCopy` 句式已吸收。
- 预设下载/更新安装目录内的其他备份清理：`update_preset_pet` 成功路径已清理备份，失败路径保留备份以便回滚判断。

### 验证记录

最近一次本地验证（PR #414 + #415 合并后全量）：

```text
cargo test --lib                        # 493 passed
pnpm test -- --run                      # 109 passed (17 files)
pnpm --filter dsh-tauri-pet typecheck
pnpm typecheck
pnpm --filter dsh-tauri-pet build
pnpm exec eslint src/pet packages/dsh-tauri-pet/src/client packages/dsh-tauri-pet/src/host --max-warnings=0
git diff --check
```

PR #414、#415 的 GitHub CI 均已通过。

### 后续同步流程

1. 获取参考仓库最新版本与提交：`git -C source/dsh-pet fetch origin && git -C source/dsh-pet log --oneline e1ff8c1..origin/main`（dsh-dafeiyu 同理）。
2. 若 dsh-pet 有新版本：评估影响面（`src/shared/work-status.ts`、`src/host/work-status.ts`、client 轮询、资产入库 commit），
   确认新 WebM/config 字段后升级 `preset-pets.json` 的 ref。
   - 同时确认 `platforms.macos` 的 `ref` 是否要跟到 dsh-pet-mov 的新产物 commit
     （该仓库按周跟随上游 `main` 重编并把 mov 提交回自己的 `main`；两边 ref 都要升，
     否则 macOS 会停在旧动画集；该仓库无需 Release，桌面端直接下 codeload tarball）。
3. 先更新本文件「同步基线」和「待同步」，再修改 host/client 实现。
4. 同步协议时同时检查：
   - `src-tauri/resources/preset-pets.json`
   - `src-tauri/src/bridge/preset_pet.rs`
   - `packages/dsh-tauri-pet/src/host/reducer.ts`
   - `packages/dsh-tauri-pet/src/client/{types,constants,service,components}/**`
   - `src/pet/{pet-config.ts,hooks/use-bubble.ts,hooks/bubble-copy.ts}`
5. 完成后运行 lint、typecheck、test、build、cargo check/test，并回填「验证记录」。
6. 将已完成项从「待同步」移到「已同步」，保留未实施项及原因。

### 待同步项

当前没有已确认、且适用于桌面端的需求在案。下一次参考仓库更新时，从新的 changelog 重新评估；用户如提出新的宠物交互需求，先在此登记再实施。
