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
