# dsh-tauri-pet

DeepSeek Harness 的桌宠插件。它在设置页提供 `Pets` 与 `Codex` 两个页签，
并通过 `dsh-tauri` 的 Tauri invoke 桥控制独立的透明、置顶、无边框桌宠窗口。

## UI

- **Pets**：显示预设宠物（`resources/preset-pets.json` 清单，卡片点击即启用，
  无需下载）以及 Chat 来源的宠物卡片；工具栏提供
  **Create** 和 **Wake pet / Collapse pet**。`Create` 创建标准会话并只预填
  `/hatch-dsh-pet 根据你对我的了解，养一只宠物`，不会自动提交。
- **Codex**：显示 Codex 来源（`~/.codex/pets`）的宠物卡片；工具栏只有
  **Import**，用于导入 `.zip` 资源包。
- 预设宠物**不下载、不安装**：清单条目登记远端素材地址与渲染参数，桌宠窗口直接
  把它们交给 [`dsh-pet-component`](https://github.com/hairyf/dsh-pet-component) 的
  `<Pet>`（`config` / `uri` / `ext` / `kind` / `size`），首次播放按需拉取并落
  IndexedDB 缓存。macOS 的 WKWebView 不认 VP9-alpha WebM（alpha 被丢弃、透明区域
  渲染成黑色，issue #434），因此清单里 macOS 用 `uri.mac` / `ext.mac` 指向
  [`dsh-tauri-desk/dsh-pet-mov`](https://github.com/dsh-tauri-desk/dsh-pet-mov)
  的 HEVC-with-Alpha `.mov`，其余平台继续用上游 WebM。
- 宠物大小滑条保持 50–200%，默认 100%。侧栏入口常驻（预设随时可启用），绿色圆点
  表示窗口当前 **visible** 状态，而不是只表示持久化的 `enabled` 状态。首次点击会
  永久启用；之后只显示或隐藏窗口，不会因隐藏而写入 `enabled=false`。

## 文件来源与技能

Chat 宠物安装在 `${DSH_HOME:-$HOME/.dsh}/pets`，Codex 宠物安装在
`$HOME/.codex/pets`，两个来源通过 `list_pets({ source: 'chat' | 'codex' })`
严格分开。预设宠物清单（`src-tauri/resources/preset-pets.json`）只登记远端素材
地址与渲染参数，本地不落任何预设产物。`skills/hatch-dsh-pet/SKILL.md`
由 `cordis.patch.yml` 组合进 `@deepseek-ai/dsh-skill-filesystem`，并使用
`providerName: dsh-tauri-pet` 与 `includeDefaultRoots: false`，避免覆盖其他
skill provider 或默认根目录。

## 会话展示态来源（host half）

宿主编排侧（`src/index.ts` + `src/host/reducer.ts`）订阅宿主事件，把「会话增量」投影成
桌宠展示态后经 SSE（`/api/dsh-pet/session-stream`）下发给 Rust 侧再 `emit_to` 桌宠窗口：

- `session/event`：回合生命周期的权威来源（turn/start → thinking、tool/call → working、
  approval/asked → waiting、turn/end 按 reason 落定 success/error/waiting 或回空闲…）。
- `agent/status`：`status === 'idle'` 时作为**回合收尾兜底**。核心在异常收尾时可能不追加
  `turn/end`（用户中止、被父级中断、崩溃修复补写的 `interrupted` 只进日志、不再发
  `session/event`），只认 `turn/end` 会让桌宠永远停在「思考中」气泡 + 循环动画。
  兜底只在会话仍处于回合内（`running || turnActive || stepActive`）时生效，`turn/end`
  已落定的终态档（success/error）与 blocked 等待态不被改写。
- `session/disposed`：会话消失 → 移除对应气泡与展示态。

## Bridge commands

| command | 说明 |
| --- | --- |
| `get_pet_status` | 查询 `enabled`、`visible`、`active_pet`、`pet_size`（`visible` 恒等于 `enabled`） |
| `set_pet_enabled` | 启用/关闭桌宠（**持久化**）：关闭即销毁窗口，重启后保持关闭 |
| `set_active_pet` | 持久化选择的宠物 id |
| `set_pet_size` | 持久化 50–200% 的大小 |
| `list_pets` | 按 `source` 列出 Chat 或 Codex 宠物 |
| `get_pet_asset` | 获取指定宠物的完整 8×11 spritesheet data URL |
| `list_preset_pets` | 列出预设宠物清单（远端素材 + 渲染参数，无安装态） |
| `import_pet` | 导入 Codex `.zip` 资源包 |
| `set_pet_activity` | 更新 `idle`、`turn`、`moving-left`、`moving-right`、`waving`、`waiting`、`running`、`review` 或 `failed` |

完整客户端桥实现见 `src/client/service/pet.ts`；它调用
`dsh-tauri/client` 的 `invoke`（签名与 `@tauri-apps/api/core` 一致）。设置卡片直接使用预设清单的浏览图
URL 作为缩略图。

> 桌宠窗口渲染全部交给 `dsh-pet-component`（`src/pet`）：远端素材经
> `@tauri-apps/plugin-http` 的 `fetch` 拉取（绕开 githubusercontent 的 CORS），
> 动画池解析、双视频缓冲、雪碧图帧循环、IndexedDB 缓存与双击回应都在组件内。

## Build and checks

```sh
pnpm --filter dsh-tauri-pet typecheck
pnpm --filter dsh-tauri-pet build
pnpm exec eslint packages/dsh-tauri-pet/src/client --max-warnings=0
pnpm exec vitest run packages/dsh-tauri-pet/src/host/reducer.test.ts
```
