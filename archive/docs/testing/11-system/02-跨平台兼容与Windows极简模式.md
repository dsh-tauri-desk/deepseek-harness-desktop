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
