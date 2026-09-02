# dsh-tauri-panel-scheduler

`dsh-tauri-panel-scheduler` 为 DSH 桌面端提供「定时任务」能力：在面板「定时任务」页
创建每天 / 间隔 / 工作日 / 每周的计划任务，到点后在**独立新会话**中自动执行任务指令，
并记录每次执行的运行历史。

## 功能

- 面板「定时任务」页（`sidebar.panel.action` 槽条目 + `panel.protocol` 内容区替换）：
  - 两个 tab：**定时任务**（active）与**执行记录**；
  - 顶部提示「定时任务仅在电脑保持唤醒时运行」；
  - 任务列表卡片：名称、计划描述、下次运行时间、上次运行时间；
  - 每卡片 `⋯` 菜单：立即运行 / 暂停或恢复 / 删除；
  - 搜索任务名称、手动新建、刷新；
- 新建任务对话框：
  - 任务名称；
  - 计划模式选择：每天 / 间隔 / 工作日 / 每周，带动态时间参数组件
    （`HH:mm`、间隔分钟数、每周星期多选）；
  - 任务指令 textarea + 工作区选择 + 模式选择 + 模型选择；
- 宿主调度引擎（`~/.dsh/dsh-tauri-panel-scheduler/tasks.json` + `runs.json` 原子持久化，
  自建 `setInterval` 节拍，无外部 cron 依赖）；
- 每次执行 = 新建独立 Agent 会话 + `followup` 任务指令（无人值守），并归属目标工作区；
- Agent 工具集：`scheduler_create` / `scheduler_list` / `scheduler_toggle` /
  `scheduler_delete` / `scheduler_run_now`（**通过 Chat 创建 / 管理**）；
- HTTP 路由 `/api/dsh-scheduler/*`：list / create / update / toggle / delete / run /
  history / options / recover；
- 启动自愈：把上次进程中断的 running 记录标记为 `failed (host_interrupted)`。

## 计划类型

| kind | 参数 | 语义 |
| --- | --- | --- |
| `daily` | `time: "HH:mm"` | 每天指定时刻 |
| `interval` | `everyMinutes: number` | 每 N 分钟一次 |
| `workdays` | `time: "HH:mm"` | 周一至周五指定时刻 |
| `weekly` | `weekdays: Weekday[]` + `time: "HH:mm"` | 每周选中的星期指定时刻 |

时间使用宿主本地时区（与「电脑保持唤醒时运行」的产品语义一致）；时区名随任务记录，
默认 `Intl.DateTimeFormat().resolvedOptions().timeZone`。

## 执行模型

每次触发（计划到期或手动「立即运行」）：

1. 写一条 `running` 执行记录；
2. `ctx.agents.create({ sessionId, seed: [], meta: { cwd, agentPreset }, agentOptions })`
   新建独立会话（`sessionId = task-<uuid>`）；
3. 归属目标工作区（`workspaceRegistry.resolveByPath` + `attachSession`，可选）；
4. `handle.agent.followup(...)` 把任务指令作为首条用户消息唤醒驱动；
5. 等待 `whenIdle()`（默认 30 分钟超时），收敛为 `succeeded` / `failed` 并回写记录；
6. 无论成败都推进 `nextRunAt` 到下一次计划触发（失败会按计划重试，不会卡死）。

## 通过 Chat 创建

Agent 可在会话中调用 `scheduler_create` 创建定时任务（例如「每天早上 9 点写工作日报」），
也可用 `scheduler_list` / `scheduler_toggle` / `scheduler_delete` / `scheduler_run_now`
管理既有任务。面板「通过 Chat 创建」按钮引导用户直接在对话里描述需求。

## 数据与隐私

- 任务定义与执行记录存放在 `$DSH_HOME/dsh-tauri-panel-scheduler/`（两个小 JSON 文件，
  原子写，手写可恢复）；
- 执行记录保留最近 200 条；
- 删除任务会保留其执行记录（记录中存有任务名快照）。

## 要求

- DSH 桌面端（含 `dsh-tauri`、`dsh-tauri-panel`），Node 宿主 half。
- 客户端 bundle 依赖 `dsh-tauri/client`（由 `dsh-tauri-tsdown` 内联 unstorage/hookable/ofetch/pathe）。

## 开发

```bash
pnpm --filter dsh-tauri-panel-scheduler dev        # tsdown watch
pnpm --filter dsh-tauri-panel-scheduler build      # tsdown build
pnpm --filter dsh-tauri-panel-scheduler test       # vitest（计划计算）
```

## 参考

- [dsh-automation](https://github.com/MichengAI/dsh-automation) — 调度语义与执行模式参考。
- [dsh-knj-scheduler](https://github.com/yangdongzhen590/dsh-knj-scheduler) — 任务存储 / 路由参考。
