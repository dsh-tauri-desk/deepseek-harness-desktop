# 开发

DeepSeek Harness Desktop 是 **Tauri 2 + React 19** 应用：前端位于 `src/`，Rust 后端位于 `src-tauri/`。仓库使用 pnpm 10，桌面端捆绑运行时为 Node.js 22.22.0。

## 环境要求

| 工具 | 版本 |
| --- | --- |
| Node.js | 22.19+（CI 与捆绑运行时：22.22.0） |
| Rust | 1.77.2+ |
| pnpm | 10.x（`pnpm@10.28.2`） |

以及平台编译工具链：

- **Windows** — MSVC 构建工具 + WebView2
- **macOS** — Xcode Command Line Tools
- **Linux** — WebKit2GTK

## 常用命令

```bash
pnpm install          # 安装依赖
pnpm dev              # 前端开发服务器（Vite）
pnpm dev:plugins      # 监听内置插件构建
pnpm typecheck        # 前端 TypeScript 检查
pnpm build:plugins    # 构建内置插件 bundle
pnpm tauri dev        # 调试模式运行桌面端
pnpm tauri build      # 构建安装包
```

后端检查（在 `src-tauri/` 下执行）：

```bash
cargo check
cargo test
```

macOS 的 Developer ID 签名、公证与 GitHub Actions Secrets 配置见 [macOS 签名与公证](./spec/MACOS_SIGNING.zh.md)。

若要新增一个随安装包分发、内置在应用里的插件，请参阅 [内置插件（Internal Plugins）](./spec/BUILTIN_PLUGINS.zh.md)。

## 小贴士

- 调试模式使用 **3081** 端口，正式版使用 **3080** —— 两者互不冲突，可以同时运行已安装版本与开发构建。
- 调试数据与正式版隔离：使用 `~/.dsh.dev` 和 `.store.dev.dat`，不会迁移正式版数据，也不会注册生产版 `dsh` PATH shim。
