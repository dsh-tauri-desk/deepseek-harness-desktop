# 测试点：本机 Node/Pnpm 复用

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
[前置条件] 本机 PATH 中存在 node v22.18.0（低于 v22.19.0 下限）；捆绑 `runtime\node.exe` 已是 v22.22.0；网络可达
[测试步骤] 1. 在本机安装 Node v22.18.0 并加入 PATH，确认 `node --version` 输出 v22.18.0。2. 确保 `%APPDATA%\io.github.hairyf.deepseek-harness-desktop\runtime\node.exe` 位于 v22.22.0。3. 启动安装，观察 Node 任务是否走捆绑运行时（is_runtime_compatible 判定）与安装结果
[预期结果] 1. 本机 v22.18.0 不满足 v22.19.0 门槛，get_local_node_path 返回 None，不使用本机 node；Node 23 同样不受支持。2. 捆绑 `runtime\node.exe`（v22.22.0）被复用，Node 任务 check_installed 通过兼容判定、不重新下载。3. get_active_node_version 返回 22.22.0，安装成功并进入 Running

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
