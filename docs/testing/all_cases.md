# 测试用例汇总（all_cases.md）

> 由 testcase-generator 生成，合并自 docs/test-case/{ITEM}/{POINT}.md。供人工评审。

---

# 安装与首次启动

## 运行时与内核依赖安装

> 测试项：安装与首次启动（ITEM 01）
> 风险：高
> 覆盖：首次启动自动下载内置 Node 运行时与 Harness 内核；安装状态机（Initial→Installing→Running）；`install_dependencies` 返回 bool；重复触发；中断清理

## [P1] 验证首次启动自动下载内置 Node 运行时与 Harness 内核
[测试类型] 功能
[前置条件] 全新安装环境，`%APPDATA%\io.github.hairyf.deepseek-harness-desktop` 下无 `runtime`、`dependencies`，且 `.store.dat` 不存在；网络可达 nodejs.org 与 github.com；Windows x64
[测试步骤] 1. 删除 `%APPDATA%\io.github.hairyf.deepseek-harness-desktop` 下的 `runtime`、`dependencies` 目录与 `.store.dat` 文件，确认应用数据已被清空。2. 首次启动桌面端，进入「安装依赖」界面，等待状态机由 Initial 变为 Installing 并观察 install-progress 事件。3. 安装完成后执行 `runtime\node.exe --version`，并查看 `dependencies\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js` 是否存在。4. 读取本次 install_dependencies 的返回结果与 store 中 installed 字段
[预期结果] 1. 界面显示安装进度从 0% 递增，状态机由 Initial 变为 Installing，并持续推送 install-progress 事件。2. 安装进度百分比单调递增直至 100%，`runtime\node.exe` 已落盘。3. `runtime\node.exe --version` 输出 v22.22.0，`dependencies\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js` 与 `dependencies\pnpm\bin\pnpm.cjs` 均存在。4. install_dependencies 返回 true，store 中 installed 为 true

## [P1] 验证安装完成后状态机由 Installing 进入 Running
[测试类型] 可靠性
[前置条件] runtime 与 dependencies 三件套已完整安装；服务端口 3080 空闲；网络可用
[测试步骤] 1. 在安装完成、install_dependencies 返回 true 后，点击「启动 Harness」调用 launch_harness。2. 等待服务启动，读取 get_dsh_status 并监听 dsh-status-updated 事件。3. 访问 `http://127.0.0.1:3080/healthz` 校验健康状态
[预期结果] 1. 状态机由 Installing 变为 Starting 后再变为 Running，并推送 dsh-status-updated 事件。2. 服务进程存在且监听 127.0.0.1:3080，状态面板显示 Running。3. `http://127.0.0.1:3080/healthz` 返回成功（200），`proxy_health_check` 返回 healthy 与 body 前 80 字符

## [P2] 验证本机已有内核时跳过下载并复用本地文件
[测试类型] 兼容性
[前置条件] 本机已装入与最新 release 一致的 dsh 内核且 dsh_pkg_commit 与最新 commit 相同；`runtime\node.exe`（v22.22.0）与 pnpm 已就绪；store 中 installed 为 true；网络可达
[测试步骤] 1. 记录 `dependencies\dsh\node_modules\@deepseek-ai\dsh` 目录文件的修改时间作为基线。2. 启动桌面端并触发 install_dependencies，观察日志中是否出现 Download 任务。3. 流程结束后重新比对目录文件修改时间与 install_dependencies 返回值
[预期结果] 1. 日志出现 "Dependencies already installed and up to date, skipping installation"，不出现 Download 日志。2. 目录文件修改时间与基线一致（未被重新解压），install_dependencies 返回 false。3. 服务正常进入 Running，无任何重新下载

## [P2] 验证运行时文件在盘但记录显示未安装时自愈补记 installed
[测试类型] 可靠性
[前置条件] `runtime`、`dependencies\dsh`、`dependencies\pnpm` 文件均已完整在盘，但 store 中 installed 为 false（模拟安装器强杀进程后记录被复位）；网络可达
[测试步骤] 1. 用编辑器把 `.store.dat` 中 setting.installed 改为 false，保留完整运行时文件后启动桌面端。2. 观察 install_dependencies 流程、界面表现与日志。3. 读取 store 中 installed 字段与 install_dependencies 返回值
[预期结果] 1. 日志出现 "Runtime files already present although store says not installed, healing installed flag"，首页不闪现安装界面。2. 不重新下载 runtime/dsh/pnpm（无 Download 日志，目录文件未被改动）。3. 流程结束 installed 被补置为 true，install_dependencies 返回 false，应用直接进入 Running

## [P3] 验证安装过程中重复触发安装被抑制
[测试类型] 稳定性
[前置条件] 首次安装进行中（状态机为 Installing）；网络正常但下载较慢以留出操作窗口
[测试步骤] 1. 首次安装进行中、状态机处于 Installing 时，再次调用 install_dependencies（如点击「重新安装」）。2. 记录第二次调用的日志、触发的新任务数与返回结果。3. 等待首次安装自然结束
[预期结果] 1. 日志出现 "Installation process already running, skipping"，重复调用立即返回 false。2. 不产生第二个安装任务、不重启下载，install-progress 事件仍只由首次安装驱动。3. 首次安装正常完成并置 installed 为 true

## [P3][反向] 验证安装被中断后清理干净且不破坏正式安装
[测试类型] 稳定性
[前置条件] 已存在一次完整安装（`dependencies\dsh` 可用）；随后触发一次真更新安装（新版 dsh 的 digest 可用）；网络可中途断流以制造中断
[测试步骤] 1. 在解压阶段或切目录前强制结束桌面进程，制造中断。2. 重新启动桌面端，观察安装流程与 `dependencies` 下的残留目录。3. 检查 `%APPDATA%\io.github.hairyf.deepseek-harness-desktop\dependencies` 下是否存在 `.dsh.installing-*` 临时目录与 `.dsh.backup` 备份目录
[预期结果] 1. 正式目录 `dependencies\dsh` 仍完整可用（未被清空或残留半成品），启动不受影响。2. 下次启动时 `.dsh.installing-*` 临时目录被清理（ensure_extract 开头 remove_path_if_exists(staging)）。3. 若 `.dsh.backup` 存在且正式目录缺失，则恢复旧版本（INSTALL_RECOVERY）；最终安装能正常完成并进入 Running


## 下载与解压进度

> 测试项：安装与首次启动（ITEM 01）
> 风险：高
> 覆盖：两阶段进度（下载 0–50、解压 50–100）；进度事件实时推送；失败重试（官方直连→ghfast.top 镜像兜底）；下载中断与解压失败

## [P1] 验证正常下载进度事件递增且到达 100%
[测试类型] 功能
[前置条件] 全新安装环境；网络可达 GitHub 官方直连；订阅 install-progress 事件并监听日志
[测试步骤] 1. 删除 `%APPDATA%\io.github.hairyf.deepseek-harness-desktop` 下的 `runtime`、`dependencies` 与 `.store.dat`，启动桌面端进入安装。2. 订阅 install-progress 事件（或观察界面进度条），连续记录 type=download 阶段的百分比序列。3. 等待安装完成，记录最终百分比与 install-progress 事件总数
[预期结果] 1. 下载阶段百分比从 0% 单调递增，事件实时推送（相邻事件间隔不超过 50ms 节流上限），type 为 download。2. 同一下载任务只产生一条 `Download <url>` 日志，进度阶段随 detail 更新而不重复写入同 URL 日志行。3. 最终 percentage 到达 100%，detail 为安装完成文案，日志出现 "All tasks completed"

## [P2] 验证官方直连失败时自动切换镜像兜底下载成功
[测试类型] 兼容性
[前置条件] 全新安装；阻断 `github.com` 与 `release-assets.githubusercontent.com` 的访问（模拟官方直连失败），但 `ghfast.top` 可达；dsh 资产 SHA-256 摘要可获取
[测试步骤] 1. 通过 hosts/proxy 规则阻断对 `github.com` 与 `release-assets.githubusercontent.com` 的访问，保留 `ghfast.top` 可达。2. 启动安装，观察 install-progress 事件与日志中的下载源切换。3. 等待安装完成，校验 `dependencies\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js` 是否生成
[预期结果] 1. dsh 任务先尝试官方源 `https://github.com/.../deepseek-harness-pkg-windows.zip`，失败后日志记录 "Primary download source failed, switching to fallback source"。2. 进度面板展示 "主下载源不可用，已切换镜像源重试（ghfast.top）"，随后镜像源接管下载。3. 镜像下载完成后 SHA-256 校验通过，`dependencies\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js` 生成，安装成功

## [P4] 验证下载进度 0-50、解压 50-100 两阶段
[测试类型] 功能
[前置条件] 仅 Harness 内核需要下载与解压（Node 运行时与 pnpm 已就绪被跳过）；订阅 install-progress 事件
[测试步骤] 1. 触发 Harness 内核（index=1）的安装，订阅 install-progress 事件。2. 分别记录下载阶段（type=download）与解压阶段（type=extract）的百分比序列。3. 比对两阶段的百分比范围与整体进度是否单调递增且不超过 100%
[预期结果] 1. 下载阶段百分比从 0 递增，且进入解压前不越过 50% 阈值。2. 解压阶段从约 50% 继续递增至 100%，两阶段百分比无重叠。3. 全程百分比单调递增且不超过 100%，末尾 detail 为安装完成文案

## [P3] 验证下载中网络中断提示并可重试
[测试类型] 可靠性
[前置条件] 全新安装；下载进行中在某时刻（如 40%）断网；监听 install-progress 事件与日志
[测试步骤] 1. 启动安装，在下载进行至约 40% 时切断网络。2. 观察界面提示、日志中的重试序列与断点续传行为。3. 等待自动重试耗尽（最多 5 次）后恢复网络
[预期结果] 1. 界面出现 "下载中断（网络传输被重置），已自动重试 5 次仍失败，已下载约 X MB，请检查网络后重试"。2. 日志记录每次失败后的退避时长（2s/4s/8s/8s）与续传起点（resume from N bytes）。3. 恢复网络后重试从断点续传（带 Range 头分片合并，服务端支持 206 时不从头下载），完整性校验通过后到达 100%

## [P3][反向] 验证解压失败提示且不产生残留安装
[测试类型] 稳定性
[前置条件] 已将 dsh 安装包字节破坏（如改坏 zip central directory）或使解压目标不可写；已装入 dsh 内核可作对照
[测试步骤] 1. 把下载到的 dsh 安装包内容替换为内容损坏的 zip，或只读化 `%APPDATA%\io.github.hairyf.deepseek-harness-desktop\dependencies`。2. 触发安装，观察解压阶段的报错与 install_dependencies 返回。3. 解除限制后检查 `dependencies` 下的残留目录与安装结果
[预期结果] 1. 解压阶段报错并提示（如 Invalid ZIP format 或 INSTALL_PATH_LOCKED），install_dependencies 以错误结束。2. `.dsh.installing-*` 临时目录被清理，`.dsh.backup` 不残留垃圾。3. 既有安装未被破坏，解除限制后重试可成功


## 本机Node与Pnpm复用

> 测试项：安装与首次启动（ITEM 01）
> 风险：高
> 覆盖：本机已有兼容 Node/pnpm 时直接复用，不修改系统环境；未检测到才走内置运行时

## [P1] 验证本机已有兼容 Node v22.22.0 时复用不下载
[测试类型] 兼容性
[前置条件] 本机 PATH 中存在 node v22.22.0（`node --version` 输出 v22.22.0）；`%APPDATA%\io.github.hairyf.deepseek-harness-desktop\runtime` 不存在；网络可达
[测试步骤] 1. 在本机安装 Node v22.22.0 并加入 PATH，确认 `node --version` 输出 v22.22.0。2. 清空 `runtime` 目录后启动桌面端触发安装，观察日志与 `runtime` 目录变化。3. 安装完成后读取 get_active_node_version 并确认服务启动
[预期结果] 1. 日志出现 "Detected compatible local Node.js (C:\...\node.exe), skipping bundled runtime"，Node 任务被跳过。2. `runtime` 目录未被创建，仅 dsh 与 pnpm 任务执行下载/解压。3. get_active_node_version 返回 22.22.0，服务正常启动进入 Running

## [P2] 验证本机 Node 版本过期时回退内置 Node
[测试类型] 兼容性
[前置条件] 本机 PATH 中存在 node v22.14.0（低于 v22.15.0 下限）；捆绑 `runtime\node.exe` 已是 v22.22.0；网络可达
[测试步骤] 1. 在本机安装 Node v22.14.0 并加入 PATH，确认 `node --version` 输出 v22.14.0。2. 确保 `%APPDATA%\io.github.hairyf.deepseek-harness-desktop\runtime\node.exe` 位于 v22.22.0。3. 启动安装，观察 Node 任务是否走捆绑运行时（is_runtime_compatible 判定）与安装结果
[预期结果] 1. 本机 v22.14.0 不满足 v22.15.0 门槛，get_local_node_path 返回 None，不使用本机 node。2. 捆绑 `runtime\node.exe`（v22.22.0）被复用，Node 任务 check_installed 通过兼容判定、不重新下载。3. get_active_node_version 返回 22.22.0，安装成功并进入 Running

## [P2] 验证本机已有 pnpm 时优先用用户 pnpm
[测试类型] 兼容性
[前置条件] 本机 PATH 中存在用户安装的 pnpm（主版本 ≥ 10，如 pnpm 11.7.0）；捆绑 `dependencies\pnpm\bin\pnpm.cjs` 已存在；网络可达
[测试步骤] 1. 在本机安装 pnpm 11.7.0 并加入 PATH，确认 `pnpm --version` 输出 11.7.0。2. 触发安装调用 install_preinstall_plugins（含需要 pnpm 的插件）。3. 观察日志中是否出现捆绑 pnpm 的下载/解压与插件安装所用 pnpm
[预期结果] 1. 日志出现 "Detected user-installed pnpm, skipping bundled pnpm"，Pnpm 任务 check_installed 返回 true、不下载捆绑版。2. 插件安装子进程使用用户 pnpm，未出现 "[pnpm] bundled pnpm not found, downloading before plugin install"。3. 用户 pnpm 主版本与档案 store 主版本一致时直接复用（ensure_pnpm 返回 false、不注入 DSH_PREFER_BUNDLED_PNPM）

## [P2] 验证本机无 Node 时走内置运行时
[测试类型] 兼容性
[前置条件] 本机 PATH 中无任何 node（`where node` 无结果）；捆绑 `runtime\node.exe`（v22.22.0）缺失或可下载；网络可达
[测试步骤] 1. 移除本机所有 node（或确保 PATH 中无 node），确认 `where node` 无输出。2. 启动安装，观察 Node 任务是否下载/使用内置运行时。3. 安装完成后校验 `runtime\node.exe` 与 get_active_node_version
[预期结果] 1. get_local_node_path 返回 None（无本地 node），Node 任务走下载路径（runtime 缺失时）或复用已装捆绑运行时。2. `runtime\node.exe`（v22.22.0）就绪，dsh/pnpm 任务正常执行。3. get_active_node_version 返回 22.22.0，安装完成并进入 Running

## [P4] 验证复用过程不修改系统 PATH/环境
[测试类型] 安全性
[前置条件] 本机已有兼容 node v22.22.0 与用户 pnpm 11.7.0；命令行集成开关 cli_link_enabled 为 false；`$DSH_HOME` 指向 `%USERPROFILE%\.dsh`
[测试步骤] 1. 记录安装前 `$env:PATH` 完整值、用户级环境变量与 `%LOCALAPPDATA%\deepseek-harness\bin` 目录是否存在。2. 触发 install_dependencies 并等待完成。3. 安装后再读取 `$env:PATH`、用户级环境变量与 `bin` 目录
[预期结果] 1. 安装后 `$env:PATH` 与安装前完全一致（未追加 `%LOCALAPPDATA%\deepseek-harness\bin`）。2. `%LOCALAPPDATA%\deepseek-harness\bin` 未因本次复用而新建或写入 shim（sync_cli_link 走 cli::remove）。3. 用户环境变量中未新增 `dsh` 相关 PATH 项，本机 node/pnpm 未被改写或重装


## 首次启动预设插件引导

> 测试项：安装与首次启动（ITEM 01）
> 风险：高
> 覆盖：预设清单（`resources/preset-plugins.json`）；`get_preinstall_plugins`/`install_preinstall_plugins`/`skip_preinstall_plugins`/`cancel_preinstall_plugins`/`get_preinstall_pending`/`open_preinstall_repo`；指纹（preset_hash）决定是否重新进入引导

## [P1] 验证首次启动列出预设插件清单且推荐/修复/默认项默认勾选
[测试类型] 功能
[前置条件] 全新安装（preinstall_done 为 false）；首次启动进入引导页；网络可达；Windows x64（验证 win_only 修复项）
[测试步骤] 1. 首次启动进入预装插件引导页，调用 get_preinstall_plugins 获取列表。2. 检查每个条目的推荐/修复/已安装标签、勾选态与其 spec/package。3. 将列表与 `src-tauri\resources\preset-plugins.json` 逐项比对
[预期结果] 1. 列表包含 `dshmarket`、`dsh-tauri`、`dsh-better-sidebar`（均推荐）、`dsh-notification`（defaultChecked）；已废弃的 `dsh-session-context-menu`（deprecated:true）不再列出。2. Windows 上额外列出 `dsh-win-terminal-inspector`（fix 修复 chip 默认勾选），非 Windows 平台不列出。3. 未安装的 recommended/fix/defaultChecked 项默认勾选；已安装项显示已安装并禁用勾选

## [P1] 验证确认后调用安装并按当前档案执行
[测试类型] 功能
[前置条件] 引导页勾选 `dshmarket` 与 `dsh-notification`；活动档案为默认 web；网络可达；dsh CLI 与 node 就绪
[测试步骤] 1. 在引导页选中 `dshmarket`、`dsh-notification`，点击「安装」。2. 观察 preinstall-log 事件与后端实际执行命令。3. 等待安装完成，读取 store 中 preinstall_done 与 preset_hash
[预期结果] 1. 后端执行 `dsh plugin --profile web add dshmarket git+https://github.com/omdsh-dev/dsh-notification.git`，日志显示 normalize_git_spec 后的实际 spec。2. preinstall-log 实时回流构建日志，成功日志显示 "[harness] 已安装 2 个插件"。3. 安装成功后 store 中 preinstall_done 置为 true，preset_hash 记录当前 preset-plugins.json 的 FNV-1a 指纹

## [P2] 验证跳过则记录 preinstall_done 完成不再弹出
[测试类型] 功能
[前置条件] 全新安装（preinstall_done 为 false）；引导页显示；跳过操作不依赖网络
[测试步骤] 1. 首次启动进入引导页，点击「跳过」调用 skip_preinstall_plugins。2. 读取 store 中 preinstall_done 与 preset_hash。3. 关闭并重新启动桌面端，观察是否再次弹出引导
[预期结果] 1. skip_preinstall_plugins 将 preinstall_done 置为 true（无需联网）。2. preset_hash 被记录为当前 preset-plugins.json 的 FNV-1a 指纹（当前可读时）。3. 再次启动 get_preinstall_pending 返回 false，引导页不再弹出、直接进入启动流程

## [P3] 验证取消正在进行的安装
[测试类型] 稳定性
[前置条件] 引导页正在执行 install_preinstall_plugins（网络较慢）；监听 preinstall-log 事件
[测试步骤] 1. 在安装进行中点击「取消」调用 cancel_preinstall_plugins。2. 观察 backend 是否结束 `dsh plugin` 子进程树及 preinstall-log 是否停止新增。3. 读取 store 中 preinstall_done 与 preset_hash，重新启动桌面端查看是否再次弹出
[预期结果] 1. `dsh plugin` 子进程树被结束，安装停止，preinstall-log 不再新增行。2. store 中 preinstall_done 仍为 false（取消不等于完成），preset_hash 未更新或保持旧值。3. 再次启动 get_preinstall_pending 返回 true，引导页重新弹出（除非用户随后跳过/确认）

## [P4] 验证预设清单指纹变更后重新进入引导
[测试类型] 可维护性
[前置条件] 已完成一次引导（preinstall_done 为 true，preset_hash 记为 h1）；可读写 `src-tauri\resources\preset-plugins.json`
[测试步骤] 1. 确认 get_preinstall_pending 返回 false，记录 preset_hash 为 h1。2. 修改 `src-tauri\resources\preset-plugins.json`（如新增一个 id 或改动某字段），使内容指纹变化为 h2。3. 重新启动桌面端
[预期结果] 1. current_preset_hash 计算出的 h2 与记录 h1 不同（FNV-1a 对内容敏感，改任一字符即变）。2. get_preinstall_pending 返回 true，引导页重新弹出以确认新清单。3. 若 preset-plugins.json 缺失（current_preset_hash 返回 None）则视为无变化不再弹出，避免每次启动空引导

## [P5] 验证点击「打开仓库」打开源地址
[测试类型] 易用性
[前置条件] 引导页列表渲染完成；系统默认浏览器可用；`dshmarket` 行处于可点状态
[测试步骤] 1. 在引导页点击 `dshmarket` 行的仓库图标，调用 open_preinstall_repo（id=dshmarket）。2. 观察系统浏览器打开的地址与引导页状态。3. 再对清单外 id 调用 open_preinstall_repo（如 id=unknown-package）观察返回
[预期结果] 1. 系统默认浏览器打开 `https://github.com/dsh-market/dsh-market`（该 id 在清单中的 repoUrl）。2. 打开仓库后引导页状态不变，仍停留在安装确认界面。3. 对清单外 id 返回 `PREINSTALL_INVALID_ID: unknown-package` 错误且不打开浏览器


## 安装失败与网络异常处理

> 测试项：安装与首次启动（ITEM 01）
> 风险：高
> 覆盖：GitHub 不可达；下载/校验/解压失败；镜像兜底失败；可信 SHA-256 摘要缺失的安全中止；提示与重试

## [P1] 验证 GitHub 不可达时保留本地已装内核继续使用
[测试类型] 可靠性
[前置条件] 本地已装入 dsh 内核且记录与最新一致；阻断对 `api.github.com`、`github.com`、`release-assets.githubusercontent.com` 的访问；网络其余可达
[测试步骤] 1. 阻断上述 GitHub 域名访问后启动桌面端，触发 install_dependencies。2. 观察日志、返回值与既有 `dependencies\dsh` 目录是否被改动。3. 启动 Harness 服务并访问 `http://127.0.0.1:3080/healthz`
[预期结果] 1. 日志出现 "Failed to check latest dsh release info, keeping local install"，dsh_need_install 判定为 false。2. install_dependencies 返回 false，不重新下载/解压 dsh，既有内核文件保持不变。3. 服务正常进入 Running，`http://127.0.0.1:3080/healthz` 返回成功（200），本地内核继续使用

## [P3] 验证下载/校验/解压任一失败给出明确错误提示且不影响已有安装
[测试类型] 可靠性
[前置条件] 已装入 dsh 内核（可用）；存在新版 dsh 且 digest 可获取；分别构造下载/校验/解压三类失败
[测试步骤] 1. 同时阻断 dsh 官方源与 ghfast.top 镜像，启动更新以触发下载失败。2. 另换一次用与真实安装包不匹配的伪造 SHA-256，启动更新以触发校验失败。3. 再换一次将解压目标设为只读，启动更新以触发解压失败
[预期结果] 1. 下载失败返回 `DOWNLOAD_INTERRUPTED`（含已尝试源数与已下载 MB），流程在下载阶段即中止、不进入解压。2. 校验失败返回 `INTEGRITY_CHECK_FAILED: SHA-256 mismatch`，未落盘任何文件。3. 解压失败返回 Invalid ZIP format 或 `INSTALL_PATH_LOCKED` 前缀错误；三次失败均不改动既有 `dependencies\dsh`，存量内核仍可启动进入 Running

## [P3] 验证网络不可达时提示并给出重试入口
[测试类型] 易用性
[前置条件] 全新安装；全程断网（github.com 与 nodejs.org 均不可达）
[测试步骤] 1. 断网状态下首次启动，触发安装，观察界面提示与错误信息。2. 检查安装状态是否仍为未安装、是否残留安装。3. 恢复网络后点击界面「重试」入口
[预期结果] 1. 界面出现下载/检查失败提示（如 DOWNLOAD_INTERRUPTED 或网络不可达），并展示「重试」按钮。2. 状态未置为 installed、无残留部分安装，应用未进入 Running（停留在待重试）。3. 恢复网络点击「重试」后重新走下载流程，成功后 installed 置为 true、状态进入 Running

## [P3] 验证下载核心缺少可信 SHA-256 摘要时安全中止不下载
[测试类型] 安全性
[前置条件] 已装入 dsh 内核；存在新版；模拟 GitHub API 与 expanded_assets 页面均无法返回摘要（digest 为 None）
[测试步骤] 1. 阻断 `api.github.com` 与 expanded_assets 页面，使新版 dsh 的 digest 取不到，触发 install_dependencies。2. 观察日志、返回值与是否发生下载。3. 检查既有内核是否保留、服务能否启动
[预期结果] 1. 日志出现 "New dsh release <tag> found but trusted digest unavailable (API rate-limited), keeping local install"，dsh_need_install 判定为 false。2. 不下载、不解压 dsh（无 Download 日志），install_dependencies 返回 false。3. 既有内核保留可用、服务进入 Running，更新提示由 check_dsh_update 在启动后给出、可稍后重试

## [P2] 验证重试成功后恢复正常
[测试类型] 可靠性
[前置条件] 全新安装；首次网络受限导致失败（状态未 installed、无残留安装）；之后恢复网络
[测试步骤] 1. 首次安装因网络中断以错误结束，确认未产生残留安装。2. 恢复网络后点击「重试」再次触发 install_dependencies。3. 等待安装完成并启动服务
[预期结果] 1. 重试后下载续传或重新下载，SHA-256 校验通过，dsh/pnpm 正常落盘。2. install_dependencies 返回 true，installed 置为 true，preset/preset_hash 正常记录。3. 服务进入 Running，`http://127.0.0.1:3080/healthz` 返回成功（200），后续启动不再触发下载


---

# Harness 核心管理

## 核心列表展示

## [P1] 验证存在本地核心时列表同时展示 local 与 app 版本行
[测试类型] 功能
[前置条件] 本地已通过 `npm install -g @deepseek-ai/dsh` 安装 dsh 0.1.0-rc.8，store 的 active_core 未设置（自动，本地优先）；预打包目录 dependencies/dsh 已安装 0.1.0-rc.7；GitHub tags 网络正常。
[测试步骤] 1. 打开「核心」管理面板并等待列表加载完成。2. 检查列表行内容与来源标记。
[预期结果] 1. 列表加载无错误提示，接口正常返回。2. 列表首行为 local 行，其 id=local、source=local、present=true、active=true、version=0.1.0-rc.8；其后并列存在 source=app 的版本行（含 0.1.0-rc.7，active=false）。

## [P2] 验证无本地核心时列表仅展示预打包版本行
[测试类型] 功能
[前置条件] 本地未安装 dsh（PATH 无 dsh，node_modules/@deepseek-ai/dsh 不存在）；预打包目录 dependencies/dsh 已安装 0.1.0-rc.7；store 的 active_core 未设置。
[测试步骤] 1. 打开「核心」管理面板并等待列表加载完成。2. 检查列表是否出现 local 行以及预打包行。
[预期结果] 1. 列表加载无错误提示。2. 列表不含 local 行（无 source=local 行），仅含 source=app 的版本行，其中激活的 0.1.0-rc.7 行 id=app-dsh-0.1.0-rc.7-31773193668、active=true、present=true。

## [P3] 验证离线或限流时列表降级为磁盘扫描仍展示已下载与激活版本
[测试类型] 功能
[前置条件] 已下载历史版本到槽位 dependencies/dsh-0.1.0-rc.7-31773193668，当前激活 core=app 0.1.0-rc.8（记录 tag=dsh-0.1.0-rc.8-32331963388）；网络离线或 GitHub API 限流，tags 拉取失败。
[测试步骤] 1. 断开网络（或触发 GitHub API 403 限流使 tags 拉取失败）。2. 打开「核心」管理面板并等待列表加载完成。
[预期结果] 1. tags 拉取失败被降级记录，不出现错误弹窗或失败状态。2. 列表仍渲染：激活的 0.1.0-rc.8 行 present=true、active=true；已下载的 0.1.0-rc.7 行 present=true。

## [P4] 验证同版本打多个 tag 时去重并只保留最后一个 tag
[测试类型] 功能
[前置条件] GitHub tags 返回 0.1.0-rc.8 的三个 tag（dsh-0.1.0-rc.8-32331963388、dsh-0.1.0-rc.8-32342588166、dsh-0.1.0-rc.8-32342588167）以及 0.1.0-rc.7-31773193668；本地核心 version=0.1.0-rc.8。
[测试步骤] 1. 打开「核心」管理面板并等待列表加载完成。2. 检查 0.1.0-rc.8 版本行的数量与 id。
[预期结果] 1. 列表加载无错误提示。2. 0.1.0-rc.8 仅出现一行，其 id=app-dsh-0.1.0-rc.8-32342588167（保留最后一个 tag），行内无重复；而 0.1.0-rc.7 版本行为 id=app-dsh-0.1.0-rc.7-31773193668。


## 激活核心切换

## [P1] 验证切换到本地核心成功并持久化 active_core=local
[测试类型] 功能
[前置条件] 本地已通过 npm 安装 dsh 0.1.0-rc.8，store 的 active_core 当前为 app；预打包目录 dependencies/dsh 已安装 0.1.0-rc.7；harness 服务未运行。
[测试步骤] 1. 打开「核心」管理面板，点击 local 行（id=local）的「激活」。2. 检查 store 的 active_core 值及返回的激活行。
[预期结果] 1. 界面提示切换到本地核心成功，无错误。2. active_core 持久化为 local，且返回行 id=local、source=local、active=true、version=0.1.0-rc.8。

## [P1] 验证切换到已下载历史版本成功且两目录互换
[测试类型] 功能
[前置条件] 当前激活 core=app 0.1.0-rc.8（记录 tag=dsh-0.1.0-rc.8-32331963388）；已下载槽位 dependencies/dsh-0.1.0-rc.7-31773193668；harness 服务未运行。
[测试步骤] 1. 在「核心」管理面板点击 id 为 app-dsh-0.1.0-rc.7-31773193668 的版本行的「激活」。2. 检查 dependencies 目录下各目录内容。
[预期结果] 1. 切换成功，无错误提示。2. dependencies/dsh 现为 0.1.0-rc.7-31773193668 的内容，原 0.1.0-rc.8 已被改名为槽位 dependencies/dsh-0.1.0-rc.8-32331963388，激活行更新为 id=app-dsh-0.1.0-rc.7-31773193668、active=true。

## [P1] 验证切换到预打包（app）核心成功且已装预打包时可用
[测试类型] 功能
[前置条件] 本地已通过 npm 安装 dsh 0.1.0-rc.8 且 store 的 active_core 当前为 local；预打包目录 dependencies/dsh 已安装 0.1.0-rc.7；harness 服务未运行。
[测试步骤] 1. 在「核心」管理面板点击 id 为 app（无 tag 记录的旧激活行）的「激活」。2. 检查 store 的 active_core 值及返回行。
[预期结果] 1. 切换成功，无错误提示。2. active_core 持久化为 app，返回行 source=app、active=true、present=true，版本号为 0.1.0-rc.7。

## [P2] 验证切换到历史版本前自动停止运行中的服务
[测试类型] 功能
[前置条件] harness 服务进程正在运行（owned process 存在）；当前激活 core=app 0.1.0-rc.8（记录 tag=dsh-0.1.0-rc.8-32331963388）；已下载槽位 dependencies/dsh-0.1.0-rc.7-31773193668。
[测试步骤] 1. 记录当前 harness 服务进程存在。2. 在「核心」管理面板点击 id 为 app-dsh-0.1.0-rc.7-31773193668 的版本行的「激活」。3. 检查切换后服务进程状态与目录。
[预期结果] 1. 服务进程运行中。2. 切换成功，无错误提示。3. 切换完成后服务进程已停止（has_owned_process 为 false），dependencies/dsh 已为 0.1.0-rc.7-31773193668 内容。

## [P3][反向] 验证切换目录重命名失败时回滚到原版本
[测试类型] 功能
[前置条件] 当前激活 core=app 0.1.0-rc.8（记录 tag=dsh-0.1.0-rc.8-32331963388）；已下载槽位 dependencies/dsh-0.1.0-rc.7-31773193668；制造第二步「目标版本进入激活位」的重命名失败（如目标目录被杀毒软件独占或只读）。
[测试步骤] 1. 使目标目录 dependencies/dsh 的 rename 持续失败。2. 在「核心」管理面板点击 id 为 app-dsh-0.1.0-rc.7-31773193668 的版本行的「激活」。3. 检查返回错误与磁盘目录。
[预期结果] 1. 重命名失败条件已就绪。2. 切换报错。3. 返回错误 CORE_SWITCH_FAILED（含 target 到 active_dir 的路径），原目录被回滚：dependencies/dsh 仍为 0.1.0-rc.8 内容，rc.7 槽位未进入激活位。

## [P3][反向] 验证切换到未下载 tag 报 CORE_VERSION_NOT_DOWNLOADED
[测试类型] 功能
[前置条件] 当前激活 core=app 0.1.0-rc.8（记录 tag=dsh-0.1.0-rc.8-32331963388）；对应 dsh-0.1.0-rc.9-32342588170 的槽位未下载。
[测试步骤] 1. 在「核心」管理面板触发 id 为 app-dsh-0.1.0-rc.9-32342588170 的切换。2. 观察返回结果与目录。
[预期结果] 1. 不执行任何目录重命名操作。2. 返回错误 CORE_VERSION_NOT_DOWNLOADED: dsh-0.1.0-rc.9-32342588170，dependencies/dsh 目录保持不变。


## 历史版本下载

## [P1] 验证下载指定 tag 到槽位成功并展示两阶段进度
[测试类型] 功能
[前置条件] 槽位 dependencies/dsh-0.1.0-rc.7-31773193668 未下载；网络正常；GitHub 返回该 tag 的资产 URL 与可信 sha256 摘要。
[测试步骤] 1. 在「核心」管理面板点击 dsh-0.1.0-rc.7-31773193668 版本行的「下载」。2. 观察进度面板阶段切换与完成后槽位。
[预期结果] 1. 下载成功且槽位 dependencies/dsh-0.1.0-rc.7-31773193668 生成。2. 进度分两阶段：download（0-50%）提示「正在下载核心版本 dsh-0.1.0-rc.7-31773193668」，extract（50-100%）提示「正在解压核心版本 dsh-0.1.0-rc.7-31773193668」。

## [P2] 验证下载已存在的 tag 时幂等返回不重复下载
[测试类型] 功能
[前置条件] 槽位 dependencies/dsh-0.1.0-rc.7-31773193668 已存在（已下载）。
[测试步骤] 1. 在「核心」管理面板对已下载的 dsh-0.1.0-rc.7-31773193668 再次点击「下载」。2. 观察是否有网络下载与返回行。
[预期结果] 1. 不触发网络下载，无两阶段进度显示。2. 直接返回该版本行，id=app-dsh-0.1.0-rc.7-31773193668、present=true，且无错误。

## [P3][反向] 验证下载源 tag 元数据缺失时报 CORE_METADATA_FAILED
[测试类型] 功能
[前置条件] 槽位 dependencies/dsh-0.1.0-rc.7-31773193668 未下载；fetch_dsh_pkg_asset 返回 Err（GitHub API 与 expanded_assets HTML 均不可达）。
[测试步骤] 1. 在断网或 API 不可达状态下点击 dsh-0.1.0-rc.7-31773193668 的「下载」。2. 观察返回结果与槽位。
[预期结果] 1. 不创建槽位目录，无进度。2. 返回错误 CORE_METADATA_FAILED（含底层原因）。

## [P3][反向] 验证缺少可信 SHA-256 摘要时安全中止下载并报 CORE_INTEGRITY_UNAVAILABLE
[测试类型] 功能
[前置条件] 槽位 dependencies/dsh-0.1.0-rc.7-31773193668 未下载；fetch_dsh_pkg_asset 成功但 digest=None（GitHub API 限流且 HTML 无摘要）。
[测试步骤] 1. 使该 tag 取不到可信 sha256 摘要（限流+HTML 均无）。2. 点击 dsh-0.1.0-rc.7-31773193668 的「下载」。3. 观察返回结果与槽位。
[预期结果] 1. 摘要取源均失败。2. 下载被安全中止，无 download/extract 进度。3. 返回错误 CORE_INTEGRITY_UNAVAILABLE: trusted SHA-256 unavailable for dsh-0.1.0-rc.7-31773193668, cannot download safely，槽位目录未创建。

## [P3][反向] 验证下载校验摘要不一致时报 CORE_INTEGRITY_FAILED
[测试类型] 功能
[前置条件] 槽位 dependencies/dsh-0.1.0-rc.7-31773193668 未下载；资产内容与所需 sha256 摘要不一致（如服务端内容被替换/摘要配置错误）。
[测试步骤] 1. 使下载内容与预期 sha256 不符。2. 点击 dsh-0.1.0-rc.7-31773193668 的「下载」。3. 观察返回结果与槽位。
[预期结果] 1. 下载完成但校验未通过。2. 解压阶段不触发。3. 返回错误 CORE_INTEGRITY_FAILED: SHA-256 mismatch, expected <期望>, got <实际>，槽位目录未创建。


## 历史版本卸载

## [P1] 验证卸载非激活的历史版本成功
[测试类型] 功能
[前置条件] 槽位 dependencies/dsh-0.1.0-rc.7-31773193668 已下载且非激活；当前激活 core=app 0.1.0-rc.8（记录 tag=dsh-0.1.0-rc.8-32331963388）；harness 服务未运行。
[测试步骤] 1. 在「核心」管理面板点击 id 为 app-dsh-0.1.0-rc.7-31773193668 的版本行的「卸载」。2. 检查槽位目录与列表。
[预期结果] 1. 卸载成功，无错误提示。2. dependencies/dsh-0.1.0-rc.7-31773193668 目录被删除，列表中该行消失。

## [P3][反向] 验证卸载激活中的版本被拒绝并提示 CORE_ACTIVE_VERSION
[测试类型] 功能
[前置条件] 当前激活 core=app 0.1.0-rc.8（记录 tag=dsh-0.1.0-rc.8-32331963388）；dependencies/dsh 为该激活目录。
[测试步骤] 1. 在「核心」管理面板点击 id 为 app-dsh-0.1.0-rc.8-32331963388（激活行）的「卸载」。2. 观察返回结果与目录。
[预期结果] 1. 卸载被拒绝，不执行目录删除。2. 返回错误 CORE_ACTIVE_VERSION: cannot remove in-use version dsh-0.1.0-rc.8-32331963388，激活目录 dependencies/dsh 保留。

## [P3][反向] 验证卸载不存在的版本报 CORE_VERSION_NOT_FOUND
[测试类型] 功能
[前置条件] 对应 dsh-0.1.0-rc.9-32342588170 的槽位未下载。
[测试步骤] 1. 在「核心」管理面板触发 id 为 app-dsh-0.1.0-rc.9-32342588170 的「卸载」。2. 观察返回结果与目录。
[预期结果] 1. 无目录被删除。2. 返回错误 CORE_VERSION_NOT_FOUND: dsh-0.1.0-rc.9-32342588170。

## [P2] 验证卸载历史版本前自动停止服务防止句柄锁定
[测试类型] 功能
[前置条件] harness 服务进程正在运行（owned process 存在）；槽位 dependencies/dsh-0.1.0-rc.7-31773193668 已下载且非激活。
[测试步骤] 1. 记录当前 harness 服务进程存在。2. 在「核心」管理面板点击 id 为 app-dsh-0.1.0-rc.7-31773193668 的版本行的「卸载」。3. 检查卸载后服务进程状态与目录。
[预期结果] 1. 服务进程运行中。2. 卸载成功，无错误提示。3. 卸载后服务进程已停止（has_owned_process 为 false），dependencies/dsh-0.1.0-rc.7-31773193668 已被删除。

## [P3][反向] 验证删除目录失败时报 CORE_REMOVE_FAILED 且原目录保留
[测试类型] 功能
[前置条件] 槽位 dependencies/dsh-0.1.0-rc.7-31773193668 已下载且非激活；使 remove_dir_with_retry 在 40 次重试后仍失败（如目录被进程持续独占）。
[测试步骤] 1. 以持续独占方式占用该槽位目录使删除失败。2. 在「核心」管理面板点击 id 为 app-dsh-0.1.0-rc.7-31773193668 的版本行的「卸载」。3. 观察返回结果与目录。
[预期结果] 1. 删除失败条件已就绪。2. 卸载报错。3. 返回错误 CORE_REMOVE_FAILED（含槽位目录路径），dependencies/dsh-0.1.0-rc.7-31773193668 目录仍保留，列表中该行仍存在。


## 本地核心更新

## [P1] 验证更新本地核心到最新版本成功并回读新版本号
[测试类型] 功能
[前置条件] 本地以 npm 布局安装 dsh 0.1.0-rc.7（<prefix>/node_modules/@deepseek-ai/dsh）；上游 npm 已发布 0.1.0-rc.8；npm 命令可用且网络正常。
[测试步骤] 1. 在「核心」管理面板点击「更新本地核心」。2. 观察返回版本号与本地 package.json 版本。
[预期结果] 1. 更新命令成功，无错误提示。2. 返回版本号 0.1.0-rc.8，本地 @deepseek-ai/dsh 安装目录 version 更新为 0.1.0-rc.8，面板展示新版本号。

## [P4] 验证 npm 布局与 pnpm 布局分别走对应包管理器命令
[测试类型] 功能
[前置条件] 分两轮：a) npm 布局（<prefix>/node_modules/@deepseek-ai/dsh 存在，bin 与 node_modules 同前缀）；b) pnpm 布局（bin 位于 %LOCALAPPDATA%\pnpm，包位于 <prefix>/global/<n>/node_modules/@deepseek-ai/dsh）。
[测试步骤] 1. 在 npm 布局下点击「更新本地核心」，检查实际执行的包管理器与参数。2. 在 pnpm 布局下点击「更新本地核心」，检查实际执行的包管理器与参数。
[预期结果] 1. npm 布局执行 npm install -g @deepseek-ai/dsh@latest（日志可见）。2. pnpm 布局执行 pnpm add -g @deepseek-ai/dsh@latest（日志可见）。

## [P3][反向] 验证更新失败返回命令输出尾部便于排查
[测试类型] 功能
[前置条件] 本地以 npm 布局安装 dsh 0.1.0-rc.7；npm 命令返回非 0（如网络异常或权限不足导致 install -g 失败）。
[测试步骤] 1. 使 `npm install -g @deepseek-ai/dsh@latest` 以非 0 退出（断网或权限不足）。2. 点击「更新本地核心」。3. 观察错误信息内容。
[预期结果] 1. 更新命令失败条件已就绪。2. 更新报错。3. 返回错误 CORE_UPDATE_FAILED，其后附 stdout/stderr 合并后去空行的末尾 12 行输出，便于定位具体原因。

## [P3][反向] 验证无本地核心时提示 CORE_LOCAL_NOT_FOUND
[测试类型] 功能
[前置条件] 本地未安装 dsh（local_core 返回 None，PATH 无命中且无包目录）。
[测试步骤] 1. 在「核心」管理面板点击「更新本地核心」。2. 观察返回结果。
[预期结果] 1. 不派生子进程，不触发 npm/pnpm 命令。2. 返回错误 CORE_LOCAL_NOT_FOUND: no local core to update。

## [P4] 验证更新成功但回读版本号为空时给出警告且流程可继续
[测试类型] 功能
[前置条件] 本地已安装 dsh；更新命令以 status 成功返回，但更新后 read_package_version 返回 None（package.json 缺失或 version 字段损坏）。
[测试步骤] 1. 使更新成功但回读版本为空（如删除/损坏 package.json 的 version 字段）。2. 点击「更新本地核心」。3. 观察返回版本号与日志。
[预期结果] 1. 更新命令返回 0。2. 更新流程不报错、正常结束。3. 返回空字符串版本号，日志出现警告「Local core updated but version could not be re-read」。


---

# 进程生命周期与健康检查

## 服务启动

## [P1] 验证点击启动后按 web 档案与 3080 端口拉起服务并进入 Running
[测试类型] 功能
[前置条件] 当前为 release 构建（默认端口 3080）；依赖已安装（store installed=true）；激活档案为 web；服务未运行
[测试步骤] 1. 点击界面「启动」，触发 launch_harness。2. 查看 dsh 服务进程的完整命令行参数。3. 轮询 get_dsh_status 并访问 http://127.0.0.1:3080/
[预期结果] 1. 状态由 Starting 转为 Running。2. 进程命令行包含 node.exe dependencies/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web --host 127.0.0.1 --port 3080，且因活动版本≥0.1.0-rc.8 追加 --no-open。3. get_dsh_status 返回 Running，http://127.0.0.1:3080/ 返回 HTTP 200

## [P1] 验证服务使用当前激活档案启动而非固定写死 web
[测试类型] 功能
[前置条件] release 构建；已创建档案 beta 且目录存在；把激活档案切换为 beta；服务未运行；依赖已安装
[测试步骤] 1. 在「档案」面板把激活档案切换为 beta，确认 set_active_profile 返回的 active 为 beta。2. 点击「启动」。3. 查看服务进程命令行与 $DSH_HOME/profiles 下的目录
[预期结果] 1. 激活档案持久化为 beta。2. 状态进入 Starting 后转为 Running。3. 进程命令行含 --profile beta（而非 --profile web），服务以 $DSH_HOME/profiles/beta 为工作档案，dsh-web.log 无固定 web 关键字

## [P2] 验证服务使用当前活动核心的 bin.js 入口启动
[测试类型] 功能
[前置条件] 本机 PATH 命中 dsh（本地核心存在，lib/bin.js 可解析）；active_core 未显式设置（自动=本地优先）；依赖已安装；服务未运行
[测试步骤] 1. 确认活动核心来源 core::active_source 为 local。2. 点击「启动」。3. 对比服务进程命令行首参（bin.js）与本地核心路径
[预期结果] 1. 活动核心来源为 local（本地优先）。2. 状态进入 Running。3. 进程命令行首参为本地核心包目录下 lib/bin.js 的绝对路径，而非预打包 dependencies/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js

## [P2] 验证依赖未就绪时点击启动会先自动完成安装再启动服务
[测试类型] 功能
[前置条件] 全新安装，store installed=false；网络可访问 GitHub；服务未运行
[测试步骤] 1. 点击「启动」。2. 观察状态变化与依赖安装（Node.js v22.22.0/dsh/pnpm 11.7.0 下载与解压）。3. 安装完成后观察服务拉起
[预期结果] 1. 状态先进入 Installing（触发 install_dependencies 安装三件套）。2. 三件套下载解压完成，installed 置为 true，install_dependencies 返回且日志提示安装完成。3. 状态转 Starting 后进入 Running，服务按 --profile web --port 3080 拉起

## [P3][反向] 验证端口 3080 已被占用时服务自动顺延而不崩溃
[测试类型] 功能
[前置条件] release 构建（默认端口 3080）；先用另一进程在 127.0.0.1:3080 建立监听；依赖已安装；服务未运行
[测试步骤] 1. 在 127.0.0.1:3080 启动一个监听进程（例如 python -m http.server 3080）。2. 点击「启动」。3. 观察端口选择、进程命令行与最终状态
[预期结果] 1. 外部监听进程占用 3080 且不被结束。2. 日志提示 Port 3080 is occupied, trying the next port，进程以 --port 3081 拉起并持久化 setting.port=3081。3. 应用不崩溃，状态进入 Running，访问 http://127.0.0.1:3081/ 返回 HTTP 200

## [P4] 验证 Windows 下服务进程无可见窗口
[测试类型] 兼容性
[前置条件] Windows 构建；依赖已安装；服务未运行
[测试步骤] 1. 点击「启动」。2. 枚举 dsh 服务根进程及其派生子进程，检查其控制台窗口是否可见。3. 运行期间观测是否有弹窗
[预期结果] 1. 服务根进程通过隐藏控制台方式启动（STARTF_USESHOWWINDOW + SW_HIDE）。2. 根进程与派生的 cmd/node/git 子进程的控制台窗口 IsWindowVisible 均为 False。3. 运行期间无可见 cmd 黑窗弹出，服务进入 Running，http://127.0.0.1:3080/ 返回 HTTP 200


## 服务停止与重启

## [P1] 验证停止服务后状态进入 Stopped 且端口释放
[测试类型] 功能
[前置条件] 服务正在 Running（端口 3080）；依赖已安装
[测试步骤] 1. 点击「停止」，触发 shutdown_harness。2. 观察状态变化。3. 检查 3080 端口监听与 .harness.pid 标记文件
[预期结果] 1. 状态转为 Stopped 并推送 dsh-status-updated=Stopped。2. 停止约 800ms 后 3080 端口已释放（netstat 无 LISTENING）。3. .harness.pid 标记文件被删除，dsh 服务根进程已退出

## [P1] 验证重启服务成功并重新进入 Running
[测试类型] 功能
[前置条件] 服务正在 Running（端口 3080）；依赖已安装
[测试步骤] 1. 点击「重启」，触发 restart_harness。2. 观察状态流转与进程 PID 变化。3. 访问 http://127.0.0.1:3080/ 并调用 get_dsh_status
[预期结果] 1. 状态先转 Stopped 再转 Starting，最终进入 Running。2. 旧的 dsh 服务进程树被结束，重建新的 dsh 服务进程（新 PID 写入新的 .harness.pid）。3. http://127.0.0.1:3080/ 返回 HTTP 200，get_dsh_status 返回 Running

## [P2] 验证停止时 Windows 杀掉整个进程树并释放 DLL 句柄
[测试类型] 兼容性
[前置条件] Windows 构建；服务 Running；dsh 根进程已派生子进程；dependencies 目录可能被 DLL 锁定
[测试步骤] 1. 点击「停止」。2. 检查 dsh 根进程及其全部子进程是否都已结束。3. 尝试重命名 dependencies/dsh 目录并检查是否出现 os error 32
[预期结果] 1. kill_pid_tree 以 taskkill /PID <pid> /T /F 结束根进程及其全部子进程。2. 不再有以 dependencies/dsh 路径为命令行的 node 进程。3. dependencies/dsh 目录可成功改名，无 os error 32（DLL 锁已释放）

## [P2] 验证停止后再次启动可用
[测试类型] 功能
[前置条件] 服务已停止（Stopped），3080 端口已释放；依赖已安装
[测试步骤] 1. 再次点击「启动」。2. 观察状态变化。3. 检查服务进程命令行与端口
[预期结果] 1. 状态由 Stopped 转为 Starting 后进入 Running。2. 新 dsh 进程以 --profile web --port 3080 拉起，创建新的 .harness.pid。3. http://127.0.0.1:3080/ 返回 HTTP 200

## [P3][反向] 验证应用被强杀后残留孤儿进程可在下次启动前被清扫
[测试类型] 功能
[前置条件] 服务 Running（端口 3080）；依赖已安装；.harness.pid 记录当前 PID+端口
[测试步骤] 1. 用任务管理器强杀应用主进程（跳过退出清理），保留 dsh 子进程占用 3080。2. 重新启动应用。3. 观察启动前清扫与端口选择
[预期结果] 1. 启动时 sweep_orphan_harness 依据 .harness.pid 的 PID+端口双重确认，识别并结束残留在 3080 的 dsh 进程树。2. 清理后服务仍以默认 3080 起步（端口未漂移到 3081），未提示 already running。3. 应用正常进入 Running，无孤儿 dsh 进程残留


## 状态流转与健康检查

## [P1] 验证状态按 Initial/Installing/Starting/Running/Stopped 正确流转并推送事件
[测试类型] 功能
[前置条件] 全新安装，store installed=false；前端已监听 dsh-status-updated；服务未运行
[测试步骤] 1. 启动应用并读取初始状态。2. 触发依赖安装 install_dependencies。3. 安装完成后点击「启动」。4. 等待 Running 后点击「停止」
[预期结果] 1. get_dsh_status 返回 Initial。2. 安装阶段推送 dsh-status-updated=Installing。3. 启动后状态经 Starting 进入 Running。4. 停止后推送 dsh-status-updated=Stopped；每次状态变更都推送对应事件

## [P2] 验证服务重新拉起后健康检查将状态恢复为 Running
[测试类型] 功能
[前置条件] 服务曾 Running 后异常退出（当前未运行）；依赖已安装；健康检查每 1 秒轮询
[测试步骤] 1. 再次点击「启动」。2. 等待健康检查轮询（≥2 秒）。3. 调用 get_dsh_status
[预期结果] 1. 状态先转 Starting（重新拉起 dsh 进程）。2. tick_check_dsh_process 探测 http://127.0.0.1:3080/ 返回 HTTP 200。3. get_dsh_status 自动由 Starting 转为 Running，并推送 dsh-status-updated=Running

## [P3][反向] 验证服务进程异常退出后被健康检查识别
[测试类型] 功能
[前置条件] 服务 Running（端口 3080）；健康检查每 1 秒轮询
[测试步骤] 1. 用 taskkill /PID <dsh-pid> /T /F 强杀 dsh 服务进程树。2. 等待 2 秒（≥2 个轮询周期）。3. 检查 get_dsh_status、owned 进程判定与端口
[预期结果] 1. watcher 线程记录日志 Owned Harness process <pid> exited with code <code>，OWNED_PROCESS_ID 清空。2. has_owned_process() 返回 false，健康检查不再将 http://127.0.0.1:3080/ 视为 Harness。3. http://127.0.0.1:3080/ 请求连接失败（连接拒绝），端口无监听

## [P4] 验证健康检查按 1 秒周期轮询
[测试类型] 功能
[前置条件] 服务 Running（端口 3080）；可读取 scheduler 日志或对端口采样
[测试步骤] 1. 记录当前时刻。2. 连续 10 秒对 http://127.0.0.1:3080/ 采样并观察轮询日志。3. 统计探测次数
[预期结果] 1. scheduler 以 time::interval(Duration::from_secs(1)) 每 1 秒触发一次 tick_check_dsh_process。2. 10 秒内触发约 10 次（允许定时器抖动 ±1 次）。3. 每次探测通过 reqwest 访问 / 并校验 HTTP 200（is_dsh_running 请求超时 2 秒）

## [P5] 验证状态事件在多个窗口正确广播
[测试类型] 功能
[前置条件] 打开两个桌面端窗口 A、B，均监听 dsh-status-updated
[测试步骤] 1. 两个窗口同时订阅 status 事件。2. 在窗口 A 触发「启动」后触发「停止」。3. 对比两窗口收到的事件与 get_dsh_status
[预期结果] 1. 窗口 A、B 均收到 dsh-status-updated 事件。2. 事件载荷为同一序列化状态（Running/Stopped），两窗口事件一致。3. 两窗口调用 get_dsh_status 返回一致状态


---

# 应用配置中心

## 配置对话框与管理

## [P1] 验证打开配置对话框正确展示四个分页
[测试类型] 功能
[前置条件] 应用已启动，进入桌面端主界面
[测试步骤] 1. 点击主界面「配置」入口打开配置对话框。2. 依次查看「调试」「档案」「插件」「核心」四个分页
[预期结果] 1. 配置对话框正常打开，标题为「应用配置」。2. 显示「调试」「档案」「插件」「核心」四个分页标签，且默认选中「调试」分页

## [P1] 验证点击保存后 update_app_config 写入配置并返回最新值
[测试类型] 功能
[前置条件] 配置对话框打开，调试分页端口为默认值（release 3080 / debug 3081）
[测试步骤] 1. 在「调试」分页将端口修改为 3090。2. 点击「保存」按钮。3. 核对 update_app_config 返回的配置
[预期结果] 1. 保存成功且无报错。2. store 文件中 "setting" 键的 JSON 中 port 变为 3090。3. update_app_config 返回的配置 port=3090，其余字段保持原值不变

## [P3][反向] 验证端口输入非数字被拒绝并提示
[测试类型] 功能
[前置条件] 配置对话框打开，当前端口为 3080
[测试步骤] 1. 将端口输入框内容修改为非数字文本「abc」。2. 点击「保存」按钮。3. 检查 store 配置
[预期结果] 1. 保存被拒绝，界面提示端口格式无效（非数字）。2. store 中 port 保持 3080，配置未被改写。3. update_app_config 返回错误而不返回最新配置

## [P3][反向] 验证端口设置为 0 被拒绝并提示
[测试类型] 功能
[前置条件] 配置对话框打开，当前端口为 3080
[测试步骤] 1. 将端口输入框内容修改为 0。2. 点击「保存」按钮
[预期结果] 1. 保存被拒绝，界面提示「端口必须为正数」（port must be a positive number）。2. store 中 port 保持 3080，配置未被改写

## [P5] 验证分页之间切换不丢失未保存的修改
[测试类型] 易用性
[前置条件] 配置对话框打开
[测试步骤] 1. 在「调试」分页将端口修改为 3090 但不点击保存。2. 切换到「档案」分页后再切回「调试」分页。3. 查看端口输入框内容
[预期结果] 1. 切换分页时未触发保存，store 中 port 保持 3080。2. 切回「调试」分页后端口输入框仍显示 3090。3. 未保存的修改被保留，未被重置为默认值 3080


## 语言与主题

## [P1] 验证切换语言为 en 后界面文案即时变为英文
[测试类型] 功能
[前置条件] 应用运行，当前界面语言为 zh-CN（中文）
[测试步骤] 1. 打开配置对话框，将语言切换为 en。2. 观察主界面与配置对话框文案。3. 检查 store 配置
[预期结果] 1. 界面所有可见文案即时变为英文，无需重启。2. store 中 "setting" 的 language 字段变为 "en"。3. 配置对话框语言选择项显示为 en

## [P1] 验证切换语言为 zh-CN 后界面文案恢复中文
[测试类型] 功能
[前置条件] 当前界面语言为 en（英文）
[测试步骤] 1. 将语言切换为 zh-CN。2. 观察界面文案。3. 检查 store 配置
[预期结果] 1. 界面文案即时恢复为中文。2. store 中 "setting" 的 language 字段变为 "zh-CN"。3. 配置对话框语言选择项显示为 zh-CN

## [P2] 验证刷新/重启后语言设置保持
[测试类型] 稳定性
[前置条件] 已通过配置将语言设置为 en 并保存
[测试步骤] 1. 退出并重新启动应用（或刷新界面）。2. 观察界面语言。3. 检查 store 配置
[预期结果] 1. 重启后界面默认加载为英文。2. store 中 language 字段仍为 "en"。3. 无需重新设置语言

## [P1] 验证切换主题为暗色后界面配色实时更新
[测试类型] 功能
[前置条件] `$DSH_HOME/settings.yaml` 中 ui-theme.preference 为 light，界面当前为浅色
[测试步骤] 1. 将 settings.yaml 中 ui-theme.preference 修改为 dark。2. 重启应用使主题偏好重新加载。3. 调用 get_dsh_theme 并观察界面
[预期结果] 1. get_dsh_theme 返回 Dark。2. 界面配色由浅色实时更新为暗色。3. 触发 dsh-theme-updated 事件

## [P2] 验证跟随系统主题时随系统变化
[测试类型] 兼容性
[前置条件] settings.yaml 中 ui-theme.preference 为 system，系统外观为浅色
[测试步骤] 1. 将操作系统外观由浅色切换为深色。2. 调用 get_dsh_theme 并观察界面
[预期结果] 1. get_dsh_theme 返回 System。2. 界面跟随系统切换为深色（触发 dsh-theme-updated 事件）

## [P4][反向] 验证主题值为未知时回退默认
[测试类型] 可靠性
[前置条件] 将 `$DSH_HOME/settings.yaml` 中 ui-theme.preference 修改为非法值「blue」
[测试步骤] 1. 将 settings.yaml 中 ui-theme.preference 改为「blue」。2. 调用 get_dsh_theme 并观察界面
[预期结果] 1. get_dsh_theme 返回 Dark（默认主题）。2. 界面以暗色显示，应用不崩溃


## 侧边栏与偏好设置

## [P2] 验证切换侧边栏开关生效
[测试类型] 易用性
[前置条件] 应用运行，侧边栏当前为展开状态
[测试步骤] 1. 点击侧边栏开关调用 toggle_sidebar。2. 观察侧边栏显示状态
[预期结果] 1. toggle_sidebar 返回 true。2. 侧边栏由展开变为收起，布局视图相应更新

## [P2] 验证 auto_start 开启后启动应用自动拉起服务
[测试类型] 功能
[前置条件] 配置中 auto_start 设为 true 并已保存，服务当前为停止状态
[测试步骤] 1. 退出应用后重新启动。2. 观察 Harness 服务是否自动启动
[预期结果] 1. 应用启动后自动拉起 Harness 服务并从 Stopped 变为 Running。2. 服务监听配置端口，无需手动点击启动按钮

## [P2] 验证 auto_start 关闭后启动应用不自动拉起服务
[测试类型] 功能
[前置条件] 配置中 auto_start 设为 false 并已保存，服务当前为停止状态
[测试步骤] 1. 退出应用后重新启动。2. 观察 Harness 服务状态
[预期结果] 1. 应用启动后服务保持 Stopped，不自动拉起。2. 需手动点击「启动」按钮才能拉起服务

## [P3] 验证启用 cli_link_enabled 后 dsh 命令链接生效
[测试类型] 功能
[前置条件] 配置中 cli_link_enabled 当前为 false，`dsh` 命令不可用
[测试步骤] 1. 将 cli_link_enabled 设为 true 并保存。2. 打开新终端执行 dsh 命令。3. 检查状态
[预期结果] 1. 保存后触发 cli::ensure，生成 shim 并注册 PATH。2. 命令行 `dsh` 命令可正常执行。3. store 中 cli_link_enabled 为 true

## [P3][反向] 验证停用 cli_link_enabled 后 dsh 命令链接失效
[测试类型] 功能
[前置条件] 配置中 cli_link_enabled 当前为 true，`dsh` 命令可用
[测试步骤] 1. 将 cli_link_enabled 设为 false 并保存。2. 打开新终端执行 dsh 命令。3. 检查 store 中 cli_link_enabled 值
[预期结果] 1. 保存后触发 cli::remove，移除 shim 并注销 PATH。2. 命令行 `dsh` 命令不可用。3. store 中 cli_link_enabled 为 false


## 设置持久化

## [P1] 验证保存设置后 store 写入对应键值并触发 setting_updated 事件
[测试类型] 功能
[前置条件] 应用运行，store 文件已加载（.store.dat 或 .store.dev.dat）
[测试步骤] 1. 打开配置对话框，将「自动启动」开关关闭（auto_start=false）并保存。2. 监听 setting_updated 事件。3. 检查 store 文件中 "setting" 键
[预期结果] 1. store 文件 "setting" 键写入包含 auto_start=false 的 JSON。2. 触发 setting_updated 事件，事件载荷为更新后的完整设置。3. 界面无需刷新即可读到最新设置

## [P1] 验证重启应用后已保存设置仍在
[测试类型] 稳定性
[前置条件] 已通过配置将语言设置为 en 并保存
[测试步骤] 1. 退出应用。2. 重新启动应用并打开配置对话框。3. 检查语言设置
[预期结果] 1. 重启后语言仍为 en。2. store 中 setting.language 为 "en"。3. 无需重新设置语言

## [P2] 验证 active_profile 与 active_core 持久化并在下次启动生效
[测试类型] 功能
[前置条件] 存在档案 web 与核心 app，服务当前为停止状态
[测试步骤] 1. 将 active_profile 设为 "web"、active_core 设为 "app" 并保存。2. 重启应用。3. 观察服务启动参数与档案列表
[预期结果] 1. 重启后 store 中 active_profile="web"、active_core="app"。2. 服务以 --profile web 启动。3. 插件管理与档案列表均以 web 档案为准

## [P3][反向] 验证 store 文件损坏时回退默认设置不崩溃
[测试类型] 可靠性
[前置条件] 将 store 文件 "setting" 键的值修改为不符合 Setting 结构的内容（如 {"port": "abc"}）
[测试步骤] 1. 将 store 文件中 "setting" 键的值改为非法内容。2. 启动应用并调用 get_app_config。3. 观察应用状态
[预期结果] 1. 应用正常启动，不崩溃。2. get_app_config 返回默认设置（port=默认端口 3080/3081，language="zh-CN"，active_profile="web"）。3. 不抛出异常错误

## [P2] 验证修改端口后服务下次启动使用新端口
[测试类型] 功能
[前置条件] 服务为停止状态，当前端口为默认值 3080/3081
[测试步骤] 1. 将端口修改为 3090 并保存。2. 启动服务。3. 访问 http://127.0.0.1:3090
[预期结果] 1. 服务以 --port 3090 启动。2. 在 http://127.0.0.1:3090 可访问 Harness 界面。3. 原端口 3080 不再监听


---

# 档案隔离管理

## 档案列表与展示

> 测试点：档案列表与展示（`get_profiles`）。档案 = `$DSH_HOME/profiles/<id>`，列表含 default/active 标记；默认档案 web 置顶、其余按 id 字典序稳定排序；未初始化或空目录时回退补一个 web 默认行。

## [P1] 验证列表包含默认档案 web 并标记 default 与 active
[测试类型] 功能
[前置条件] 当前使用档案为 web；已存在档案 beta 与 gamma
[测试步骤] 1. 调用 get_profiles 获取档案列表
[预期结果] 1. 列表包含 id=web、name=Web 的档案且其 default=true、active=true，同时 beta 与 gamma 的 default=false、active=false

## [P2] 验证全新机器 profiles 未初始化时仍展示默认档案 web
[测试类型] 功能
[前置条件] 全新机器，$DSH_HOME/profiles 目录不存在或为空；store 中 active_profile 为默认值 web
[测试步骤] 1. 调用 get_profiles 获取档案列表
[预期结果] 1. 列表仍返回 id=web、name=Web、default=true、active=true 的默认档案，而非空列表

## [P2] 验证新建多个档案后均出现在列表且展示名去除 dsh-profile- 前缀
[测试类型] 功能
[前置条件] $DSH_HOME/profiles 目录初始为空
[测试步骤] 1. 调用 create_profile 分别创建 beta 与 gamma
[预期结果] 1. 列表同时包含 id=beta（name=Beta）与 id=gamma（name=Gamma），展示名已去除 dsh-profile- 前缀并以首字母大写显示

## [P2] 验证档案目录无 package.json 时展示名回落为 id 首字母大写
[测试类型] 功能
[前置条件] $DSH_HOME/profiles 下已存在 beta 目录但其中没有 package.json
[测试步骤] 1. 在 $DSH_HOME/profiles 下手动创建 beta 目录且不写入 package.json。2. 调用 get_profiles 获取档案列表
[预期结果] 1. beta 目录创建成功且不含 package.json。2. 列表 id=beta 的 name= Beta，即回落为原始 id 并首字母大写

## [P4] 验证默认档案 web 置顶且其余档案按 id 字典序稳定排序
[测试类型] 功能
[前置条件] 已创建档案 beta、alpha、gamma，均已完成初始化且不存在 node_modules 或隐藏干扰目录
[测试步骤] 1. 调用 get_profiles 获取档案列表
[预期结果] 1. 列表顺序为 web、alpha、beta、gamma，即默认档案 web 置顶，其余档案按 id 字典序稳定升序排列


## 新建档案

> 测试点：新建档案（`create_profile`）。合法名称创建成功并按官方 `initProfile` 形态初始化；名称规范化（小写、非字母数字转 `-`、连续分隔符合并、去首尾 `-`）；空名/纯无效字符/超 64 字符/保留名 web/重名被拒；重复初始化幂等。

## [P1] 验证合法名称创建档案成功并初始化官方形态文件
[测试类型] 功能
[前置条件] $DSH_HOME/profiles 目录初始为空
[测试步骤] 1. 调用 create_profile 传入名称 beta
[预期结果] 1. 创建成功返回 id=beta、default=false、active=false；$DSH_HOME/profiles/beta 下生成 package.json、cordis.patch.yml、pnpm-workspace.yaml 三个文件，package.json 的 name 为 dsh-profile-beta、dsh.profile.bundles 含 @deepseek-ai/dsh-base 与 @deepseek-ai/dsh-web-app，.npmrc 含 confirmModulesPurge=false

## [P2] 验证名称自动规范化为合法档案 id
[测试类型] 功能
[前置条件] $DSH_HOME/profiles 目录初始为空
[测试步骤] 1. 调用 create_profile 传入名称 My Work Space
[预期结果] 1. 创建成功返回 id=my-work-space；档案目录为 $DSH_HOME/profiles/my-work-space，package.json 的 name 为 dsh-profile-my-work-space

## [P2] 验证档案目录重复初始化幂等且不覆盖已有文件
[测试类型] 可靠性
[前置条件] 已存在档案 beta，且已由 create_profile 完成初始化
[测试步骤] 1. 手工修改 beta/cordis.patch.yml 追加一行自定义补丁内容。2. 手工修改 beta/.npmrc 追加一行自定义配置 keep=true。3. 切换到 beta 并重启 Harness 服务，使服务启动对已存在档案按需 initProfile
[预期结果] 1. beta/cordis.patch.yml 仍保留自定义补丁内容，未被覆盖。2. beta/.npmrc 保留 keep=true 且 confirmModulesPurge=false 仅出现一次，无重复追加行。3. 服务正常启动，档案数据完整无误

## [P3][反向] 验证空名称与纯无效字符名称均被拒绝
[测试类型] 功能
[前置条件] $DSH_HOME/profiles 目录初始为空
[测试步骤] 1. 调用 create_profile 传入空字符串。2. 调用 create_profile 传入纯中文名称 中文档案
[预期结果] 1. 返回 PROFILE_EMPTY_NAME，未创建任何档案目录。2. 返回 PROFILE_INVALID_NAME，未创建任何档案目录

## [P3][反向] 验证名称规范化后长度超过 64 字符被拒绝
[测试类型] 功能
[前置条件] $DSH_HOME/profiles 目录初始为空
[测试步骤] 1. 调用 create_profile 传入由 65 个小写字母 a 组成的名称 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa（规范化后仍为 65 个字符）
[预期结果] 1. 返回 PROFILE_NAME_TOO_LONG，未创建任何档案目录

## [P3][反向] 验证保留名称 web 与已存在名称均被拒绝
[测试类型] 功能
[前置条件] $DSH_HOME/profiles 目录初始为空
[测试步骤] 1. 调用 create_profile 传入名称 web。2. 调用 create_profile 传入名称 beta，随后再次调用 create_profile 传入名称 beta
[预期结果] 1. 返回 PROFILE_RESERVED，未创建任何档案目录。2. 第一次创建 beta 成功；第二次创建 beta 返回 PROFILE_EXISTS，已存在 beta 目录内容不受影响


## 切换档案

> 测试点：切换档案（`set_active_profile`）。切换到已存在档案成功并持久化 active_profile；切换到不存在档案报 PROFILE_NOT_FOUND；切换后服务按新档案启动；切换回默认 web 成功；切换后列表 active 标记正确更新。

## [P1] 验证切换到已存在档案成功并持久化 active_profile
[测试类型] 功能
[前置条件] 当前档案为 web；已存在档案 beta
[测试步骤] 1. 调用 set_active_profile 传入 beta
[预期结果] 1. 调用成功返回 id=beta、active=true；store 中 active_profile 更新为 beta

## [P1] 验证切换后重启服务使用新档案作为 profile
[测试类型] 功能
[前置条件] 当前档案为 web；已存在档案 beta
[测试步骤] 1. 调用 set_active_profile 传入 beta。2. 重启 Harness 服务
[预期结果] 1. 切换成功，store 中 active_profile=beta。2. 服务以 dsh --profile beta 启动，服务进程参数与运行状态均基于 beta 档案

## [P2] 验证切换回默认档案 web 成功
[测试类型] 功能
[前置条件] 当前档案为 beta；默认档案 web 存在
[测试步骤] 1. 调用 set_active_profile 传入 web
[预期结果] 1. 调用成功返回 id=web、default=true、active=true；store 中 active_profile 更新为 web

## [P2] 验证切换后列表 active 标记正确更新
[测试类型] 功能
[前置条件] 当前档案为 web；已存在档案 beta 与 gamma
[测试步骤] 1. 调用 set_active_profile 传入 gamma。2. 调用 get_profiles 获取列表
[预期结果] 1. 切换成功，store 中 active_profile=gamma。2. 列表中 gamma 的 active=true，而 web 与 beta 的 active=false；web 的 default 标记仍为 true

## [P3][反向] 验证切换到不存在的档案被拒绝
[测试类型] 功能
[前置条件] 当前档案为 web；$DSH_HOME/profiles 下不存在 notexist
[测试步骤] 1. 调用 set_active_profile 传入 notexist
[预期结果] 1. 返回 PROFILE_NOT_FOUND，store 中 active_profile 保持原值 web，不发生任何变更


## 删除档案

> 测试点：删除档案（`remove_profile`）。删除非默认且非使用中的档案成功并移除目录；删除默认档案 web 被拒；删除当前使用中档案被拒；删除不存在档案报错；删除后列表不再显示。

## [P1] 验证删除非默认且非使用中的档案成功并移除目录
[测试类型] 功能
[前置条件] 当前档案为 web；已存在档案 beta 与 gamma
[测试步骤] 1. 调用 remove_profile 传入 beta
[预期结果] 1. 调用成功未报错；$DSH_HOME/profiles/beta 目录被完整移除，磁盘上不再存在该目录

## [P2] 验证删除后列表不再显示该档案
[测试类型] 功能
[前置条件] 当前档案为 web；已存在档案 beta 与 gamma
[测试步骤] 1. 调用 remove_profile 传入 beta。2. 调用 get_profiles 获取列表
[预期结果] 1. 删除成功。2. 列表中不再包含 id=beta，同时仍包含 web 与 gamma

## [P3][反向] 验证删除默认档案 web 被拒绝
[测试类型] 功能
[前置条件] 当前档案为 web
[测试步骤] 1. 调用 remove_profile 传入 web
[预期结果] 1. 返回 PROFILE_DEFAULT_NOT_REMOVABLE；$DSH_HOME/profiles/web 目录仍存在，未被删除

## [P3][反向] 验证删除当前使用中的档案被拒绝
[测试类型] 功能
[前置条件] 当前档案为 beta；已存在档案 beta 与 gamma
[测试步骤] 1. 调用 remove_profile 传入 beta
[预期结果] 1. 返回 PROFILE_ACTIVE_NOT_REMOVABLE；$DSH_HOME/profiles/beta 目录仍存在，未被删除

## [P3][反向] 验证删除不存在的档案报 PROFILE_NOT_FOUND
[测试类型] 功能
[前置条件] 当前档案为 web；$DSH_HOME/profiles 下不存在 notexist
[测试步骤] 1. 调用 remove_profile 传入 notexist
[预期结果] 1. 返回 PROFILE_NOT_FOUND，未发生任何删除操作


## 档案隔离性

> 测试点：档案隔离性。不同档案的插件、补丁与设置各自独立；切换档案后服务以新档案启动且旧档案数据保留；对档案 A 的修改不影响档案 B；删除档案 A 不影响其他档案。

## [P1] 验证不同档案安装的插件互不影响
[测试类型] 功能
[前置条件] 当前档案为 web；已存在档案 beta 与 gamma
[测试步骤] 1. 对 beta 执行 dsh plugin add 安装插件 plugin-a。2. 对 gamma 执行 dsh plugin add 安装插件 plugin-b。3. 分别查询 beta 与 gamma 的插件列表
[预期结果] 1. beta 安装 plugin-a 成功。2. gamma 安装 plugin-b 成功。3. beta 的插件列表只含 plugin-a，gamma 的插件列表只含 plugin-b，互不混入

## [P1] 验证不同档案的补丁设定各自独立
[测试类型] 功能
[前置条件] 已存在档案 beta 与 gamma，各自拥有独立的 cordis.patch.yml 与设置
[测试步骤] 1. 在 beta/cordis.patch.yml 写入补丁项 A。2. 在 gamma/cordis.patch.yml 写入补丁项 B。3. 分别读取 beta 与 gamma 的 cordis.patch.yml
[预期结果] 1. beta 的补丁内容含 A。2. gamma 的补丁内容含 B。3. beta 不含 B，gamma 不含 A，两者补丁互不串扰

## [P1] 验证切换档案后服务以新档案启动且旧档案数据完整保留
[测试类型] 功能
[前置条件] 当前档案为 web；已存在档案 beta，beta 已安装插件并写入自定义设置
[测试步骤] 1. 记录 beta 现有插件清单与设置内容。2. 调用 set_active_profile 传入 beta 并重启 Harness 服务。3. 核对服务进程参数与 beta 的数据完整性
[预期结果] 1. 已记录 beta 的插件清单与设置。2. 服务以 dsh --profile beta 启动并正常运行。3. beta 的插件与设置完整保留并作为当前档案生效，同时 web 档案数据未受影响

## [P2] 验证对档案 A 的修改不影响档案 B
[测试类型] 功能
[前置条件] 已存在档案 beta 与 gamma，两者均处于未修改状态
[测试步骤] 1. 在 beta 上修改设置并新增插件。2. 检查 gamma 的设置内容与插件列表
[预期结果] 1. beta 的修改与新增插件生效。2. gamma 的设置与插件列表保持修改前一致，未受到 beta 修改影响

## [P2] 验证删除档案 A 不影响其他档案
[测试类型] 功能
[前置条件] 当前档案为 web；已存在档案 beta 与 gamma
[测试步骤] 1. 调用 remove_profile 传入 beta。2. 调用 get_profiles 并检查 gamma 的数据与可用性
[预期结果] 1. beta 目录被删除。2. 列表仍含 gamma 与 web，gamma 的插件与设置未受影响，仍可正常使用


---

# 插件管理

## 已安装插件列表与监控

## [P1] 验证已安装插件列表只读且正确展示

[测试类型] 功能
[前置条件] 桌面应用已启动；当前档案为 web；profile 已安装 dshmarket、dsh-tauri 两个插件
[测试步骤] 1. 打开「插件管理」页面，调用 get_dsh_plugins 读取已安装插件列表。2. 检查列表是否存在新增或重命名插件名的编辑入口。3. 核对列表项数量与 profile 直接依赖是否一致
[预期结果] 1. 列表只读展示 dshmarket、dsh-tauri 两项。2. 列表无新增或重命名插件的编辑控件，仅提供升级、卸载、打开仓库操作。3. 列表项与 $DSH_HOME/profiles/web/package.json 的 dependencies 直接依赖一致，不展示 node_modules 中的传递依赖（如 clsx、zod）

## [P1] 验证列表展示插件名与版本等关键信息

[测试类型] 功能
[前置条件] 已安装 dshmarket（版本 1.13.1）与 dsh-tauri；dshmarket 位于 dsh.profile.bundles 列表
[测试步骤] 1. 打开插件管理页，查看 dshmarket、dsh-tauri 两项的展示信息。2. 检查 dshmarket 的推荐标记与启动加载状态。3. 核对 dshmarket 版本号与 node_modules/dshmarket/package.json 的 version 字段
[预期结果] 1. 两项均展示插件名与版本号，dshmarket 展示为「DSH Market」且版本为 1.13.1。2. dshmarket 显示推荐标记（绿色 chip）且 bundled 为 true。3. dshmarket 版本与 $DSH_HOME/profiles/web/node_modules/dshmarket/package.json 的 version 字段（1.13.1）一致

## [P2] 验证插件文件变化后轮询检测并推送 dsh-plugins-updated 事件

[测试类型] 功能
[前置条件] 桌面应用运行中；插件管理页已打开；当前仅安装 dshmarket
[测试步骤] 1. 记录当前列表，并监听 dsh-plugins-updated 事件。2. 在 $DSH_HOME/profiles/web/package.json 的 dependencies 中新增 dsh-tauri（模拟外部安装并写盘）。3. 等待 2 秒防抖窗口与下一次秒级轮询
[预期结果] 1. 列表当前展示 dshmarket 项，事件监听就绪。2. 指纹变化被检测到，dsh-plugins-updated 事件被推送一次，列表新增 dsh-tauri 项。3. 防抖窗口内连续写盘只推送一次最终状态，界面无事件风暴

## [P2] 验证插件被移除后列表能反应

[测试类型] 功能
[前置条件] 已安装 dshmarket、dsh-tauri；插件管理页已打开
[测试步骤] 1. 记录当前列表。2. 调用 remove_dsh_plugin 卸载 dsh-tauri。3. 等待 dsh-plugins-updated 事件推送后刷新列表
[预期结果] 1. 当前列表展示 dshmarket、dsh-tauri 两项。2. dsh-tauri 从 profile 的 dependencies 与 dsh.profile.bundles 移除、node_modules/dsh-tauri 目录删除。3. 事件推送后列表仅剩 dshmarket，不再展示 dsh-tauri

## [P4] 验证插件自身 package.json 缺失或损坏时列表仍展示该插件

[测试类型] 功能
[前置条件] profile 依赖含 dsh-tauri，但 node_modules/dsh-tauri/package.json 不存在或为非法 JSON
[测试步骤] 1. 打开插件管理页并调用 get_dsh_plugins 刷新列表。2. 检查 dsh-tauri 项是否仍展示。3. 核对 dsh-tauri 的版本与名称字段
[预期结果] 1. 列表不因单个插件元信息缺失而整体失败，仍返回完整列表。2. dsh-tauri 项仍正常展示，不被当作错误丢弃。3. dsh-tauri 版本为空字符串，名称回落为预设「DSH Tauri」或依赖键 dsh-tauri


## 插件升级与卸载

## [P1] 验证升级已装插件到新版本成功

[测试类型] 功能
[前置条件] 已安装 dshmarket 版本 1.12.0；当前档案为 web；网络可达 dsh-market 仓库
[测试步骤] 1. 在插件管理页对 dshmarket 点击「升级」。2. 等待 dsh plugin --profile web update dshmarket 子进程结束。3. 升级完成后刷新列表核对版本
[预期结果] 1. 前端拉起升级并逐行推送 preinstall-log 日志。2. 命令退出码为 0，返回成功且该插件旧错误记录被清除。3. 列表刷新后 dshmarket 版本为最新（如 1.13.1）

## [P1] 验证卸载插件成功且从列表移除

[测试类型] 功能
[前置条件] 已安装 dsh-tauri；插件管理页已打开；当前档案为 web
[测试步骤] 1. 对 dsh-tauri 点击「卸载」并确认。2. 等待 dsh plugin --profile web remove dsh-tauri 结束，并核验 profile 清单。3. 刷新插件列表
[预期结果] 1. 前端即时推送 preinstall-log 日志行。2. 命令退出码为 0，dsh-tauri 从 dependencies 与 dsh.profile.bundles 移除、node_modules/dsh-tauri 目录删除。3. 列表不再展示 dsh-tauri，其余已装插件保留

## [P3] 验证升级失败时给出错误详情并可重试

[测试类型] 功能
[前置条件] 已安装 dshmarket；断开网络使仓库不可达；插件管理页已打开
[测试步骤] 1. 在断网状态下对 dshmarket 点击「升级」。2. 等待子进程失败返回，检查页面错误详情。3. 恢复网络后点击「重试」再次升级
[预期结果] 1. 升级日志经 preinstall-log 逐行推送，返回 PLUGIN_UPDATE_FAILED。2. 页面展示可读错误详情（git 传输层错误给出 HTTPS 指引或 pnpm 错误行），错误持久化到 plugin-errors.json（action 为 update），列表对应项出现异常标记。3. 重试后再次执行 dsh plugin --profile web update dshmarket，成功后返回 OK 并清除该错误记录

## [P3][反向] 验证卸载不存在的插件时不误报成功

[测试类型] 功能
[前置条件] 当前已装插件不含 dsh-tauri；插件管理页已打开
[测试步骤] 1. 直接调用 remove_dsh_plugin（id 为 dsh-tauri）。2. 等待 dsh plugin --profile web remove dsh-tauri 返回。3. 检查页面反馈与列表状态
[预期结果] 1. 卸载命令不会误删其它插件，profile 其余 dependencies 保持不变。2. 命令不返回「卸载成功」的假确认，以明确结果反馈给页面。3. 页面提示与真实安装情况一致，列表状态不变

## [P2] 验证升级或卸载后服务按新状态生效

[测试类型] 功能
[前置条件] 已安装 dshmarket（bundled）等插件；当前档案为 web；服务运行中
[测试步骤] 1. 升级 dshmarket 后由前端触发服务重启。2. 重启完成后核对新版本是否加载。3. 卸载一个启动加载插件后重启，确认其不再加载
[预期结果] 1. 升级或卸载前先停止运行中的服务并提示「正在停止运行中的服务」，随后重启。2. 重启后 dshmarket 以新版本状态加载，dsh-plugins-updated 事件推送新列表。3. 被卸载的启动加载插件在重启后不再加载，服务正常启动无异常


## 插件异常与恢复

## [P1] 验证页面运行期错误通过 report_plugin_error 记录并实时同步

[测试类型] 功能
[前置条件] 桌面应用运行中；已安装 dshmarket；插件管理页已打开
[测试步骤] 1. 模拟内嵌页面/dsh-tauri 桥调用 report_plugin_error（id 为 dshmarket，error 为具体运行时错误文本，action 为 runtime）。2. 检查 plugin-errors.json 持久化内容。3. 检查前端列表与修复界面
[预期结果] 1. 错误写入 $BASE_DIR/plugin-errors.json，action 为 runtime，message 为上报文本，at 为当前秒级时间戳。2. 立即推送 dsh-plugins-updated，列表 dshmarket 项展示 error 字段（message 与 action）。3. 推送 plugin-recovery-required 事件，前端弹出「卸除此插件并继续检测」修复界面（reason 为 runtime、plugins 为 [dshmarket]）

## [P3] 验证 detect_plugin_recovery 能定位到损坏插件

[测试类型] 功能
[前置条件] profile 中存在导致启动失败的问题插件（如 dsh-better-sidebar 导致 duplicate loader entry）；已取得启动失败日志行
[测试步骤] 1. 前端读取服务日志得到失败日志行。2. 将日志行传入 detect_plugin_recovery（logs）。3. 检查返回的 PluginRecoveryInfo
[预期结果] 1. plugins 定位到唯一根插件（如 dsh-better-sidebar）。2. reason 判定为对应特征（duplicate_route、duplicate_loader_entry、cannot_resolve_bundle、no_dsh_bundle、slot_conflict、load_failed 之一）。3. raw_error 为清洗后的关键错误行（不超过 2000 字符），detail 含冲突的路由、槽位或组件 id

## [P2] 验证 recover_plugin 能恢复损坏插件

[测试类型] 功能
[前置条件] 已通过 detect_plugin_recovery 定位到损坏插件 dsh-better-sidebar
[测试步骤] 1. 在修复界面点击「卸除此插件并继续检测」，调用 recover_plugin（id 为 dsh-better-sidebar）。2. 检查 profile 清单与文件改动。3. 前端 restart() 重启并重新检测
[预期结果] 1. dsh-better-sidebar 从 package.json 的 dependencies 与 dsh.profile.bundles 移除，node_modules/dsh-better-sidebar 目录删除，cordis.patch.yml 中对应条目被剥离，pnpm-lock.yaml 被清除。2. 其它第三方插件与配置被保留，plugin-errors.json 中该插件错误记录被清除。3. 重启后不再因该插件启动失败，若无可修复问题则恢复正常启动

## [P2] 验证插件恢复正常后错误状态清除

[测试类型] 功能
[前置条件] dshmarket 存在运行时错误记录（plugin-errors.json 中 action 为 runtime）
[测试步骤] 1. 通过升级或重装成功修复 dshmarket。2. 检查 plugin-errors.json。3. 刷新插件列表
[预期结果] 1. 升级或重装成功后调用 errors::clear，plugin-errors.json 中 dshmarket 记录被删除。2. 列表 dshmarket 项 error 字段不再输出，不显示异常标记。3. 前端列表同步更新（force_emit 推送），dshmarket 状态恢复正常

## [P3][反向] 验证 recover_plugin 拒绝卸载核心或官方包

[测试类型] 功能
[前置条件] profile 已安装 dshmarket（核心）与 @deepseek-ai/dsh-base（官方包）
[测试步骤] 1. 直接调用 recover_plugin（id 为 dshmarket）并观察返回。2. 再调用 recover_plugin（id 为 @deepseek-ai/dsh-base）。3. 核对 profile 清单与 plugin-errors.json
[预期结果] 1. 返回 PLUGIN_RECOVERY_REFUSED，拒绝删除核心包 dshmarket。2. 同样拒绝删除官方包 @deepseek-ai/dsh-base，前端不提示可修复移除。3. 这些受保护包从 profile 清单与 node_modules 未被动过，错误记录未被清除


## 预装插件安装引导

## [P1] 验证选中推荐插件后确认安装并展示实时安装日志

[测试类型] 功能
[前置条件] 首次启动或清单变更后进入引导；当前档案为 web；网络可达；已勾选 dshmarket、dsh-tauri
[测试步骤] 1. 在引导界面勾选推荐插件 dshmarket、dsh-tauri 并点击「安装」。2. 观察日志面板。3. 等待安装完成
[预期结果] 1. 调用 install_preinstall_plugins 传入选中 ids，dsh plugin --profile web add 子进程启动。2. 输出逐行以 preinstall-log 事件推送并显示在日志面板（含 bundle pnpm 下载提示、停止服务提示）。3. 安装结束日志显示「已安装 2 个插件」，引导完成并将预设指纹写入 store.dat

## [P1] 验证安装按当前档案执行 dsh plugin --profile add 命令

[测试类型] 功能
[前置条件] 当前档案为 web；引导中已勾选 dshmarket 与 dsh-better-sidebar
[测试步骤] 1. 在引导勾选插件并点击安装。2. 监控 dsh 子进程实际命令行与工作目录。3. 核对安装落点
[预期结果] 1. 实际执行 `dsh plugin --profile web add dshmarket`（github: 简写已规范为显式 git+https 形式）。2. 子进程工作目录为 profile 相关安装目录，profile 被正确初始化。3. $DSH_HOME/profiles/web/package.json 出现 dshmarket 与 dsh-better-sidebar（dependencies 与 bundles），无需用户手动创建 profile

## [P2] 验证跳过引导后记录完成不再弹出

[测试类型] 功能
[前置条件] 首次进入预装引导（preinstall_done 为 false）
[测试步骤] 1. 在引导界面点击「跳过」。2. 检查 store.dat 的 preinstall_done 与 preset_hash。3. 重启应用并调用 get_preinstall_pending
[预期结果] 1. 调用 skip_preinstall_plugins，preinstall_done 置为 true，preset_hash 记录当前清单指纹。2. 若 preset-plugins.json 内容不变，get_preinstall_pending 返回 false。3. 应用重启后不再自动进入预装引导

## [P3] 验证取消进行中的预装插件安装

[测试类型] 功能
[前置条件] Windows 平台；正在安装 dsh-better-sidebar 等耗时较长的插件；安装进行中
[测试步骤] 1. 在安装进行中点击「取消」。2. 等待 cancel_preinstall_plugins 返回并推送事件。3. 检查安装进程与引导界面状态
[预期结果] 1. cancel_preinstall_plugins 以隐藏方式定位并 taskkill /T /F 结束 `dsh plugin --profile web add` 相关 node 进程树。2. 前端收到 preinstall-cancelled 事件，界面退出安装进行态并可再次点击安装。3. 无残留 node/pnpm 进程，profile 未被写坏，之后可重新发起安装

## [P4] 验证 Windows 下列出 dsh-win-terminal-inspector 修复项

[测试类型] 功能
[前置条件] Windows 平台；首次进入预装引导
[测试步骤] 1. 打开预装引导查看清单。2. 检查 dsh-win-terminal-inspector 的展示与默认勾选。3. 对比非 Windows 平台是否列出该项
[预期结果] 1. 清单包含 dsh-win-terminal-inspector，fix 为 true（黄色 chip）且 win_only 为 true。2. 该项默认勾选、无推荐标记，name 显示为 Windows Terminal Inspector。3. 在非 Windows 平台调用 get_preinstall_plugins 不返回 dsh-win-terminal-inspector

## [P5] 验证打开预装插件仓库地址

[测试类型] 功能
[前置条件] 预装引导列出 dshmarket（repoUrl 为 https://github.com/dsh-market/dsh-market）
[测试步骤] 1. 在引导页点击 dshmarket 的「打开仓库」。2. 调用 open_preinstall_repo（id 为 dshmarket）观察系统浏览器。3. 调用 open_preinstall_repo（id 为 unknown-package）
[预期结果] 1. 系统浏览器打开该插件仓库首页。2. 浏览器地址为 https://github.com/dsh-market/dsh-market，与 preset-plugins.json 的 repoUrl 一致。3. 传入非法 id 返回 PREINSTALL_INVALID_ID，浏览器未打开任何页面


---

# 命令行集成

## dsh命令链接状态

## [P1] 验证安装完成后命令行集成状态为已链接
[测试类型] 功能
[前置条件] release 构建；内置 Node、dsh、pnpm 均已安装成功；`cli_link_enabled` 开关处于开启状态（默认 true）；安装完成后已重新打开终端
[测试步骤] 1. 打开桌面端「设置」页，调用 `get_cli_link_status` 查询命令行集成状态。2. 在系统终端执行 `dsh --version`。
[预期结果] 1. `get_cli_link_status` 返回 `enabled: true`、`shim_exists: true`、`path_registered: true`、`user_dsh_preserved: false`，`bin_dir` 为 `%LOCALAPPDATA%\deepseek-harness\bin`、`shim_path` 为 `%LOCALAPPDATA%\deepseek-harness\bin\dsh.cmd`。2. 终端输出 dsh 版本号（如 `0.1.0`），命令退出码为 0，确认 `dsh` 命令已在 PATH 注册并可用。

## [P2] 验证关闭命令行集成后链接状态为未启用
[测试类型] 功能
[前置条件] release 构建；已完成安装且命令行集成为已链接状态（`get_cli_link_status` 返回 `enabled: true`）
[测试步骤] 1. 在「设置」页将「命令行集成」开关关闭，使 `cli_link_enabled` 置为 false。2. 调用 `get_cli_link_status` 查询链接状态，并重新打开系统终端执行 `dsh --version`。
[预期结果] 1. `get_cli_link_status` 返回 `enabled: false`、`shim_exists: false`、`path_registered: false`（shim 文件已删除、PATH 条目已移除）。2. 重新打开的系统终端执行 `dsh` 提示「'dsh' 不是内部或外部命令，也不是可运行的程序或批处理文件」、退出码为 1，确认命令已不再可用。

## [P2] 验证重新开启命令行集成后重新注册并恢复可用
[测试类型] 功能
[前置条件] release 构建；上一操作已将 `cli_link_enabled` 置为 false；内置 Node、dsh、pnpm 均已安装成功
[测试步骤] 1. 在「设置」页重新开启「命令行集成」开关，使 `cli_link_enabled` 置为 true。2. 调用 `get_cli_link_status` 查询链接状态。3. 重新打开系统终端执行 `dsh --version`。
[预期结果] 1. `get_cli_link_status` 返回 `enabled: true`、`shim_exists: true`、`path_registered: true`。2. `%LOCALAPPDATA%\deepseek-harness\bin\dsh.cmd` 与 `dsh.ps1` 已重新生成。3. 终端输出 dsh 版本号、退出码为 0，`dsh` 命令恢复可用。

## [P3] 验证安装过程未完成时命令行集成状态正确反映
[测试类型] 功能
[前置条件] release 构建；桌面端处于安装过程中（内置 Node/dsh/pnpm 尚未全部安装成功）；`cli_link_enabled` 开关处于开启状态（true）
[测试步骤] 1. 在网络异常导致安装中断（安装进度未到 100%）时调用 `get_cli_link_status` 查询链接状态。2. 在系统终端执行 `dsh`。
[预期结果] 1. `get_cli_link_status` 正常返回且不抛错，`enabled` 为 true、`path_registered` 为 false（安装未完成、PATH 未注册），`shim_exists`、`user_dsh_preserved` 返回当前真实值。2. 因运行时尚未安装完成，终端输出「[dsh] Node.js runtime not found. Please run DeepSeek Harness Desktop to install it first.」、退出码为 1，而非静默成功或崩溃。


## PATH注册与shim

## [P1] 验证安装后在各平台生成dsh shim并注册PATH
[测试类型] 功能
[前置条件] release 构建；分别准备好 Windows 与 macOS/Linux 测试环境；两平台安装均已完成且 `cli_link_enabled` 为 true
[测试步骤] 1. Windows 平台检查 `%LOCALAPPDATA%\deepseek-harness\bin` 目录及注册表 `HKCU\Environment\Path`。2. Unix 平台检查 `~/.local/bin` 目录及 `~/.zshrc`/`~/.bashrc` 中的注入块。3. 两平台均重新打开终端执行 `dsh --version`。
[预期结果] 1. Windows：`dsh.cmd` 与 `dsh.ps1` 已生成，`HKCU\Environment\Path` 已追加 `%LOCALAPPDATA%\deepseek-harness\bin`。2. Unix：`~/.local/bin/dsh` shim 已生成且权限为 `-rwxr-xr-x`，rc 文件已写入 `# >>> deepseek-harness dsh >>>` 开头、`# <<< deepseek-harness dsh <<<` 结尾的注入块。3. 两平台终端均输出 dsh 版本号、退出码为 0。

## [P4] 验证shim文本为纯英文且路径转义正确
[测试类型] 兼容性
[前置条件] release 构建；应用数据目录含特殊字符（Windows 用户名含 `%`，如 `C:\Users\100%test\...`；Unix 用户名含 `'`，如 `/home/o'brien/...`）
[测试步骤] 1. 读取 `dsh.cmd`，检查 `set "APP_DIR=..."`、`set "DSH_HOME=..."` 行的 `%` 转义。2. 读取 `dsh.ps1`，检查 `$appDir = '...'`、`$dshHome = '...'` 行的 `'` 转义。3. 读取 Unix `dsh` shim，检查 `APP_DIR='...'` 行的 `'` 转义。4. 检查三个 shim 文件全文是否只含 ASCII 字符，并新开终端执行 `dsh --version`。
[预期结果] 1. `dsh.cmd` 中含 `%` 的目录已写成 `%%`（如 `set "APP_DIR=C:\Users\100%%test\..."`），不存在未转义的单独 `%`。2. `dsh.ps1` 中含 `'` 的目录已写成 `''`（如 `$appDir = 'C:\Users\o''brien\...'`）。3. Unix `dsh` shim 中含 `'` 的目录已写成 `'\''`（如 `APP_DIR='/home/o'\''brien/...'`）。4. 三文件全文不含中文或非 ASCII 字符、可由英文代码页正确解析，`dsh --version` 输出版本号无乱码、退出码为 0。

## [P2] 验证shim优先使用本机兼容Node并在不兼容时回退内置Node
[测试类型] 功能
[前置条件] release 构建；本机 PATH 前置 Node v22.22.0；内置 Node 已随应用安装至运行时目录；`cli_link_enabled` 为 true
[测试步骤] 1. 在 PATH 前置本机 Node 目录后新开终端执行 `dsh --version`。2. 将本机 Node 切换为不兼容版本 v21.7.0（PATH 中仅有 v21.7.0）后新开终端执行 `dsh --version`。
[预期结果] 1. shim 解析到本机 `node`（v22.22.0 满足 v22.15+ 条件），`dsh --version` 输出版本号、退出码为 0。2. 本机 Node v21.7.0 不满足兼容条件，shim 回退使用内置 `%APP_DIR%\runtime\node.exe`，`dsh --version` 仍输出版本号、退出码为 0。

## [P2] 验证用户已安装pnpm时pnpm shim优先转发用户pnpm
[测试类型] 功能
[前置条件] release 构建；用户自行安装的 pnpm 已在 PATH 中（如 `C:\Program Files\nodejs\pnpm.cmd` 的版本为 v9.15.0）；捆绑 pnpm 已随应用安装至 `dependencies/pnpm/bin/pnpm.cjs`
[测试步骤] 1. 新开终端执行 `pnpm --version`。2. 确认 shim 未覆盖用户 pnpm，执行 `pnpm --version` 前后用户 pnpm 的全局配置目录保持不变。
[预期结果] 1. `pnpm --version` 输出用户 pnpm 的版本号 v9.15.0、退出码为 0，而非捆绑 `dependencies/pnpm/bin/pnpm.cjs` 的版本。2. pnpm shim 转发到用户 pnpm（`where pnpm` 命中用户路径、排除 `%LOCALAPPDATA%\deepseek-harness\bin`），用户 pnpm 配置与环境未变。

## [P3] 验证本机已有pnpm或内置pnpm已安装时跳过捆绑安装
[测试类型] 兼容性
[前置条件] release 构建；安装前用户 PATH 已存在 pnpm（`pnpm --version` 可输出 v9.15.0）或应用数据目录 `dependencies/pnpm` 已为已安装状态
[测试步骤] 1. 在满足跳过条件的环境下完成应用安装，观察安装流程是否仍下载或安装捆绑 pnpm。2. 新开终端执行 `pnpm --version`。
[预期结果] 1. `Pnpm::check_installed` 判定用户 pnpm 已安装或捆绑 pnpm 已就绪，安装流程跳过捆绑 pnpm 的重复安装（安装日志出现跳过或复用提示）。2. `pnpm --version` 正常输出 v9.15.0、退出码为 0，确认复用已有 pnpm、命令可用。


---

# 端口与数据隔离

## 端口隔离

## [P1] 验证 release 构建默认服务端口为 3080
[测试类型] 功能
[前置条件] 已安装 release 构建桌面端并完成首次安装；本机 3080 与 3081 端口均未被占用
[测试步骤] 1. 以 release 构建启动桌面端，等待 Harness 服务状态进入 Running。2. 在终端执行 `netstat -ano | findstr :3080` 查看监听端口
[预期结果] 1. 服务状态为 Running，界面服务 URL 为 `http://127.0.0.1:3080`。2. 存在监听地址为 `127.0.0.1:3080` 且状态为 LISTENING 的 node.exe 进程

## [P1] 验证 debug 构建默认服务端口为 3081
[测试类型] 功能
[前置条件] 以 `pnpm tauri dev` 启动的 debug 构建已安装并完成首次启动；本机 3080 与 3081 端口均未被占用
[测试步骤] 1. 以 debug 构建启动桌面端，等待 Harness 服务状态进入 Running。2. 在终端执行 `netstat -ano | findstr :3081` 查看监听端口
[预期结果] 1. 服务状态为 Running，界面服务 URL 为 `http://127.0.0.1:3081`。2. 存在监听地址为 `127.0.0.1:3081` 且状态为 LISTENING 的 node.exe 进程

## [P1] 验证已安装版与开发版同时运行时端口不冲突
[测试类型] 兼容性
[前置条件] release 版桌面端已安装并正在运行且监听 3080；开发环境可启动 `pnpm tauri dev`，且 3081 端口空闲
[测试步骤] 1. 在 release 版正常运行（监听 3080）时，启动 `pnpm tauri dev` 运行 debug 构建。2. 等待 debug 构建进入 Running，并在终端分别执行 `netstat -ano | findstr :3080` 与 `netstat -ano | findstr :3081`。3. 在 release 版与 debug 版界面分别查看服务状态与端口
[预期结果] 1. release 版未被中断，仍监听 3080。2. debug 版监听 3081，状态 Running。3. release 版界面仍显示端口 3080 且状态 Running，debug 版界面显示端口 3081 且状态 Running，两端口互不冲突

## [P2] 验证读取配置返回的端口与构建类型一致
[测试类型] 功能
[前置条件] release 与 debug 两个构建均已分别安装并启动过，store 已生成
[测试步骤] 1. 以 release 构建启动，通过配置读取接口获取 `port` 字段。2. 以 debug 构建启动，通过配置读取接口获取 `port` 字段
[预期结果] 1. release 构建读取到的 `port` 为 3080。2. debug 构建读取到的 `port` 为 3081


## 数据目录隔离

## [P1] 验证 release 构建数据目录为 ~/.dsh 且 store 使用 .store.dat
[测试类型] 功能
[前置条件] release 构建已安装并首次启动成功；Windows 用户主目录为 `C:\Users\<username>`
[测试步骤] 1. 以 release 构建启动桌面端，等待 Harness 服务进入 Running。2. 打开设置/运行时信息面板，查看 `data_dir` 字段。3. 在应用数据目录（AppData）下确认 store 文件名
[预期结果] 1. 服务状态为 Running。2. `data_dir` 为 `C:\Users\<username>\.dsh`。3. 应用数据目录中存在 store 文件 `.store.dat`

## [P1] 验证 debug 构建数据目录为 ~/.dsh.dev 且 store 使用 .store.dev.dat
[测试类型] 功能
[前置条件] debug 构建（`pnpm tauri dev`）已安装并首次启动成功；Windows 用户主目录为 `C:\Users\<username>`
[测试步骤] 1. 以 debug 构建启动桌面端，等待 Harness 服务进入 Running。2. 打开设置/运行时信息面板，查看 `data_dir` 字段。3. 在应用数据目录（AppData）下确认 store 文件名
[预期结果] 1. 服务状态为 Running。2. `data_dir` 为 `C:\Users\<username>\.dsh.dev`。3. 应用数据目录中存在 store 文件 `.store.dev.dat`

## [P2] 验证 debug 构建不迁移旧数据、不注册 PATH、不改写 dsh shim
[测试类型] 兼容性
[前置条件] release 版存在旧版数据目录 `应用数据目录\data\dsh`；release 已注册 `dsh` 命令到用户 PATH 并生成 dsh shim；debug 构建可启动
[测试步骤] 1. 以 debug 构建启动并完成安装，等待服务进入 Running。2. 检查 `应用数据目录\data\dsh` 目录是否存在且内容未变。3. 检查用户 PATH 中 `deepseek-harness\bin` 条目与 `dsh` shim 文件内容
[预期结果] 1. 启动成功，debug 数据目录为独立 `C:\Users\<username>\.dsh.dev`。2. `应用数据目录\data\dsh` 仍存在，内容未被删除或移动（旧数据迁移为 no-op）。3. 用户 PATH 未新增/删除 `deepseek-harness\bin` 条目，`dsh` shim 内容仍指向 `~/.dsh`（未被改写为 `~/.dsh.dev`），仅 pnpm shim 被写入或保留

## [P2] 验证 debug 构建通过 .harness.pid 精确回收进程且不杀 release 进程
[测试类型] 兼容性
[前置条件] release 构建正在运行并监听 3080；上次 debug 构建被强杀，`C:\Users\<username>\.dsh.dev\.harness.pid` 记录其 PID 与端口
[测试步骤] 1. 以 debug 构建（`pnpm tauri dev`）再次启动，观察启动前的孤儿清扫。2. 检查 release 版服务进程是否仍存活并监听 3080。3. 查看 `C:\Users\<username>\.dsh.dev\.harness.pid` 内容
[预期结果] 1. 仅与 `.dsh.dev\.harness.pid` 记录 PID+端口匹配的残留 debug 进程被结束，debug 服务进入 Running，未按 dsh 安装目录路径清扫。2. release 版服务进程未被结束，状态 Running、仍监听 3080。3. `.harness.pid` 更新为本次 debug 服务的 PID 与端口（3081）

## [P1] 验证 dev 与 release 的会话/档案/端口状态互不污染
[测试类型] 功能
[前置条件] release 构建正在运行（监听 3080、使用 `~/.dsh`）；同时以 debug 构建运行（监听 3081、使用 `~/.dsh.dev`）
[测试步骤] 1. 在 release 版创建档案 `profile-release` 并新建会话，记录其端口与状态。2. 在 debug 版创建档案 `profile-dev` 并新建会话。3. 在 debug 版停止并重启服务，再回看 release 版
[预期结果] 1. `C:\Users\<username>\.dsh\profiles\profile-release\` 已创建，release 版端口 3080、状态 Running。2. `C:\Users\<username>\.dsh.dev\profiles\profile-dev\` 已创建且仅在 `.dsh.dev` 下，release 版档案列表不含 `profile-dev`。3. 仅 debug 服务重建，release 版仍端口 3080、状态 Running，`profile-release` 的会话与档案数据未变


---

# 隐私与本地化

## 纯本地与隐私默认

## [P1] 验证服务仅监听 127.0.0.1 回环地址
[测试类型] 安全性
[前置条件] 桌面端已安装并完成初始化（release 构建）；服务已启动于默认端口 3080
[测试步骤] 1. 在设置页查看服务地址与端口，并确认端口为 3080。2. 在命令行执行 netstat -ano | findstr :3080，核对监听地址。3. 使用本机局域网地址（如 192.168.1.10:3080）尝试访问服务，并从局域网内另一台主机访问该地址。
[预期结果] 1. 设置页显示服务地址为 http://127.0.0.1:3080。2. 监听结果地址列为 127.0.0.1:3080（LISTENING），未出现 0.0.0.0:3080 或 [::]:3080 等对外监听地址。3. 仅本机回环地址 127.0.0.1:3080 可访问，局域网地址与外部地址均无法打开服务页面。

## [P1] 验证默认状态下遥测关闭且不外发数据
[测试类型] 埋点
[前置条件] 桌面端以默认配置完成安装；已准备抓包工具（如 Fiddler/Wireshark 或系统代理监控）
[测试步骤] 1. 保持默认设置（不手动开启任何上报选项）启动桌面端，查看设置界面中数据上报/遥测开关状态。2. 正常使用约 5 分钟，用抓包工具采集全部对外 HTTP/HTTPS 出站请求。3. 逐条核对出站请求的目标域名与请求体，识别是否存在遥测/分析上报。
[预期结果] 1. 数据上报/遥测开关默认关闭，无需用户操作即不外发。2. 使用期间未出现指向 telemetry、analytics 等追踪域名的请求。3. 出站请求仅包含安装/更新所需的官方下载域名（如 nodejs.org、github.com、registry.npmjs.org），无遥测数据外发。

## [P2] 验证 profile、会话与设置保存在本机目录
[测试类型] 功能
[前置条件] release 构建已初始化；用户主目录下已生成 %USERPROFILE%\.dsh（对应 $DSH_HOME）
[测试步骤] 1. 启动并正常使用后，定位 %USERPROFILE%\.dsh，检查 profiles、settings.yaml 与 store 文件是否位于本机。2. 在应用中修改语言、主题、端口等设置后，重新读取 .dsh 目录下的对应配置文件。3. 在设置页查看「数据目录」信息并与磁盘实际路径比对。
[预期结果] 1. %USERPROFILE%\.dsh 下存在 profiles\web、settings.yaml、.store.dat 等结构，会话与档案数据均在本机目录。2. 修改设置后，.store.dat 或 $DSH_HOME\settings.yaml 中对应字段值同步更新。3. 设置页显示的 data_dir 与磁盘实际目录一致，未指向远程或云端路径。

## [P2] 验证本地网络与系统代理不影响正常运行
[测试类型] 兼容性
[前置条件] 已完成安装并首次运行正常；具备可切换网络环境或系统代理的操作条件
[测试步骤] 1. 断网（仅保留回环连通）后重启桌面端。2. 配置一个不可达的系统 HTTP 代理后重启桌面端。3. 尝试访问 http://127.0.0.1:3080 并修改本地设置。
[预期结果] 1. 断网后桌面端仍能正常启动，服务监听 127.0.0.1:3080。2. 配置不可达代理后界面与设置读写正常，无阻塞性报错。3. 本地服务与设置项均正常，代理仅影响安装/更新下载类操作并给出明确提示，不影响本地功能。


## 中英双语与暗色模式

## [P1] 验证切换为英文后所有界面文案变英文
[测试类型] 功能
[前置条件] 桌面端当前为中文界面（语言 zh-CN）；已完成初始化
[测试步骤] 1. 在设置页将语言切换为 en（en-US）。2. 依次检查侧边栏菜单、设置页标题、按钮与提示等可见文案。
[预期结果] 1. 设置页语言选项显示为 Language，且当前值为 en-US。2. 界面所有可见文案（侧边栏、设置页、对话框、按钮）均显示为英文，无残留中文。

## [P1] 验证切换回中文后恢复为中文界面
[测试类型] 功能
[前置条件] 桌面端当前为英文界面（语言 en-US）
[测试步骤] 1. 在设置页将语言切回 zh-CN。2. 检查侧边栏、设置页与对话框的可见文案。
[预期结果] 1. 设置页语言选项显示为 语言，且当前值为 zh-CN。2. 界面所有可见文案恢复为中文，与初始中文界面一致。

## [P2] 验证刷新/重启后语言偏好保持
[测试类型] 可靠性
[前置条件] 语言已切换为 en-US；桌面端可正常重启
[测试步骤] 1. 关闭并重新启动桌面应用，进入设置页查看语言。2. 刷新前台网页（重新加载）后再次查看语言与文案。
[预期结果] 1. 重启后界面仍为英文，设置页语言仍为 en-US。2. 刷新后语言仍为 en-US，未回落为中文。

## [P1] 验证暗色模式下界面配色正确
[测试类型] 功能
[前置条件] 当前主题为 dark（$DSH_HOME/settings.yaml 的 ui-theme.preference=dark）
[测试步骤] 1. 将 ui-theme.preference 设为 dark 并重启桌面端。2. 观察侧边栏、设置页与内嵌 dsh 页面的背景与前景配色。
[预期结果] 1. 界面主要区域为深色背景，文字与图标为浅色且对比清晰可读。2. 侧边栏与设置页等桌面壳区域均为暗色，无白底残留块或刺眼高亮，与暗色主题一致。

## [P2] 验证亮色/暗色/跟随系统三种主题切换生效
[测试类型] 功能
[前置条件] 桌面端正常运行；可切换操作系统外观
[测试步骤] 1. 将 ui-theme.preference 设为 light，重启后观察配色。2. 依次改为 dark 并重启，再改为 system 并重启。3. 在 system 模式下切换操作系统浅色/深色外观。
[预期结果] 1. light 下侧边栏、设置页与内嵌 dsh 页面为浅色配色。2. dark 下为深色配色，system 下界面随系统外观自动切换，`<html data-theme>` 值随之变化。3. 三种偏好下 get_dsh_theme 分别返回 light/dark/system，界面配色与之保持一致。

## [P2] 验证中英文下 dsh 内核界面与桌面壳主题一致
[测试类型] 兼容性
[前置条件] 主题固定为 dark（或 light）；语言分别为 zh-CN 与 en-US
[测试步骤] 1. 语言设为 zh-CN、主题为 dark，观察内嵌 dsh 页面与桌面壳（侧边栏/设置页）配色。2. 切换为 en-US 后再次观察两者配色。3. 切换主题（dark/light）后，分别在两种语言下核对桌面壳与内核配色。
[预期结果] 1. zh-CN 下桌面壳与内嵌 dsh 页面主题一致（同为 dark 或 light），无明暗割裂。2. en-US 下两者主题仍保持一致。3. 切换主题后两种语言下桌面壳与内核均同步跟随，无残留旧配色。


---

# 桌面端自更新

## 版本检查与更新

## [P1] 验证启动后自动检查 GitHub 是否有新版本
[测试类型] 功能
[前置条件] 已安装生产版桌面端（Windows，本机版本 0.6.5）；GitHub 上最新版本为 0.6.6；网络畅通
[测试步骤] 1. 启动生产版桌面端（端口 3080），等待进入主界面并完成初始化。2. 保持网络畅通，观察应用在启动后对 GitHub 的检查请求及版本比对结果
[预期结果] 1. 桌面端正常启动至主界面，初始化无中断、无错误弹窗。2. 应用启动后在后台自动向 https://github.com/hairyf/deepseek-harness-desktop/releases.atom 发起一次实时检查（无缓存），判定最新 tag v0.6.6 高于本机 0.6.5，确认存在新版本

## [P1] 验证发现新版本时提示用户并可触发下载安装包
[测试类型] 功能
[前置条件] 已安装生产版桌面端（Windows，本机版本 0.6.5）；GitHub 最新 0.6.6；网络畅通；AppData 的 updates 目录下无对应安装包
[测试步骤] 1. 启动桌面端，等待自动检查发现新版本 0.6.6，界面弹出「发现新版本」提示，点击「下载」。2. 观察下载进度与 desktop-update-progress 事件推送。3. 下载进度到达 100% 后点击「安装/打开」，确认系统默认处理器启动安装器
[预期结果] 1. 界面提示「发现新版本 0.6.6」并提供「下载」按钮，可正常交互。2. 进度百分比从 0 递增到 100，进度事件持续推送，所选资产为当前平台匹配项（Windows 为 Deepseek.Harness.Desktop_0.6.6_x64-setup.exe）。3. 安装包按 tag+资产名构造地址下载到 AppData/updates/Deepseek.Harness.Desktop_0.6.6_x64-setup.exe 且该文件存在；点击后 Windows 触发 UAC 并打开安装程序

## [P2] 验证当前已是最新版时提示无需更新
[测试类型] 功能
[前置条件] 已安装生产版桌面端（Windows，本机版本与 GitHub 最新版本均为 0.6.6）；网络畅通
[测试步骤] 1. 启动桌面端（端口 3080），等待自动检查完成版本比对。2. 查看界面更新的提示与按钮状态
[预期结果] 1. 应用查询到最新 tag 为 v0.6.6 并与本机 0.6.6 比对，判定最新不高于本机，结果为无需更新。2. 界面提示「当前已是最新版本」，不出现「更新/下载」按钮，无更新弹窗

## [P3] 验证网络不可达时检查失败且不影响正常使用
[测试类型] 功能
[前置条件] 已安装生产版桌面端（Windows）；断开网络或封禁 github.com（releases.atom 与 expanded_assets 不可达）
[测试步骤] 1. 断网后启动桌面端（端口 3080），进入主界面。2. 触发检查更新（启动自动检查或点击「检查更新」），等待请求超时（5 秒）返回。3. 随后继续使用核心功能，如查看已安装核心列表、切换到指定档案
[预期结果] 1. 检查在 5 秒超时后失败，check_desktop_update 返回 UPDATE_ATOM/UPDATE_ASSETS 错误，桌面端不崩溃、不阻塞。2. 界面提示「检查更新失败」，桌面端主界面仍正常显示。3. 可继续查看核心列表、切换档案等核心功能，服务正常启动不受影响

## [P3] 验证更新下载失败给出可重试的提示
[测试类型] 功能
[前置条件] 已安装生产版桌面端（本机版本 0.6.5）；GitHub 最新 0.6.6，存在新版本；下载期间封禁 github.com 与 ghfast.top 两个下载源
[测试步骤] 1. 在发现新版本后点击「下载」，下载期间同时封禁主源 github.com 与镜像源 ghfast.top。2. 等待下载失败返回，观察界面提示与 updates 目录。3. 恢复网络后点击「重试」，重新触发下载
[预期结果] 1. 下载中止，desktop-update-progress 事件停止推送，临时文件 .part 被清理，updates 目录下不残留该安装包。2. 界面提示「更新下载失败，请重试」（含已尝试 2 个下载源信息），应用不崩溃、不死循环。3. 点击「重试」重新发起下载，进度从 0 重新开始直至 100%，最终在 updates 目录生成安装包

## [P2] 验证开发版与生产版使用彼此隔离的更新/数据
[测试类型] 兼容性
[前置条件] 同时存在 debug 构建（pnpm tauri dev）与生产构建，且两个构建均可正常运行
[测试步骤] 1. 同时启动 debug 构建（端口 3081）与生产构建（端口 3080），并保持运行。2. 分别检查两个构建使用的端口、$DSH_HOME、store 文件与服务日志。3. 对生产版执行一次桌面端自更新（检查并下载安装包）后重启，再次查看 $DSH_HOME 与 store 文件
[预期结果] 1. debug 构建使用端口 3081、$DSH_HOME 为 ~/.dsh.dev、store 文件 .store.dev.dat、日志 logs/dsh-web.dev.log；生产构建使用端口 3080、$DSH_HOME 为 ~/.dsh、store 文件 .store.dat、日志 logs/dsh-web.log，两者互不污染。2. 两端口可同时监听不冲突，debug 构建通过 ~/.dsh.dev/.harness.pid 精确回收自有服务进程，不会终止生产版服务。3. 桌面端自更新仅替换桌面壳，更新前后 $DSH_HOME 与 .store.dat（核心数据）内容保持不变，共用内核未受影响


---

# 系统集成与兼容

## 系统操作集成

## [P1] 验证服务地址可在默认浏览器打开并复制到系统剪贴板
[测试类型] 功能
[前置条件] 服务已启动并处于 Running；监听端口 3080；系统已安装并配置默认浏览器
[测试步骤] 1. 点击工具栏「在浏览器打开」按钮（open_in_browser）。2. 返回桌面端点击「复制服务地址」按钮（copy_service_url）
[预期结果] 1. 系统默认浏览器打开新标签页并加载 http://127.0.0.1:3080 的 Harness 界面。2. 桌面端提示复制成功，系统剪贴板内容为 http://127.0.0.1:3080

## [P2] 验证在文件夹中显示定位数据目录与读取剪贴板图片
[测试类型] 功能
[前置条件] 服务 Running；$DSH_HOME 已存在（release 默认 ~/.dsh）；系统剪贴板已放入一张 800×600 的 PNG 图片
[测试步骤] 1. 点击「在文件夹中显示」按钮（reveal_in_folder/reveal_data_dir）指向数据目录 $DSH_HOME。2. 在聊天输入框执行粘贴操作（触发 read_clipboard_image）
[预期结果] 1. 系统文件管理器（Windows 资源管理器/macOS Finder/Linux 文件管理器）打开并定位到 ~/.dsh 目录。2. read_clipboard_image 返回 ClipboardImageResponse，data_url 以 data:image/png;base64, 开头、mime 为 image/png、filename 为 clipboard-image.png

## [P2] 验证 get_runtime_info 返回完整的运行时与系统信息
[测试类型] 功能
[前置条件] 服务 Running（release 端口 3080）；$DSH_HOME 默认 ~/.dsh
[测试步骤] 1. 打开侧边栏「运行时信息」面板并调用 get_runtime_info
[预期结果] 1. get_runtime_info 返回 RuntimeInfo：app_version 为当前桌面端版本号、dsh_version 为已安装 Harness 版本号、node_version 为实际使用的 Node 版本号、service_url 为 http://127.0.0.1:3080、data_dir 为 ~/.dsh（Windows 为 %USERPROFILE%\.dsh）、log_path 为服务日志路径、platform 与 arch 分别对应当前系统 OS 与 CPU 架构

## [P3][反向] 验证服务停止后代理健康检查返回未运行错误
[测试类型] 功能
[前置条件] 服务已停止；端口 3080 无进程监听
[测试步骤] 1. 先通过「停止」终止 dsh 服务并确认端口 3080 无监听。2. 调用 proxy_health_check 命令（经 Rust 代理，避免 WebView CORS）
[预期结果] 1. 服务状态为 Stopped，netstat 显示 127.0.0.1:3080 无监听。2. proxy_health_check 返回 Err（错误信息表明服务未运行/连接失败），界面健康状态标记为非健康，且日志无 WebView CORS 报错

## [P3][反向] 验证目标路径不存在时给出定位失败错误提示
[测试类型] 功能
[前置条件] 服务 Running；目标路径 C:\Users\harry\no-such-dir\no-file.txt 不存在（Windows）
[测试步骤] 1. 对不存在的目标路径触发 reveal_in_folder。2. 查看桌面端提示与命令返回结果
[预期结果] 1. reveal_in_folder 返回 Err，错误信息以 REVEAL_FAILED 开头并包含无法定位的原因。2. 桌面端弹出/显示明确错误提示（指出路径不存在或定位失败），应用不崩溃、无未捕获异常


## 跨平台兼容与Windows极简模式

## [P1] 验证 Windows（MSVC/WebView2）下安装与启动正常
[测试类型] 兼容性
[前置条件] Windows 10/11 x64；已安装 WebView2 运行时；执行全新安装
[测试步骤] 1. 在 Windows x64 双击安装包完成安装。2. 启动桌面端并等待首次依赖安装与服务拉起。3. 观察主界面渲染与 dsh 服务状态
[预期结果] 1. 安装过程无报错，安装目录与启动项创建成功。2. 首次启动自动装配内置 Node 运行时与 Harness 内核，状态机由 Installing 到达 Running。3. WebView2 正常渲染主界面（无白屏、无崩溃），http://127.0.0.1:3080 健康检查返回 HTTP 200

## [P2] 验证 macOS 首次启动触发 Gatekeeper 放行提示
[测试类型] 兼容性
[前置条件] macOS（Intel x64 或 Apple Silicon arm64）；应用未经公证、由网络下载
[测试步骤] 1. 首次打开从网络下载的桌面端 .app。2. 观察系统弹窗并按提示操作。3. 放行后再次打开应用
[预期结果] 1. 系统弹出 Gatekeeper 警告（提示无法验证开发者/来自互联网）。2. 用户选择「打开」（或前往 系统设置-隐私与安全性-仍要打开）后应用被放行。3. 放行后应用正常启动进入主界面，dsh 服务运行于 http://127.0.0.1:3080

## [P2] 验证 Linux 环境依赖 WebKit2GTK 正常运行
[测试类型] 兼容性
[前置条件] Ubuntu 22.04 x64；安装 webkit2gtk-4.1 运行库；使用 AppImage 或 .deb 安装
[测试步骤] 1. 在 Ubuntu 22.04 安装并运行 .deb 或 AppImage。2. 启动桌面端。3. 观察界面渲染与 dsh 服务状态
[预期结果] 1. 启动无 libwebkit2gtk 缺失或版本不匹配报错。2. 界面正常加载（WebKitGTK 渲染文字与样式正常、无白屏）。3. dsh 服务监听 http://127.0.0.1:3080，状态为 Running，健康检查返回 HTTP 200

## [P1] 验证 Windows 极简模式向导生成 cordis.patch.yml 挂载行与 minimal-win 极简 preset
[测试类型] 功能
[前置条件] Windows；预装插件流程已安装 dsh-win-terminal-inspector 插件（dsh plugin add github:clearkurt/dsh-win-terminal-inspector）；本机已安装 Git Bash（C:\Program Files\Git\bin\bash.exe）；$DSH_HOME 为 ~/.dsh
[测试步骤] 1. 在预装插件列表确认勾选「修复」项 dsh-win-terminal-inspector 并完成安装。2. 查看当前档案 profile 目录下的 cordis.patch.yml。3. 查看 $DSH_HOME/.agent-presets/minimal-win/ 目录内容
[预期结果] 1. 插件安装成功后 win_inspector::apply 被调用且返回 Ok。2. cordis.patch.yml 顶层数组新增一个 `- insert:` 挂载块，含 id=win-terminal-inspector 与 name=dsh-win-terminal-inspector。3. 生成 ~/.dsh/.agent-presets/minimal-win/，内含 agent.cordis.yml（terminal-bash 的 shellPath 指向 C:\Program Files\Git\bin\bash.exe、persistent-shell 组含 sandbox-policy 且 mode=danger-full-access）与 preset.yml（name 为 极简模式 (Windows)）

## [P3][反向] 验证极简模式仅在 Windows 触发且重复执行保持幂等
[测试类型] 可移植性
[前置条件] 分别具备 Windows 与 macOS/Linux 环境；Windows 已安装插件与 Git Bash；$DSH_HOME 为 ~/.dsh
[测试步骤] 1. 在 macOS/Linux 环境调用 win_inspector::apply（非 Windows 分支）。2. 在 Windows 环境连续两次调用 win_inspector::apply。3. 检查 cordis.patch.yml 与 minimal-win preset 目录
[预期结果] 1. 非 Windows 平台 apply 返回 Ok 且无任何副作用，不创建 cordis.patch.yml 挂载行、不生成 ~/.dsh/.agent-presets/minimal-win/。2. 第二次调用不重复追加，cordis.patch.yml 中 dsh-win-terminal-inspector 挂载块仍仅出现一次、内容不变。3. ~/.dsh/.agent-presets/minimal-win/agent.cordis.yml 与 preset.yml 保持首次生成内容，未被覆盖或重写


