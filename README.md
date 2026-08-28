<p align="center">
  <a href="https://github.com/hairyf/deepseek-harness-desktop">
    <img src="public/favicon.svg" width="96" alt="DeepSeek Harness Desktop" />
  </a>
</p>

<h1 align="center">DeepSeek Harness 桌面版</h1>

<p align="center">
  在桌面上一键运行 <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a> ——<br />
  无需 Node.js、无需 pnpm、无需 Docker，下载即用。
</p>

<p align="center">
  <a href="https://github.com/hairyf/deepseek-harness-desktop/releases">
    <img src="https://img.shields.io/github/v/release/hairyf/deepseek-harness-desktop?style=flat-square&label=release&color=4D6BFE" alt="Release" />
  </a>
  <img src="https://img.shields.io/github/downloads/hairyf/deepseek-harness-desktop/total?style=flat-square&label=downloads&color=4D6BFE" alt="Downloads" />
  <img src="https://img.shields.io/github/stars/hairyf/deepseek-harness-desktop?style=flat-square&label=stars&color=4D6BFE" alt="Stars" />
  <img src="https://img.shields.io/github/license/hairyf/deepseek-harness-desktop?style=flat-square&label=license&color=4D6BFE" alt="MIT License" />
  <img src="https://img.shields.io/badge/Windows%20%7C%20macOS%20%7C%20Linux-black?style=flat-square" alt="Windows | macOS | Linux" />
</p>

<p align="center">
  <samp><a href="./README.en.md">English</a> · <strong>中文</strong></samp>
</p>

<p align="center">
  <img src="./docs/images/hero-zh.png" width="100%" alt="DSH Desktop 中文宣传横幅" />
</p>

<table>
  <tr>
    <td><a href="docs/PREVIEW.md"><img src="./docs/images/previews/preview-1.png" alt="preview 1" /></a></td>
    <td><a href="docs/PREVIEW.md"><img src="/docs/images/previews/preview-2.png" alt="preview 2" /></a></td>
    <td><a href="docs/PREVIEW.md"><img src="/docs/images/previews/preview-4.png" alt="preview 4" /></a></td>
    <td><a href="docs/PREVIEW.md"><img src="/docs/images/previews/preview-5.png" alt="preview 5" /></a></td>
  </tr>
</table>

- 🧩 **插件管理** — 插件面板管理已安装插件，出现异常时提供升级 / 卸载入口，错误详情。
- 🎁 **内置插件** — 随安装包内置插件，以及将来引入更多高质量的内置插件。
- 🪶 **原生轻量** — Tauri 2 外壳（非 Electron）：更小的安装包、更低的内存占用、原生窗口。
- ⌨️ **命令行集成** — 安装自动注册 `dsh` 命令，新开终端即用；不覆盖你已有 shell 配置。
- 🧭 **启动引导** — 首次启动可选推荐插件，也可在配置中重新选择。
- 🚀 **自更新** — 应用内更新，不需要在重新下载；

## 预设插件

首次启动引导中提供的插件，按需勾选安装：

- [DSH Win Terminal Inspector](https://github.com/clearkurt/dsh-win-terminal-inspector) — Windows 极简模式修复
- [DSH Market](https://github.com/dsh-market/dsh-market) — 浏览、搜索并一键安装社区插件（推荐）
- [DSH Better Sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) — 类 VSCode 右侧栏，按会话隔离（推荐）
- [DSH Notification](https://github.com/omdsh-dev/dsh-notification) — 回合完成时的桌面通知
- [DSH Session Context Menu](https://github.com/baihejiangnan/dsh-session-context-menu) — DSH 右键菜单：为会话、工作区、输入框和链接补充常用操作

> 你想收录新的插件作为预设？修改 [preset-plugins.json](https://github.com/hairyf/deepseek-harness-desktop/blob/main/src-tauri/resources/preset-plugins.json) 并提交 PR，通过后将在将来版本新增为预设插件。

## 内置插件

随安装包资源内置的第一方插件：

- [DSH Tauri](https://github.com/dsh-tauri-desk/dsh-tauri) — 提供与 Tauri 2 外壳的通信通道
- [DSH Tauri UI](https://github.com/dsh-tauri-desk/dsh-tauri-ui) — 为 Tauri 2 外壳提供自定义设置侧边栏
- [DSH Tauri Worktree](https://github.com/dsh-tauri-desk/dsh-tauri-worktree) — 为每个会话创建隔离的 Git Worktree，并支持检出到本地分支或归档放弃
- [DSH Tauri Panel](https://github.com/dsh-tauri-desk/dsh-tauri-plugins/tree/main/packages/dsh-tauri-panel) — 侧栏外壳、面板协议
- [DSH Tauri Panel Extension](https://github.com/dsh-tauri-desk/dsh-tauri-plugins/tree/main/packages/dsh-tauri-panel-extension) — Skills/MCP 管理与导入技能仓库
- 更多即将引入的插件...

## 快速开始

从 [Releases](https://github.com/hairyf/deepseek-harness-desktop/releases) 下载对应平台安装包，安装后启动即可。

**macOS（Homebrew）：** 也可通过 Homebrew 一键安装：

```bash
brew install dsh-tauri-desk/desktop/deepseek-harness
```

首次运行会下载 Node 运行时与 Harness 内核（如已经安装 `dsh` ，则使用安装版本），随后直接进入 `http://127.0.0.1:3080` 的 Harness 界面；此后完全本地运行，无需联网。

**系统要求：** Windows 10+ · macOS 10.15+ · Linux（AppImage / .deb）· 首次运行需要网络

> **Linux Wayland 注意（PikaOS / GNOME Wayland / Ubuntu 22.04+）：** AppImage 在 Wayland 下可能因 WebKitGTK 黑屏/崩溃，应用已自动处理常见情形。 <details><summary>若仍黑屏/崩溃：</summary><br>**改用 `.deb`**（已验证 PikaOS 4 Wayland），或手动 `WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1 GDK_BACKEND=x11 ./AppImage`。图标不显示时，将应用内 `hicolor` 图标复制到 `~/.local/share/icons` 并运行 `update-desktop-database`。<br></details>

## 交流

<img width="360" height="566" alt="image" src="https://github.com/user-attachments/assets/598308b5-681d-4514-a8d7-a36810fa8636" />


## 开发

想参与开发？参见 [docs/DEVELOPMENT.zh.md](./docs/DEVELOPMENT.zh.md)。

## 工作原理

```text
┌──────────────────────────────────────────────┐
│ Tauri WebView (React)                        │
│   安装状态机 → 下载进度 → iframe              │
│   加载 dsh Web 界面 + 侧边栏控制              │
└──────────────────────┬───────────────────────┘
                       │ invoke 命令 + 事件
┌──────────────────────┴───────────────────────┐
│ Tauri Rust 后端                              │
│   service/download  安装器 + 解压            │
│   service/core      Harness 核心多版本管理   │
│   service/profile   dsh 档案管理             │
│   service/plugin    插件卸载 / 升级          │
│   service/cli       dsh 命令 shim + PATH     │
│   service/update    桌面端自更新             │
│   service/workflow  dsh 进程生命周期         │
│   task              dsh 健康检查             │
└──────┬───────────────────────────┬───────────┘
       │                           │
  runtime/ (Node.js v22.22.0)   dependencies/dsh/ (发行版)
       └─────────────┬─────────────┘
                     ▼
   dsh --profile <档案> --host 127.0.0.1 --port 3080
                     │  DSH_HOME=~/.dsh
                     ▼
        http://127.0.0.1:3080/  ← 内嵌界面
```

Harness 发行版由 [deepseek-harness-pkg](https://github.com/dsh-tauri-desk/deepseek-harness-pkg) 构建发布。每次启动都会对比最新发行版，本地过期时提醒下载更新；GitHub 不可达时保留本地安装。通过 CLI 全局安装的本地核心会被优先使用。

## 说明

> [!WARNING]
> **开发预览** — 上游 `dsh` 仍在快速迭代，存在破坏性变更；本项目同步跟随。

> [!NOTE]
> **安全声明** — `dsh` 具备本地代码执行能力。仅供学习 / 研究 / 测试，请在可信、隔离的环境中使用。

## 相关项目

- [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) — 上游 `dsh` agent 平台
- [deepseek-harness-pkg](https://github.com/dsh-tauri-desk/deepseek-harness-pkg) — 预打包 Harness 发行版（本应用下载源）
- [n8n-desktop](https://github.com/tangtao646/n8n-desktop) — 参考实现

## License

[MIT](./LICENSE)，附加[非商用条款](./LICENSE.details) © deepseek-harness-desktop contributors