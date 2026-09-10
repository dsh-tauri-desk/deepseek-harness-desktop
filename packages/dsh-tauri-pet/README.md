# dsh-tauri-pet

DeepSeek Harness 的桌宠插件。它在设置页提供 `Pets` 与 `Codex` 两个页签，
并通过 `dsh-tauri` 的 Tauri invoke 桥控制独立的透明、置顶、无边框桌宠窗口。

## UI

- **Pets**：显示预设宠物（`resources/preset-pets.json` 清单，下载到
  `~/.dsh/pets/<id>` 后启用）以及 Chat 来源的宠物卡片；工具栏提供
  **Create** 和 **Wake pet / Collapse pet**。`Create` 创建标准会话并只预填
  `/hatch-dsh-pet 根据你对我的了解，养一只宠物`，不会自动提交。
- **Codex**：显示 Codex 来源（`~/.codex/pets`）的宠物卡片；工具栏只有
  **Import**，用于导入 `.zip` 资源包。
- 预设宠物媒体（WebM / GIF / config.jsonc）不再随本包内置：用户在设置页
  「下载」后安装到 `~/.dsh/pets/<id>`，桌宠窗口按 `config.jsonc` 的动画池
  （动画名 = webm 文件名主名）直接播放下载产物，无运行时回退。
- 宠物大小滑条保持 50–200%，默认 100%。侧栏绿色圆点表示窗口当前 **visible** 状态，
  而不是只表示持久化的 `enabled` 状态。首次点击会永久启用；之后只显示或隐藏窗口，
  不会因隐藏而写入 `enabled=false`。

## 文件来源与技能

Chat 宠物安装在 `${DSH_HOME:-$HOME/.dsh}/pets`，Codex 宠物安装在
`$HOME/.codex/pets`，两个来源通过 `list_pets({ source: 'chat' | 'codex' })`
严格分开。预设宠物清单（`src-tauri/resources/preset-pets.json`）登记远端仓库
与资源子目录，下载解压后只保留 `assets` 前缀下的条目。`skills/hatch-dsh-pet/SKILL.md`
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
| `get_pet_status` | 查询 `enabled`、`visible`、`active_pet`、`pet_size` 与瞬态 activity |
| `set_pet_enabled` | 持久化首次启用；启用时显示窗口 |
| `show_pet` / `hide_pet` | 只改变窗口可见性，不改变持久化 enabled |
| `set_active_pet` | 持久化选择的宠物 id |
| `set_pet_size` | 持久化 50–200% 的大小 |
| `list_pets` | 按 `source` 列出 Chat 或 Codex 宠物 |
| `get_pet_asset` | 获取指定宠物的完整 8×11 spritesheet data URL |
| `list_preset_pets` | 列出预设宠物清单（含安装状态） |
| `download_preset_pet` | 后台下载并安装预设宠物 |
| `get_preset_download_progress` | 轮询预设宠物下载/解压进度 |
| `get_preset_pet_config` | 读取已安装预设的 `config.jsonc`（dsh-pet 协议，校验后返回） |
| `get_preset_pet_assets` | 列出已安装预设的 WebM URL manifest（dsh-pet 协议按需流式提供） |
| `import_pet` | 导入 Codex `.zip` 资源包 |
| `set_pet_activity` | 更新 `idle`、`turn`、`moving-left`、`moving-right`、`waving`、`waiting`、`running`、`review` 或 `failed` |

完整客户端桥实现见 `src/client/service/pet.ts`；它调用
`dsh-tauri/client` 的 `invokeBridgedTauri`。设置卡片直接使用预设清单的浏览图
URL 作为缩略图。

## Build and checks

```sh
pnpm --filter dsh-tauri-pet typecheck
pnpm --filter dsh-tauri-pet build
pnpm exec eslint packages/dsh-tauri-pet/src/client --max-warnings=0
pnpm exec vitest run packages/dsh-tauri-pet/src/host/reducer.test.ts
```
