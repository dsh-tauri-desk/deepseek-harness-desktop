# 代码审查报告 — deepseek-harness-desktop @ 031a946

审查范围：`8d917ab..031a946`（+68680/−9635，580 files）。
基线结论：branch `main`，`HEAD`/`origin/main`/`upstream/main` 均 = `031a9469726`，工作树干净。
未修改任何业务代码；本报告为手工审查结果。证据级别标注：「静态证实」(代码路径可推导) /「实证」/「推断」。

---

## P0/P1 — 严重

### 1. 远程来源 IPC 面被重新放回（安全回归，与历史加固冲突）

- 文件：`src-tauri/capabilities/default.json:4-8`（`remote: urls ["http://127.0.0.1:*"]`），权限集 `:9-28`（`core:default`、`core:window:*`、事件 `listen/unlisten/emit`、`opener:default/allow-open-url/allow-reveal-item-in-dir`、`store:default`）。
- 引入：`6f1c9a8 fix: restore loopback Harness permissions (#194)`（与 `d20d903/70d446b/e2309f3` 一起把权限逐步加回）。
- 基线对照：`8d917ab` 的 `default.json` **没有 `remote` 键**，其描述原文明确写着 *“The embedded remote Harness page does not receive native Tauri permissions and communicates with the shell through the restricted postMessage bridge”*。即本次提交把一个被刻意去掉的安全边界重新打开（`baae483 harden desktop security boundaries` 曾移除此能力）。
- 触发条件：任何能在 `127.0.0.1:任意端口` 提供服务并把页面导航/main/局部导航进 WebView 的本地进程（其它本地 dev server、被诱导打开的 link、本地脚本打的端口），其页面即进入 `remote` 匹配范围；能力授予 `main`/`pet` 两个窗。
- 影响：
  - `opener:allow-open-url` / `allow-reveal-item-in-dir`：远程页面可打开任意 URL、在文件管理器中 reveal 任意路径；
  - `store:default`：可读写应用持久化 store（settings.dat 中保存端口、active_core、窗口几何等）；
  - `core:event:allow-emit`：可向宿主注入事件；
  - `core:window:allow-set-position/set-size/...`：任意窗口操作。
  - Tauri 2.9/2.11 侧的 ACL 语义（`tauri-2.11.5/src/ipc/authority.rs:439-468`、`src/webview/mod.rs:1770-1830`，本地 cargo registry）：远程 origin 只有在 capability 里的 `remote` 匹配时才被授予对应命令权限；本项目把 `127.0.0.1:*` 整段放回并把权限扩充（新增 `emit`、`window set-position/set-size/set-ignore-cursor-events` 等），等于授予任何 loopback 端口页面上述能力。
- 影响级别：**P1（安全回归）**。即使当前 iframe 桥（`use-iframe-invoke` 白名单）限制了 shell↔iframe 的 postMessage 通道，远程 capability 走的是 WebView 自身的 Tauri IPC，**不经过该白名单**。

---

### 2. 归档解压可被恶意 tar 越界写文件（绝对路径 + 符号链接穿越）

- 位置：`src-tauri/src/service/backup/archive.rs:203-218`（只拒绝 `ParentDir`，未拒绝 `RootDir`/Windows `Prefix`；`dest.join(&stripped)` 在 Rust 中遇到绝对路径会**整体替换**目标，`dest.join("/etc/passwd") == "/etc/passwd"`）以及 `:242-260`（`create_symlink(&target, &dest_path)` 对 target 无任何约束，之后写入可跟随链外写到任何用户可写路径）。
- 两条还原入口都复用该函数：`mod.rs::restore_backup`（Overwrite/AsNew）与 `snapshot.rs:627` 的插件快照还原。
- 触发条件：用户/扩展提供的 tar/tar.gz 归档含绝对路径条目，或含 `symlink -> /absolute` 与后续一个条目；fileName 无前瞻校验。
- 影响：恶意/损坏归档可将任意用户可写位置覆盖写（如 `~/.bashrc`、`~/.ssh/authorized_keys`、`.git/config` 等），或把文件写到 profile 之外。开发者文档（`docs/AGENTS.desktop.md`）要求提取必须拒绝逃逸；此处缺口与文档对照明确。
- 静态证实：`std::path::Path::join` 对绝对分量丢弃 base 是 Rust 语义；`symlink` 目标从不校验。
- 级别：**P1**（存在本地文件放置面；归档来源既有用户选择、也有扩展快照），最保守也至少 P2。

---

## P2 — 高/中

### 3. 备份清单读取/删除缺少“路径在备份目录内”的约束，且错误被吞成空清单

- 位置：
  - `src-tauri/src/service/backup/mod.rs:95-110`（`read_manifest`：任意读错误都当成 “manifest 不存在” 并返回空清单；随后 `write_manifest` 可能用空清单覆盖真实成立的文件）
  - `src-tauri/src/service/backup/mod.rs:241-258`（`delete_backup` 直接用 manifest 中的 `path` → `fs::remove_file(&file)`，未校验 `file` 属于 `backup_dir`）
  - `src-tauri/src/service/backup/retention.rs:23-26,64`（`read_to_string().unwrap_or_default()` + 按存于清单的绝对 `path` 删除，未做 `is_within(backup_dir)` 校验）
- 触发条件：清单文件损坏/权限错误/瞬时 IO 错误；或清单被篡改（含 `../` 或绝对 `path` 字段）后执行 prune/delete。
- 影响：备份索引被悄悄清空；replay 场景下可通过清单字段删除任意路径文件。
- 级别：**P2**（数据完整性 / 非受控删除，主机本地）。

### 4. worktree 会话路径穿越（sessionId 未校验即拼路径）

- 位置：`packages/dsh-tauri-worktree/src/host/storage/index.ts:35-40`（`sessionFile = ledger/<sessionId>.json`）、`:76-99`、`:112-126`；路由 `packages/dsh-tauri-worktree/src/host/routes/index.ts:139-147`（`create` 直接把 `body.sessionId` 传入 `ensureWorktree`）。
- 触发条件：仓库的 HTTP 路由（由宿主 Web 服务器挂载在本地端口）收到含 `../../…` 的 `sessionId`/`sourceSessionId`。路由 `create`/`attach`/`checkout` 均对 sessionId 无 `fs_guard` 式校验。备注：`withConnectionAuth`（`packages/dsh/ 宿主 utils/http.ts:29-41`）仅在宿主注入 `connection.requestRejection` 时才实际拦截；本地直接调用裸 TCP 时无拦截，尚依赖宿主提供 gate。
- 影响：在 `worktreesRoot`（`~/ .dsh`）之外的 `.json` 文件写入/删除/读取（越过根的一层或多层）。
- 级别：**P2**（需要能访问本地 loopback 路由的调用者；若宿主真实提供 mutation 鉴权则降为 P3——但 sessionId 本身仍是未校验的直接拼接，瑕疵成立）。

### 5. 调度器 `settlesWithin` 里的超时被自己的 finally 立即清除（第二退出上限失效）

- 位置：`packages/dsh-tauri-panel-scheduler/src/host/service/executor.ts:170-182`
  ```ts
  try {
    return Promise.race([ promise.then((v) => v, () => false), new Promise((resolve)=>{ timer=setTimeout(resolve, timeoutMs,false) }) ])
  } finally { if (timer) clearTimeout(timer) }
  ```
  注意：`finally` 块在 `Promise.race(...)` **构造完成后同步立即执行**（无需等任何一个子 Promise 完成），所以计时器在创建后立刻被清除，`timeoutMs` 分支永远不会触发；`settlesWithin` 实际等于 `promise.then(()=>true,()=>false)`。
- 调用点 `:385`：`if (timedOut && !await settlesWithn(idle, CANCEL_CONVERGENCE_TIMEOUT_MS))` —— 当任务超时后 agent 一直不到 idle 时，`settlesWithin` 永不 resolve → 任务永远挂起，不会再得到 `cancel_convergence_timeout` 收尾。
- 影响：单次定时任务的“取消收敛”兜底失效，运行永远无法结束（占用 agent/进程），是确定性 bug（不是竞态）。
- 级别：**P2**（功能正确性 / 任务悬挂；只在小概率“取消不收敛”路径上显现）。

### 6. 调度器包无 tsconfig，`typecheck` 脚本没有输入 → 类型门禁失效

- 位置：`packages/dsh-tauri-panel-scheduler/package.json:60`（`typecheck: tsc`）；该包**不存在** `tsconfig.json`（其它包均有），根 `tsconfig.json` 仅 `include:["src"]`（apps/web），不覆盖 packages。
- 影响：`pnpm --filter dsh-tauri-panel-scheduler typecheck` 会向上找父级根 tsconfig 而对`src/` 做类型检查（不覆盖 scheduler 源码），实际是“静默零覆盖”，与 `docs/AGENTS.plugins.md“每包必配 tsconfig”的约定相悖。
- 级别：**P2**（类型门禁缺口，回归可带进 build）。

---

## P3 — 低/待确认

### 7. 插件快照文件名/目标路径的规范化不一致（低）

- 位置：`src-tauri/src/service/plugin/snapshot.rs:113-130`（`snapshot_filename` 先做 `fs_guard::validate_id(&sanitized)`）、`:154-176`（`resolve_real_target` 用 `node_modules.join(id)` 未做 `is_actionable_plugin_ref` 强校验）、`:588` 还原流才校验 `is_actionable_plugin_ref`。
- 影响：`foo` 与 `@scope/pkg` 都可能规范到 `_scope_pkg` 一类文件名——同名碰撞；还原路径校验范围不覆盖创建路径。属于低危不一致（碰撞/覆盖已有的扩展名）而非穿越。
- 级别：**P3**（一致性 / 未覆盖的边界）。

### 8. `launch.rs` 里 `dsh_binary_path` 在获取过渡锁之前解析（竞态，推断）

- 位置：`src-tauri/src/service/workflow/launch.rs:262-280`（`get_dsh_binary_path` 在 `acquire_core_transition` 之前），与 `核心版本切换`（`src-tauri/src/service/core/version.rs: 115/336-386`）共用一把锁。
- 影响：窗口很小——但若用户在启动过程中切换核心，等到 lock 后 spawn 的分支可能与 `exists()` 检查时看到的路径不一致（dependencies/dsh 目录在交换）。因 `get_dsh_binary_path` 是固定路径（`dependencies/dsh`）而非历史槽位，此处不是“启动旧版本”，更多是“面向新/旧不一致的窗口误判”。影响较低，属于竞态防护的整洁性缺口。
- 级别：推断 P3。

### 9. 附带（信息项）

- `scripts/build-plugins.ts` 中原先的 `verifyDeployedPackages`（逐包校验 `dsh` 元数据 + `main` 入口存在）在 `8f62a35..031a946` 中被删除（diff 显示函数整体移除，只剩 `verifyMaterialized`）。此后发布时“packages 空产物”将不再被脚本拒绝，`pnpm deploy` 仍 exit 0。**与 8c088e4f 子代理报告的观察一致，静态证实。**
- css-render 内联：**在本基线不存在回归**。`packages/dsh-tauri/package.json` 与 `packages/dsh-tauri-pet/package.json` 中 `css-render` 均属 `devDependencies`（`catalog:ui`），tsdown 的默认 external 仅取 `dependencies`，故 css-render 会被打进 client bundle。**实证**：重新执行 `pnpm --filter dsh-tauri build`、`pnpm --filter dsh-tauri-pet build` 后，`dist/client.cjs` 中 CssRender 工厂代码内联、无 `require('css-render')` 残留、产物可加载。此前子代理 `8c088e4f` 声称会残留 external require → 发布加载失败，**已被实证反驳**。
  - 注：后续提交（9f2b7cf 等）把它当作需要 `dshClientInline` 显式内联来维护，属于防御性加固；当前评审点不构成 bug（建议 build gate 补充断言，见 #10）。

---

## 测试缺口汇总（按影响）

- 无测试覆盖 capability`remote` 的最小权限集（`capabilities/default.json`）；`src-tauri/src/desktop/builder.rs` 里`security_tests::remote_capability_allows_only_loopback_harness` 仅断言 remote=127.0.0.1 存在——它锁定的恰好是风险面而不是安全面。应当是：不允许任何 remote、或 remote 下只允许白名单命令的子集。
- 无测试覆盖 `archive.rs` 的绝对路径 & symlink escape（现有测试只测 ParentDir）。
- 无测试覆盖 worktree sessionId `../` 穿越（`storage/index.test.ts` 全为正例）。
- 无测试覆盖 `settlesWithin` timeout 分支（当前测试只覆盖 runtime 导出与 guard 词表）。
- 无测试覆盖 `read_manifest` 读错误 → 空清单回滚路径；`retention` prune 的“目录外 path”删除。

---

## 实证验证记录（本轮实际运行）

- **`cargo test --lib service::backup` → 23/23 passed**。其中 `rejects_path_traversal_on_restore`（archive.rs:482-504）只构造 `../../...`（`ParentDir`）条目并断言拒绝——**未覆盖绝对路径 / Windows Prefix 条目**，因此 #2 的「绝对对路径」逃逸仍未被当前测试锁定（Rust `Path::join` 对绝对分量会整体替换 base，已在 cargo registry 的 `tar-0.4.46` 源码确认 `header.path_bytes` 保留前导 `/`，不做剥离）。
- **`pnpm vitest` (scheduler) → 22/22 passed**（`executor.test.ts` 只覆盖 `unattendedToolGuardReason`/`loadSchedulerRuntimeModules`，**没有 `settlesWithin` 的 timeout 分支用例**，故 #5 死代码未被测试发现）。
- **`pnpm vitest run worktree/storage/index.test.ts` → 6/6 passed**，全是正例，没有 `sessionId=../…` 穿越用例（#4）。
- **css-render**：重跑 `pnpm --filter dsh-tauri build` / `dsh-tauri-pet build`，`dist/client.cjs` 内联 CssRender、无 `require('css-render')` → 此前标记 P1 的打包回归**实证不成立**（详见 §9）。
- `cargo build`（增量）成功，16 个 warning（`clone` 未用等）。

## 补充核实（排除项）

- **`isLoopback`/XFF**：`packages/dsh-tauri/src/host/utils/http.ts:43-45` 只读 `socket.remoteAddress`（TCP 对端），不使用 `X-Forwarded-For`，且宿主监听 127.0.0.1 → 不可被 XFF 头欺骗。`panel-extension/restart.ts` 的 `trustedRestartRequest` 还额外拒绝 `forwarded`/`x-forwarded-for`/`x-real-ip`——两者均为反向；无缺陷。
- **`panel-extension` tar 解压（repos.ts:232 → tar.ts）**：JS 侧 `safeJoin`（tar.ts:60-76）拒绝 `/` 前缀、`[A-Z]:` 盘符、`..`，跳过 symlink/hardlink，且限制条目大小/总数/总字节 → 无穿越。
- **`panel-extension` skills 路由**：`validateSkillInput`（skills.ts:53-）kebab-case 强校验 + `writeSkill/deleteSkill` 再校验 + `policy/save` 用宿主解析的 `definition.path` 而非请求路径 + 全部 `sameOrigin` gate → 边界完整。
- **`panel-extension` repos 本地仓库**：`addLocalRepo` 用 `resolve` 后仍要求存在目录 + 检测 SKILL.md；`restart` 反向校验转发头 → 无新增风险。

## 目标覆盖确认（第 2 轮补充）

**核心服务生命周期 / 更新 / 核心切换（Rust 侧，全部为排除项或已确认项）**

- **桌面更新模块 `src-tauri/src/service/update/install.rs`**：`open_installer`（:305-329）用 `dunce::canonicalize` 后 `starts_with(&updates_real)` 严格限制在 `AppData/updates/` 内，拒绝符号链接/`..`/绝对路径 → 安全。`download`（:214-289）先写 `.part` 临时文件再校验 SHA-256（镜像兜底必须有可信摘要，:229-231 注明「宁可失败」）再原子 rename → 安全。**排除项**。
- **核心切换 `src-tauri/src/service/core/version.rs`**：`switch_app_version`（:392-）先持 `acquire_core_transition` 锁（与 launch 共用），`:398/493/547` 均 `fs_guard::validate_id(tag)` + `safe_slot_path`，rename 失败回滚 → 路径与切换均受控。**排除项**。
- **pnpm 插件安装 `plugin/install/pnpm.rs`**：全部 `std::process::Command::new` 参数化（无 shell 拼接），且有「路径含空格和 shell 元字符」专项测试（:755-）→ 无命令注入。**排除项（静态证实 + 测试存在）**。
- **CLI `service/cli/core.rs`**：仅符号链接管理（ensure/remove/status），无命令执行面。**排除项**。

**内置插件协议（session / panel 排除；worktree 确认）**

- **`dsh-tauri-session`**：`locateSessionDataDir`（session-files.ts:107-119）用 `encodeSessionId`（:57-71 全量编码 `~XXXX`，`..` → `~002E~002E`）+`is`WithinSessionsRoot`（:50-54）→ **比 worktree 更严格，被遍历已防御**。**排除项（与 #4 对比的证据）**。
- **`dsh-tauri-panel`/`dsh-tauri-pet`/`dsh-tauri-rightclick`「dsh-tauri-placeholder」**：纯 client 包，无宿主路由 → 无路径面。**排除项**。
- **worktree `routes/index.ts`**：`create` 路由 :139-141 直接 `String(body.sessionId ?? '')`，`:138` routeHandler 包 `withConnectionAuth(ctx.connection,…)`；但 `packages/dsh-tauri/src/host/utils/http.ts:29-33` — 当 `connection?.requestRejection` 不是函数时**退化为裸执行**（`:30` 直接走 handler），宿主若不注入 connection gate 则穿越未被缓解 → 维持 #4 P2（依赖宿主注入）。

**本轮实证命令**：
- `cargo test --lib` → **469/469 passed**（覆盖 archive、retention、cli、install、workflow 全部 Rust 单测）2.40s。
- `pnpm --filter dsh-tauri-panel-scheduler typecheck` → `tsc` **exit 0 且零输出**（根 `tsconfig.json` 仅 include `["src"]`=apps/web，scheduler 源码零覆盖），**实证密码被 P2 命中**。

## 结论（修订版）
1. 立即评估并收缩 `remote`（去掉 127.0.0.1:* 通配或替换为白名单子集 + 最小命令），补回 `baae483` 的边界。
2. `archive.rs` 增加 `RootDir`/`Prefix`/绝对路径/`..` 拒绝并校验 symlink target 不能位于根之外。
3. 工作树 sessionId 增加 `fs_guard::validate_id` + canonical with-within 检查。
4. 修 `settlesWithin`（不要直接用 `finally` 清 timer；改为 `.finally()` 在 race 后清理 或 用 AbortController）。
5. 恢复 `build-plugins.ts` 的包级验证；给 scheduler 补 tsconfig。
6. 补上述测试。

---

## 修复执行记录（本轮落地，按发现编号对应）

> 状态图例：✅ 已修复 / ◐ 部分 / ⛔ 维持现状

### #1 P1-1 remote capability 收缩 — ✅
- `src-tauri/capabilities/default.json`：删除 `"remote": {"urls": ["http://127.0.0.1:*"]}`；`description` 改为 “NO remote URLs granted; shell and pet windows only load bundled local assets, and the embedded Harness page communicates through the restricted postMessage bridge”。
- `src-tauri/src/desktop/builder.rs`：把**锁定风险面**的 `remote_capability_allows_only_loopback_harness`（断言 remote=127.0.0.1:* 存在，恰好锁住了风险本身）替换为 `capability_grants_no_remote_urls`：断言 capabilities 文件不含 `"remote"`、`http://127.0.0.1:*`、`https://`。
- 验证：`cargo test --lib desktop::builder::security_tests` → **2/2 passed**。
- 说明：**#1 的 P1 评级针对修复前的配置状态**（`default.json` 中 `remote: 127.0.0.1:*` 通配 + 权限扩充，授予任何 loopback 端口页面能力）。当前 repo 实际主/pet 窗口均 `WebviewUrl::App`（本地 `tauri://`），无导航到 `127.0.0.1` 的代码路径，`remote` 通配不构成当前代码的可达越权；本次收缩（删除 remote、断言零 remote）属于**纵深防御**加固，与 `baae483` 历史安全边界一致，最终配置不授予任何远程 URL 的 Tauri capability，也没有可到达该面的特权 IPC 路径。

### #2 P1-2 archive.rs 绝对路径 / Prefix / symlink 逃逸 — ✅
- `src-tauri/src/service/backup/archive.rs`：
  - 条目路径：除既有 `ParentDir` 外，新增 `Component::RootDir | Component::Prefix(_)` 拒绝（绝对路径 / Windows 盘符）→ `BACKUP_EXTRACT_PATH_ESCAPE`；
  - symlink：`target.is_absolute()` 拒绝；相对 target 先 `dest.parent()` 词法规范化再按前缀校验落后于 `dest` 内（`..` 上溯、根转义拒绝；目录内合法相对链保持可用——既有 `nested_symlinks_work` 的 `../real.txt` 照常通过）；
  - 新增 `normalize_lexically` 辅助。
- 测试：`rejects_absolute_path_entry_on_restore`、`rejects_symlink_target_escape_on_restore`、`rejects_symlink_target_escape_on_restore_2（..）`、`accepts_in_root_relative_symlink_on_restore`、`write_raw_tar_symlink` helper。
- 验证：`cargo test --lib service::backup::archive` → **18/18 passed**（既有 `nested_symlinks_work` / `symlinks_are_backed_up_and_restored` 不回归）。

### #3 备份清单读错/删除越界 — ✅
- `src-tauri/src/service/backup/mod.rs`：
  - `read_manifest`：`NotFound` → 合法空（首次备份）；**其它 IO/权限错误 → `ReadError` 返回 Err**，不再“读不到就当空清单”，杜绝 `write_manifest` 空清单覆盖成立文件；
  - `delete_backup` 复核：其删除路径由 `archive_filename(active, timestamp)` 重建且 timestamp 已 `validate_id`，不使用 manifest `path`，符合预期（未动）。
- `src-tauri/src/service/backup/retention.rs`：
  - 复用 `read_manifest`/`write_manifest`，去掉 `read_to_string().unwrap_or_default()` 静默空分支；
  - 删除前 `is_within(backup_dir, path)`（词法规范化 + 前缀包含）校验，越界 warn 跳过；
  - 测试夹具统一 `setup_fake_backups(prefix, n)` 独立目录，避免并行互踩。
- 测试：`refuses_to_delete_outside_backup_dir`、`rejects_dotdot_escape_path`、`accepts_internal_path`、`read_manifest_read_error_is_not_empty`。
- 验证：`cargo test --lib service::backup` → **30/30 passed**。

### #4 worktree sessionId 校验 — ✅
- `storage/index.ts`：新增 `assertSafeSessionId`（空 / `.` / `..` / 非 `[\w.-]+` 拒绝），`sessionFile` / `checkoutContextFile` 收口。
- `routes/index.ts`：`create`/`attach` 先 `safeSessionIdOr400` → 非法 HTTP 400。
- 测试：`assertSafeSessionId` describe（合法 kebab / 非法 / 写入-read路径）。
- 验证：`npx vitest run` → **23/23 passed**。
- 补充：`sourceSessionId` 仅会话查找/继承 seed，不触文件路径；`worktreeHashDirname` 仅 binding 字符串比较或 `existsSync` 探测 → 无新增越界面。

### #5 `settlesWithin` 超时修复 — ✅
- `executor.ts`：去掉 `finally { clearTimeout }`（构造完同步即清，`timeoutMs` 分支永不触发）；改为显式 `new Promise`：`setTimeout(resolve(false))` vs `promise.then/…`，先到者清定时并 resolve。
- 测试：`settlesWithin` describe（resolve / timeout / reject / 长超时），`vi.getTimerCount()===0` 无泄漏。
- 验证：`pnpm --filter dsh-tauri-panel-scheduler test` → **26/26 passed**。

### #6 scheduler tsconfig + typecheck 门禁 — ✅
- 新增 `packages/dsh-tauri-panel-scheduler/tsconfig.json`（与 session/worktree/extension 同构）。
- 门禁生效即暴露 20 处历史类型错误（全被“零覆盖”吞掉），分别修复：
  - `types/dsh.d.ts` 的 `@deepseek-ai/dsh-client-ui-primitives` ambient 遮蔽删除——子集声明把 `MenuEntry`/`IconChevronDownOutline14`/`IconCheckOutline16` 等真实导出全部遮蔽 → 改走真实包 d.ts；
  - cordis `Context` 补 `reflect` 字段（`ctx.reflect.get` 协议取数，panel.tsx:35）；
  - React 19 `JSX.Element` → `import type { JSX } from 'react'`；`RefObject<HTMLDivElement | null>`（menu.tsx）；
  - `Object.hasOwn` → `Object.prototype.hasOwnProperty.call`（ES2021 lib 兼容，schedule.ts）；
  - `options.ts` record 收窄 / presets 可选链 / current null-or-undefined。
- 验证：`pnpm --filter dsh-tauri-panel-scheduler typecheck` → `tsc` exit 0（真实检查）；测试 26/26 不回归。

### 附 +9 build 门禁恢复 — ✅
- `scripts/build-plugins.ts` 恢复 `verifyDeployedPackages`（dsh 元数据 + main 文件），紧随 `verifyMaterialized`；实现与 `8f62a35^` 历史版逐字一致（diff 为空），`node --check` 通过。

---

### #7 插件快照创建流包名校验（对齐还原流范围）— ✅
- `src-tauri/src/service/plugin/recovery/mod.rs`：`is_package_name` 提升为 `pub(crate)`，供插件快照复用。
- `src-tauri/src/service/plugin/snapshot.rs`：
  - `resolve_real_target`（创建快照时把 id 拼进 `node_modules/<id>` 的入口）与 `snapshot_filename`（文件存储口径）均新增 `is_package_name(id)` 前置校验——`../x`、绝对路径、非 scoped 的 `a/b` 等多段/脏形态在进入路径拼接前即被拒绝（此前 `a/b` 会被净化成 `a_b` 收下，属范围外的脏输入）；
  - 「同名碰撞」由此只可能发生在两个合法包名净化后完全相同的罕见情形，与还原流的 `is_actionable_plugin_ref`（合法包名 + 非核心）范围语义对齐：创建允许核心包做只读快照、还原仍拒绝核心包。
- 测试：`filename_sanitizes_scoped_and_rejects_traversal` 更新 `a/b` 为拒绝；新增 `resolve_real_target_rejects_invalid_package_name`（`../x`、`a/b`、`/etc/passwd` 全部拒绝）。
- 验证：`cargo test --lib service::plugin::snapshot` → **8/8 passed**（含既有两个归档往返测试不回归）。

### #8 launch 锁前解析 dsh_binary_path 竞态 — ✅
- `src-tauri/src/service/workflow/launch.rs`：`launch()` 中 `active_dsh_binary()` 的解析与 `exists()` 检查移到 `acquire_core_transition()` **锁内**（Node 路径固定、不参与核心切换，保留锁前快速失败）；`dsh_binary_path` 全程在临界区内按锁后解析值使用，杜绝「切换在解析与 spawn 之间穿插→按旧路径决策按新路径执行」的窗口误判。
- `start()` 的锁前解析仅用于 `installed` 快速判断（缺失即回落处理），spawn 决策全部最终委托 `launch()` 的锁内路径——无需改动。
- 验证：全量 `cargo test --lib` 通过（见下）。

### 最终验证汇总
- Rust：`cargo test --lib` → **477/477 passed**（security_tests 2/2、backup 30/30、archive 18/18、retention 8/8、plugin::snapshot 8/8、workflow 等全部通过）。
- TS：scheduler `vitest` **26/26**；worktree `vitest` **23/23**；四包 `tsc --noEmit` 全绿。
- 构建：`tsdown`（scheduler / worktree，含改动包）→ **Build complete + publint 无问题**。
- `git status`：20 修改 + 2 新增（本报告、scheduler tsconfig.json），改动与修复目标一一对应。

### 测试缺口汇总 → 闭合状态
原始「测试缺口汇总」（第 5 节）五项，修复后均已补上用例：
- capability `remote` 最小权限集 → `capability_grants_no_remote_urls`（builder.rs）
- `archive.rs` 绝对路径 & symlink escape → `rejects_absolute_path_entry_on_restore` 等 3 个新用例 + helper
- worktree sessionId `../` 穿越 → `assertSafeSessionId` describe（storage/index.test.ts，正反例）
- `settlesWithin` timeout 分支 → `settlesWithin` describe（executor.test.ts，含 `getTimerCount()===0` 泄漏断言）
- `read_manifest` 读错误 / retention 目录外 path → `read_manifest_read_error_is_not_empty` + `refuses_to_delete_outside_backup_dir` / `rejects_dotdot_escape_path`

### 附：§9 的「#10 build gate 断言」— ✅ 已落地
§9 正文引用的「见 #10」仅指一个建议性小改进（在 build 门禁里补一条「client bundle 内联 CssRender」断言），未作为正式发现立项。现已在 `scripts/build-plugins.ts` 落地为常驻门禁 `verifyClientBundleInlineCssRender`：build 后扫描 `dsh-tauri/dist/client.cjs`，禁止外部 `require('css-render')` 残留、并要求存在 CssRender 内联体。`pnpm build:plugins` 全程验证通过（9 插件部署 + 校验）。与既有 `verifyDeployedPackages` + `verifyMaterialized` 合璧，css-render 内联从「一次实证」升级为「每次构建强制」。此为工程 `eae2c18` 提交。

---

## 附：upstream 同步记录（merge 031a946..eec5431，136 提交）— ✅

为跟上官方基线，将本仓库同步到 upstream/main（136 个新提交），采用 **merge 方式**（保留本地 6 个修复提交，形成 merge commit `893d9d6`）。

- **冲突解决（6 文件）**：`schedule.ts`（采用 upstream monthly 新功能 + 保留本地 ES2021 兼容 hasOwnProperty + 修复编辑引入的重复函数）、`options.ts`（采用 upstream `current == null` 简洁收窄）、`executor.test.ts`（upstream 无扩展名风格 + 保留本地 settlesWithin 用例）、`model-picker.tsx`/`menu.tsx`（采用 upstream `dsh-tauri-ui/client` 重构：Icon/useMountStyle）、`worktree routes`（保留本地 `assertSafeSessionId` + upstream 无扩展名风格）。
- **合并暴露的修复**：`types/stubs/dsh-client-ui-primitives.d.ts` 的 `MenuProps.onSelect` 签名错误（stub 写成 `(entry: MenuEntry)`，真实包为 `(id: string)`）——本地 typecheck 门禁暴露并修正；重新构建 dsh-tauri-ui / dsh-tauri 的 dist（upstream 引入新 client 导出）+ `pnpm install` 同步 workspace 链接。
- **验证（合并后基线）**：`cargo test --lib` **501/501**（含 upstream 新增测试）、scheduler `vitest` 25/25 + typecheck 全绿、worktree `vitest` 67/67 + typecheck 全绿、`pnpm build:plugins` 全程通过（含 css-render 内联断言）。
- **本地修复保留确认**：merge commit 中 `launch.rs` 锁内解析、`assertSafeSessionId`、`settlesWithin` 修复均完好。
- 状态：已推送 `68e20a2..893d9d6` 到 fork origin/main；本地与 origin 同步，基线吸收 upstream 全部提交（本地仅领先 7 = 6 修复 + merge）。

---

## 附：CodeRabbit PR 评审反馈处理（PR-448）— ✅

上游 PR（[dsh-tauri-desk → dsh-tauri-desk PR #448](https://github.com/dsh-tauri-desk/deepseek-harness-desktop/pull/448)）的 CodeRabbit 评审给出 5 条 actionable 评论，逐条验证并处理：

| # | 范围 | 评审意见 | 处置 |
|---|---|---|---|
| 1 | `snapshot.rs:184` `resolve_real_target` | 包入口 symlink 解析后目标可能逃出 `node_modules` 根 | ✅ 修复：新增 `canonicalize(node_modules)` 根 + 词法前缀校验（拒绝根外目标）；补回归测试 `resolve_real_target_rejects_entry_symlink_escaping_root` |
| 2 | `launch.rs:164-170` `start()` preflight | `start` 在锁外解析/检查 `dsh_binary_path`，核心切换空窗会误置 `installed=false` | ✅ 修复：缺失处理移入 `launch` 锁内（含 Windows 448 逃逸）；`start` 仅保留 node 快速失败 |
| 3 | `worktree storage/index.ts:96` | `loadBindingSync` 非法 id 仍落入 legacy 回退键查找 | ✅ 修复：校验放 try 外，非法 id 直接 null；补 legacy fixture 测试 |
| 4 | `REVIEW-031a946.md` | 文档含开发机绝对路径、`~/.cargo`；#1 应明确为纵深防御 | ✅ 已改：路径改仓库相对；`~/.cargo` 改通用描述；#1 措辞补充说明 |
| 5 | `archive.rs`/`retention.rs` | 解压/删除面对 symlink 祖先的纵深加固；`accepts_in_root_relative_symlink_on_restore` 需加 `cfg(unix)` | ◐ 部分：已加 `#[cfg(unix)]` 限 unix 测试；`symlink 祖先`为纵深建议，现有词法+canonicalize 防护已覆盖实际 exploit 面，维持现状（记录原因） |
| 6（二轮） | `snapshot.rs:201` `create` | TOCTOU：resolve 校验与 count/append 遍历之间未持锁，`node_modules/<id>` 可被并发 restore 替换为根外 symlink | ✅ 修复：`create` 持 `acquire_operation_lock`（与 `restore`/`enable`/`disable` 同一把锁），覆盖 resolve→count→append 全程；替换方 `restore` 本已持锁，闭合窗口 |

验证：`cargo test --lib` **502/502**（含新增回归测试）、worktree `vitest` **68/68**、scheduler 25/25、typecheck/lint 全绿。