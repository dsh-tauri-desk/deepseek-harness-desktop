# dsh-tauri-turnrewind

DSH 桌面端的 **turn 级工作区撤销**：每一轮对话结束时，在对话尾部显示一张变更卡片
（「已编辑 N 个文件 / +N -M / 文件清单」），点「撤销」把这一轮对工作区做的文件改动
整体回退。

- **宿主半区**：每个 Agent turn 在**私有 Git 快照仓**里记录 before / after 两个快照，
  算出逐文件 `+N -M`，写进每会话 JSON 账本；
- **客户端半区**：接管会话视图的 `conversation.chat.turnTail` 槽位（chain，`priority: -1`），
  渲染变更卡片；
- 对用户仓库**全程只读**：不碰 HEAD / 分支 / index / stash / 提交历史。

设计与决策记录：[`docs/plugins/11.优化计划.turnrewind实现.md`](../../docs/plugins/11.优化计划.turnrewind实现.md)
（含调研结论、与已删除的旧架构 demo 的差异、双内核适配矩阵）。

## 交互

```text
单文件                                    多文件
┌───────────────────────────────────┐    ┌───────────────────────────────────┐
│ [＋]  已编辑 test-note.md          │    │ [＋]  已编辑 5 个文件             │
│      +6 -0          撤销 ↶  审核  │    │      +26 -0        撤销 ↶  审核  │
└───────────────────────────────────┘    ├───────────────────────────────────┤
  hover ↓（副行换成「查看更改」）           │ README.md                 +11 -0  │
┌───────────────────────────────────┐    │ config.json                +6 -0  │
│ [＋]  已编辑 test-note.md          │    │ data/sample.txt            +3 -0  │
│      查看更改 ↗     撤销 ↶  审核  │    ├───────────────────────────────────┤
└───────────────────────────────────┘    │ 再显示 2 个文件 ⌄                 │
                                         └───────────────────────────────────┘
```

**运行中**（`conversation.input.dock`，输入框上方居中的胶囊；turn 结束后消失）：

```text
              1 个文件已更改 +1 -0
┌────────────────────────────────────────────────────────────────────┐
│ [会话输入框]                                                        │
└────────────────────────────────────────────────────────────────────┘
```

该槽是 list 型，官方任务清单（`todo`，order `0`，`data-testid="todo-panel"`）、
goal（`10`）、queue（`20`）与工作树插件的会话横幅（`-10`）都在同一个槽里。
本插件用 order **`-30`** 让提示条排在这些条目**之上**：运行中的实时读数是当前动作的
直接反馈，应紧贴对话内容，而不是被任务清单压到输入框上方最远处。

| 元素 | 行为 |
|---|---|
| `撤销 ↶` | **真功能**：撤销该轮的文件改动；**撤销成功后按钮消失**，只留「已撤销」徽标 |
| 「再显示 N 个文件 ⌄」/「收起文件 ⌃」 | 真功能：展开 / 收起（清单默认 3 行，展开后底部仍有「收起文件」可回到 3 行） |
| 单文件标题 / 清单行点击打开文件 | **真功能**：在**应用内右侧边栏**打开该文件的文本预览页签（同官方 `producedChip`）。仅在具备该能力的内核上生效，见下 |
| `＋` 图标块（文件） | **占位**（无点击处理，`data-placeholder` 标注） |
| 单文件 / 多文件标题 hover 的「查看更改 ↗」 | **暂时整体停用**（源码 `TODO(view-changes-hover)` 保留实现；恢复时单文件与多文件的 `__head` 都要生效） |
| `审核` | **暂时整体隐藏**（源码 `TODO(review-action)` 保留按钮实现） |

- 单文件：标题即文件名、不渲染清单；多文件：标题是文件数、副行是总计（绿 `+N` / 红 `-M`）。
- **打开文件按内核能力分流**：新核心（`0.1.5-rc.1`，有应用内右侧边栏）→ 点标题 / 清单行
  在侧边栏打开预览页签；旧核心（`0.1.2-rc.1`，`openFile` 会把路径交给宿主/系统打开）→
  **完全静默**：标题与清单行渲染成不可点的普通元素，不调用 `openFile`（不给假交互）。
  判定不看版本号，只看有没有 `sidebarRight` 服务（见 client/capabilities）。
- 本轮**只开放功能，没有新增任何 hover 样式**；清单行原有的 hover 背景高亮是上一轮视觉对齐时就有的。
- 文件清单最多三行，其余折叠；本轮删除（D）的文件整行弱化。
- **已撤销的 turn**：只剩「已撤销」徽标与文件名/清单行，不再有撤销按钮与审核。
- 该轮没有任何文件变化 → 不出现卡片。
- **卡片可能比 turn 结束晚几秒出现**：after 快照在 turn 结束后**后台结算**（还要排在同一条
  工作区队列里的实时读数之后），大仓库上首次捕获要十几秒。客户端会一直等到账本里出现这一轮的
  记录（700ms 起指数退避、5s 封顶，最长约 50s）——**手动停止**的 turn 同样会补上卡片。
- 捕获过程失败且这一轮**从未建立过快照**（用户中断、捕获子进程被回收、git 暂时报错）→
  同样不出现卡片：账本行与宿主日志照常保留（诊断不丢），但界面上不弹「撤销不可用」——
  这一轮从来没有过可撤销的承诺，弹告警只会让人以为出了问题。
  「基线已建立、after 结算失败」是另一回事（承诺过的撤销落空了），仍会如实告警。
- 撤销成功后同一 turn 不能重复撤销。
- 撤销前若发现文件在 turn 结束后又被改动过 → **拒绝执行并列出冲突文件**，不覆盖任何文件。
- 该轮仍在运行中（after 快照未结算）→ 拒绝撤销并说明原因。
- **不在撤销范围内**的文件会如实标注（不静默漏掉）：超大文件未纳入快照、嵌套 Git 仓库被跳过时，
  卡片下方给出中性提示行（鼠标悬停可看具体路径）。
- 快照被回收（超出保留范围 / 快照仓因超限被重建）→ 该轮显示「已过期」原因，撤销按钮禁用。
- 工作区不是 Git 仓库 → 点「撤销」弹出说明弹窗：

```text
撤销需要使用 Git 代码仓库
此操作仅在 Git 代码仓库中运行时有效。
[ 关闭 ]
```

## 快照与撤销语义

```text
$DSH_HOME/dsh-tauri-turnrewind/
├─ workspaces/<sha256(worktree 根)[0:24]>.git/   # 每个 worktree 一个私有快照仓（bare + core.worktree）
│     └─ refs/turnrewind/<sessionId>/<turn>/<before|after>
├─ workspaces/<hash>.git.json                     # 快照仓代数（重建后轮换，旧记录据此过期）
├─ workspaces/<hash>.git.exclude.json             # 排除清单（超大文件 / 嵌套仓库，每次复检）
└─ sessions/<sessionId>.json                      # 每会话账本（原子写）
```

- **快照域 = Git worktree 根**：会话 cwd 是子目录时归并到根，同一仓库共享一个快照域。
- **捕获**：`git add --all` → `write-tree` → `commit-tree` → `update-ref`（全部落在私有仓）。
  before 在 `agent/pre-step`（step 1）的 **await 屏障**里完成，必然早于任何文件改动；
  after 在 `turn/end` 之后**后台结算**（`agent/status → idle` 兜底中断的 turn）。
- **结算不会被 before 快照的窗口吃掉**：用户可能在 before 快照还没结束时就手动停止（屏障上要跑
  几秒到几十秒，首次还要初始化私有仓），那一刻 `turn/end` 与 idle 都已到达、而活动表里还没有
  条目——结算因此**先等在飞的 before 快照落地**再捕 after，并且对同一个 turn 幂等（两个事件几乎
  同时到达也只结算一次）。不这么做时被中断的 turn 会一直不落账（实测有 30 分钟后才被顺手收掉的），
  卡片也就一直不出现。
- **差异**：`git diff --numstat` 取行数，两侧路径集合推导新增（A）/修改（M）/删除（D）。
- **撤销**：M/D 由 `git checkout <before> -- <path>` 还原，A 删除文件并清理变空的父目录。
- **冲突预检**：`git diff <afterCommit> -- <paths>`（与快照写入共用同一套换行/属性归一化，
  CRLF 工作区不会被误判）+ 删除态的存在性检查（用户重建的同名文件 git diff 看不见）+
  路径安全（父级符号链接/非目录、非空目录占位）。全部在**动文件之前**完成。
- **忽略规则**：完全委托源仓库（`.gitignore` / global excludes），并镜像源仓库的
  `core.autocrlf` / `core.eol` / `core.symlinks` 与 `.git/info/exclude`，
  保证「比较」与「恢复」跟用户仓库语义一致。
  **被忽略的路径不进 exclude pathspec**：`git add --all -- . :(exclude)<ignored>` 会以
  `The following paths are ignored by one of your .gitignore files` 直接失败（exit 1），
  而这条错误与「加不进去」无关——被忽略的路径本来就不会进快照。因此捕获与实时读数在拼
  pathspec 之前先过一遍 `git check-ignore`（与 `git add` 读同一份 index/规则，绝不自制正则），
  把被忽略的排除项摘掉。工作区把嵌套仓库放在被忽略的目录里时（例如本仓库的 `source/`），
  不这么做会让**每一轮**捕获都失败。
- **并发**：捕获、结算、容量治理、撤销全部走**同一工作区级 FIFO 队列**——私有仓的 index
  与 refs 是共享可变状态，并发就会撞 `index.lock` 或读到半更新的 index。
- **容量治理**（每个工作区每进程一次，在首次捕获的串行区内）：
  先 `git prune --expire=now` 回收不可达对象（实时读数每 1.5s 都在产生它们，而 `gc.auto=0`），
  私有仓超过 2048 MB 时整体隔离改名 → 轮换代数 → 删除隔离目录。
- **嵌套 Git 仓库**：自动跳过并标注。有界预扫（深度 ≤2 / ≤2000 目录）+ `git add` 报错兜底；
  这些目录里的改动**不在撤销范围内**，卡片如实提示——gitlink 指针变化会造成「撤销成功但目录内容没变」的假象。

## 边界与已知限制

- **Git 是硬前置**：非 Git 目录不建快照，只提供说明弹窗；家目录、家目录祖先、
  盘根、UNC 共享根一律拒绝（`TURNREWIND_UNSAFE_WORKSPACE`）；
  PATH 上没有 git 与「不是 Git 仓库」分开报（`TURNREWIND_GIT_UNAVAILABLE`）。
- 上限：单文件 64 MB、单 turn 5000 文件、单快照 512 MB、私有仓 2048 MB。
  **超总量时先排除最大的若干文件（≤200 个）再重试**，并把它们记进「不在撤销范围内」的提示；
  超限文件过多或排除后仍超限，该 turn 才记 `unavailable`（卡片显示原因、撤销禁用），
  **不阻断** Agent turn。
- **保留策略**：每会话最近 **50 轮**保持可撤销；更老的记录转为「已过期」终态
  （清空文件清单与 refs，卡片给出原因），账本最多保留 **200 条**，超出丢弃最早记录。
- 私有仓自包含（不用 alternates 借源仓库对象）：首轮会把工作区内容复制进私有仓，
  受源仓库 ignore 规则约束（`node_modules/` 等天然排除）。
- **接管 `turnTail` 槽的后果**：官方 `ui-deliverables` 的 “Files changed” 行不再渲染，
  其「点文件名在右侧栏预览」的行为随之消失（需求已确认接受）。若之后要保留点击，
  把文件行接到 `TurnTailOwnerProps.openFile` 即可（一行）。
- 未做：redo、父对话递归撤销、保留策略设置面、恢复围栏、撤销后给模型的一次性提示注入。
  从旧架构 demo 提取（该 demo 已按需求删除）但**按需求方裁决延后**的项（敏感文件提示、弹窗焦点陷阱、账本版本备份、
  工作区漂移绑定、中断撤销日志等）记录在
  [`docs/plugins/11.优化计划.turnrewind实现.md`](../../docs/plugins/11.优化计划.turnrewind实现.md) §13.3。
- **运行中提示条的取数成本**：宿主在 turn 进行期间每 1.5s 跑一次 `git add --all` +
  `git diff`（`add` 借用私有 index 的 stat 缓存，通常是增量），turn 一结束立即停表；
  开销随仓库规模增长，大仓库上首轮较慢。

## 协议

```text
GET  /api/turnrewind/summary?sessionId=<id>
  → 200 { sessionId, isGit, workspaceRoot, unavailableReason,
          turns: [{ turn, fileCount, insertions, deletions, undoneAt, unavailable, hasBaseline,
                    truncated, files: [{ path, status, insertions, deletions, binary }],
                    skippedOversized: [path], skippedNestedRepos: [path] }] }

GET  /api/turnrewind/live?sessionId=<id>
  → 200 { active, turn, fileCount, insertions, deletions }   # 宿主内存读数，不跑 git

POST /api/turnrewind/undo   { sessionId, turn }
  → 200 { ok: true, restored: [...], removed: [...], failed: [...] }
  → 409 { error: "TURNREWIND_CONFLICT" | "TURNREWIND_EXPIRED" | "TURNREWIND_TURN_ACTIVE"
                | "TURNREWIND_ALREADY_UNDONE" | "TURNREWIND_GIT_REQUIRED"
                | "TURNREWIND_UNSAFE_PATH" | "TURNREWIND_NON_EMPTY_DIR", conflicts: [...] }
  → 403 / 404 / 400
```

`skippedOversized` / `skippedNestedRepos` 每条记录最多回传 20 个路径（载荷有界），
卡片按**数量**呈现、路径放 `title`；未知的原因码在客户端**原样显示**（不吞掉、不编文案）。

变更路由仅接受回环调用；连接信任边界经可选的 `connection` 服务校验（缺席时降级为回环校验）。

## 内核适配（0.1.5-rc.1 / 0.1.2-rc.1）

两个内核都提供了本插件依赖的全部契约（`agent/pre-step`、`agent/turn-stopping`、
`agent/status`、`ctx.sessions` + `session.header.cwd`、`session/event` 的 `turn/end`、
`webServer.register({ kind: 'exact' })`、`conversation.chat.turnTail` chain 槽、
`conversation.input.dock` list 槽、locale 的两种 `register` 重载）。

硬约束：**client 侧不静态引用任何 `@deepseek-ai/*` 包**。client bundle 在 dsh Web
ModuleLoader 的 factory 里运行，模块表只认识当前内核实际装载的模块；引用了另一个内核代
里不存在的 specifier 会让 loader 整棵树失败（界面白屏）。宿主侧 `inject` 也只声明两个
内核都存在的 `webServer` / `sessions` / `agents`。

运行中提示条不依赖 `InputZone.session` 的字段形状：**「是否在跑」由宿主 live 路由回答**，
owner 份额里读到 `running: false` 时既提前停轮询、也立刻整条隐藏（字段缺失按「可能在跑」处理），
因此内核调整会话快照字段也不会让提示条失效。会话结束后只剩 turn 尾部的变更卡片。

### 「打开文件」的内核差异（本轮新增的唯一一处行为分流）

`conversation.chat.turnTail` 的 owner props 在**两个内核上都**带 `openFile`，但语义不同：

| 内核 | `openFile(path)` 实际做的事 | 本插件的行为 |
|---|---|---|
| `0.1.5-rc.1` | `ctx.sidebarRight.openResource(fileAddress(sessionId, cwd, path))` —— 应用内右侧边栏文本预览页签 | **调用它**（同官方 `producedChip`） |
| `0.1.2-rc.1` | `ctx.remote.session.openWorkspacePath({ path })` —— 交给宿主/系统打开该路径 | **不调用**（静默，渲染成不可点元素） |

判据因此不是「有没有 `openFile`」，也不是版本号，而是**有没有 `sidebarRight` 服务**
（新内核由 `dsh-client-ui-sidebar-right` 经 `ctx.reflect.provide('sidebarRight', …)` 发布；
旧内核连这个包都没有）。探测在**点击那一刻**做——`sidebarRight` 由另一个客户端插件发布，
apply 顺序不保证它已就位；探测方式是 `ctx.reflect.get('sidebarRight')`（cordis 的 reflect
直接查注册表，不受 inject 守卫限制），因此本插件**不把 `sidebarRight` 写进 `inject`**：
声明式依赖会让旧内核上的插件加载直接失败。内核再漂移也只是退化成「不可点」，不会误开系统程序。

## 开发

```powershell
pnpm --filter dsh-tauri-turnrewind typecheck
pnpm --filter dsh-tauri-turnrewind build
pnpm vitest run packages/dsh-tauri-turnrewind
pnpm build            # 根构建：prebuild 部署插件到 src-tauri/resources/node_modules
```

测试覆盖：工作区资格与路径守卫、快照增删改与二进制、**用户仓库零污染**、
CRLF/属性往返对称（恢复后与 before 快照树逐字节等价）、冲突预检（含「用户重建已删除文件」）、
撤销全路径（含代数不符 / refs 消失 → 过期终态、轮次仍在跑 → 拒绝）、
运行中实时读数（含本轮新建文件，且与最终 after 差异文件数一致）、
**捕获与结算的时序**（正常一轮落账；`turn/end` / idle 落在 before 快照还在飞时这一轮仍被结算；
两个事件同时到达只结算一次；idle 之后新开始的一轮不被兜底误结算；没有 before 快照的 turn 不会被凭空记一笔）、
被 `.gitignore` 忽略的排除路径不会让捕获整体失败、捕获限额（超限排除重试、嵌套仓库自动跳过与报错兜底）、
容量治理（prune 只清不可达对象、超限整仓重建 + 代数轮换、排除清单复检、不碰用户仓库）、
工作区队列（FIFO 不重叠 / 跨工作区不阻塞 / 队尾出队）、
账本原子写与保留淘汰、卡片状态机与计数/文件名/原因码/重试退避纯函数、
**打开文件的内核能力判据**（无 `sidebarRight` 时绝不调用 `openFile`；同步抛错 / rejected
promise 都静默；disposer 清理）、
卡片与提示条的 css-render 形态（hover 换行、配色、几何、提示行分级、按钮基座且无新增 hover）。
