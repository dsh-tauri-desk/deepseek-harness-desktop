<p align="center">
  <a href="https://github.com/dsh-tauri-desk/deepseek-harness-desktop">
    <img src="public/favicon.svg" width="96" alt="DeepSeek Harness Desktop" />
  </a>
</p>

<h1 align="center">DeepSeek Harness 桌面版</h1>

<p align="center">
  在桌面上一键运行 <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a> ——<br />
  无需 Node.js、无需 pnpm、无需 Docker，下载即用。
</p>

<p align="center">
  <a href="https://github.com/dsh-tauri-desk/deepseek-harness-desktop/releases">
    <img src="https://img.shields.io/github/v/release/dsh-tauri-desk/deepseek-harness-desktop?style=flat-square&label=release&color=4D6BFE" alt="Release" />
  </a>
  <img src="https://img.shields.io/github/downloads/dsh-tauri-desk/deepseek-harness-desktop/total?style=flat-square&label=downloads&color=4D6BFE" alt="Downloads" />
  <img src="https://img.shields.io/github/stars/dsh-tauri-desk/deepseek-harness-desktop?style=flat-square&label=stars&color=4D6BFE" alt="Stars" />
  <img src="https://img.shields.io/github/license/dsh-tauri-desk/deepseek-harness-desktop?style=flat-square&label=license&color=4D6BFE" alt="MIT License" />
  <img src="https://img.shields.io/badge/Windows%20%7C%20macOS%20%7C%20Linux-black?style=flat-square" alt="Windows | macOS | Linux" />
  <img src="https://img.shields.io/badge/dsh-0.1.5--rc.2-4D6BFE?style=flat-square" alt="dsh 0.1.5-rc.2" />
</p>

<p align="center">
  <samp><a href="./README.en.md">English</a> · <a href="./README.es.md">Español</a> · <a href="https://dshtauri.mintlify.site">文档</a> · <strong>中文</strong></samp>
</p>

<p align="center">
 <a href="https://trendshift.io/repositories/151676?utm_source=trendshift-badge&amp;utm_medium=badge&amp;utm_campaign=badge-trendshift-151676" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/trendshift/repositories/151676/daily?language=Rust" alt="dsh-tauri-desk%2Fdeepseek-harness-desktop | Trendshift" width="250" height="55"/></a>
</p>


<p align="center">
  <a href="docs/PREVIEW.md">
    <img src="./docs/images/hero-zh.png" width="100%" alt="DSH Desktop 中文宣传横幅" />
  </a>
</p>

- 🧩 **插件管理** — 插件面板管理已安装插件，出现异常时提供升级 / 卸载入口，错误详情。
- 🎁 **内置插件** — 随安装包内置插件，以及将来引入更多高质量的内置插件。
- 🪶 **原生轻量** — Tauri 2 外壳（非 Electron）：更小的安装包、更低的内存占用、原生窗口。
- ⌨️ **命令行集成** — 安装自动注册 `dsh` 命令，新开终端即用；不覆盖你已有 shell 配置。
- 🧭 **启动引导** — 首次启动可选推荐插件，也可在配置中重新选择。
- 🚀 **自更新** — 应用内更新，不需要重新下载；
- 🐾 **桌宠** — 提供 Pets / Codex 双来源桌宠管理，预设宠物开箱即用（直连远端素材，无需下载）、可导入 Codex `.zip` 资源包，并根据会话活动显示状态气泡。

## 预设插件

首次启动引导中提供的插件，按需勾选安装：

- [DSH Win Terminal Inspector](https://github.com/clearkurt/dsh-win-terminal-inspector) — Windows 极简模式修复
- [DSH Market](https://github.com/dsh-market/dsh-market) — 浏览、搜索并一键安装社区插件（推荐）
- [DSH Better Sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) — 类 VSCode 右侧栏，按会话隔离（推荐）
- [DSH Notification](https://github.com/omdsh-dev/dsh-notification) — 回合完成时的桌面通知

> 预设插件清单由桌面端维护。为避免不稳定的预设插件导致软件异常，如需新增或更新预设，请在 [deepseek-harness-desktop/issues](https://github.com/dsh-tauri-desk/deepseek-harness-desktop/issues) 提起请求。
>
> 当前清单还包含 [DSH Session Context Menu](https://github.com/baihejiangnan/dsh-session-context-menu)，用于会话、工作区、输入框和链接的右键操作。

## 内置插件

随安装包资源内置的第一方插件：

- [DSH Tauri](https://github.com/dsh-tauri-desk/dsh-tauri-plugins/tree/main/packages/dsh-tauri) — 提供与 Tauri 2 外壳的通信通道
- [DSH Tauri UI](https://github.com/dsh-tauri-desk/dsh-tauri-plugins/tree/main/packages/dsh-tauri-ui) — 为 Tauri 2 外壳提供自定义设置侧边栏
- [DSH Tauri Worktree](https://github.com/dsh-tauri-desk/dsh-tauri-plugins/tree/main/packages/dsh-tauri-worktree) — 为每个会话创建隔离的 Git Worktree，并支持检出到本地分支或归档放弃
- [DSH Tauri Panel](https://github.com/dsh-tauri-desk/dsh-tauri-plugins/tree/main/packages/dsh-tauri-panel) — 侧栏外壳、面板协议
- [DSH Tauri Panel Extension](https://github.com/dsh-tauri-desk/dsh-tauri-plugins/tree/main/packages/dsh-tauri-panel-extension) — Skills/MCP 管理与导入技能仓库
- [DSH Tauri Panel Scheduler](https://github.com/dsh-tauri-desk/deepseek-harness-desktop/tree/main/packages/dsh-tauri-panel-scheduler) — 创建每天、间隔、工作日或每周的定时任务；在独立 Agent 会话中执行，并保留执行记录
- [DSH Tauri Turn Rewind](https://github.com/dsh-tauri-desk/deepseek-harness-desktop/tree/main/packages/dsh-tauri-turnrewind) — 按 Agent 回合记录私有 Git 快照、显示文件变更卡片，并在冲突保护下撤销该回合改动
- [DSH Tauri Session](https://github.com/dsh-tauri-desk/dsh-tauri-plugins/tree/main/packages/dsh-tauri-session) — 将删除工作区改为归档，并提供支持搜索、排序、分组、项目筛选和取消归档的「已归档聊天」设置页
- [DSH Tauri Pet](https://github.com/dsh-tauri-desk/deepseek-harness-desktop/tree/main/packages/dsh-tauri-pet) — 管理 Chat / Codex 桌宠、预设宠物下载、资源包导入和会话活动状态
- [DSH Tauri Rightclick](https://github.com/dsh-tauri-desk/dsh-tauri-plugins/tree/main/packages/dsh-tauri-rightclick) — 为会话、工作区、正文、链接和输入框补充常用操作
- 更多即将引入的插件...

## 快速开始

从 [Releases](https://github.com/dsh-tauri-desk/deepseek-harness-desktop/releases) 下载对应平台安装包，安装后启动即可。

**macOS（Homebrew）：** 也可通过 Homebrew 一键安装：

```bash
brew install dsh-tauri-desk/desktop/deepseek-harness
```

首次运行会下载 Node 运行时与 Harness 内核（如已经安装 `dsh` ，则使用安装版本），随后直接进入 `http://127.0.0.1:3080` 的 Harness 界面；此后完全本地运行，无需联网。

**系统要求：** Windows 10+ · macOS 10.15+ · Linux（AppImage / .deb）· 首次运行需要网络

> **Linux Wayland 注意（PikaOS / GNOME Wayland / Ubuntu 22.04+）：** AppImage 在 Wayland 下可能因 WebKitGTK 黑屏/崩溃，应用已自动处理常见情形。 <details><summary>若仍黑屏/崩溃：</summary><br>**改用 `.deb`**（已验证 PikaOS 4 Wayland），或手动 `WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1 GDK_BACKEND=x11 ./AppImage`。图标不显示时，将应用内 `hicolor` 图标复制到 `~/.local/share/icons` 并运行 `update-desktop-database`。<br></details>

## 交流

- [加入 Discord 社区](https://discord.gg/RT9As6Cj8B)

<table>
  <tr>
    <td align="center"><strong>QQ 群</strong><br /><img src="./docs/images/community/qq-qrcode.jpg" width="360" alt="QQ 群二维码" /></td>
    <td align="center"><strong>微信群(已满,请先加我微信) -> </strong><br /><img src="./docs/images/community/wx-qrcode.png" width="360" alt="微信群二维码" /></td>
    <td align="center"><strong>个人微信</strong><br /><img src="https://github.com/user-attachments/assets/c1d6e493-b608-4a6d-b387-dfcaa37ccfdc" width="360" alt="微信群二维码" /></td>
  </tr>
</table>


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
- [dsh-tauri-plugins](https://github.com/dsh-tauri-desk/dsh-tauri-plugins) — 部分内置插件包的开发源仓库
- [n8n-desktop](https://github.com/tangtao646/n8n-desktop) — 参考实现

### 插件数据源

插件在运行时直接引用的远端素材与上游清单：

- [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet) — 预设桌宠素材（WebM 动作、预览 GIF、`config.jsonc`），`preset-pets.json` 固定到 `e1ff8c1`
- [dsh-tauri-desk/dsh-pet-mov](https://github.com/dsh-tauri-desk/dsh-pet-mov) — macOS HEVC-alpha `.mov` 镜像（WKWebView 不认 VP9-alpha），固定到 `be0f3bb`
- [hairyf/dsh-pet-component](https://github.com/hairyf/dsh-pet-component) — 桌宠渲染组件（npm `dsh-pet-component`）
- [qinyre/dsh-plugin-capabilities](https://github.com/qinyre/dsh-plugin-capabilities) — Skills / MCP 管理上游，固定到 `3412f8d`
- [anthropics/skills](https://github.com/anthropics/skills) / [vercel-labs/skills](https://github.com/vercel-labs/skills) — 随插件包内置的 `skill-creator` / `find-skills` 来源

### 插件子仓库

`source/` 下按插件需要克隆的参考仓库，多数不随本仓库提交：

- [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet) — 桌宠动作权重、连续播放与气泡样式（子模块）
- [Skylarking/dsh-plugin-codex-pets](https://github.com/Skylarking/dsh-plugin-codex-pets) — Codex 宠物图集与会话状态映射（子模块）
- [ayangweb/BongoCat](https://github.com/ayangweb/BongoCat) — Tauri 桌宠窗口、原生拖动、DPI 与鼠标穿透基准（子模块）
- [QCYTSN/dsh-dafeiyu](https://github.com/QCYTSN/dsh-dafeiyu) — 桌宠气泡文案与状态优先级参考（子模块）
- [Signalight/codex-to-dsh-pet](https://github.com/Signalight/codex-to-dsh-pet) — Codex v2 图集、动作优先级与会话状态映射
- [Anionex/dsh-turn-rewind](https://github.com/Anionex/dsh-turn-rewind) / [Willmylife/dsh-rewind](https://github.com/Willmylife/dsh-rewind) — 回合快照、冲突分类与撤销参考
- [a179-sanae/dsh-auto-collapse](https://github.com/a179-sanae/dsh-auto-collapse) / [Laplace-bit/dsh-smooth-stream](https://github.com/Laplace-bit/dsh-smooth-stream) — 可选能力探测与跨内核兼容参考

## License

[MIT](./LICENSE)，附加[非商用条款](./LICENSE.details) © deepseek-harness-desktop contributors
