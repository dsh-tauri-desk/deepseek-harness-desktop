# dsh-tauri-worktree

`dsh-tauri-worktree` 为 DSH 会话提供 Git worktree 隔离。每个工作树会话拥有独立目录，Agent 可以安全地修改代码，而不会影响本地主工作区。

![dsh-tauri-worktree 工作流](public/worktree.png)

## 功能

- 按项目路径和会话 ID 创建稳定、可复用的隔离工作树。
- 新建工作树自动把源仓库的依赖目录（默认 `node_modules`）链接进来，开箱即用；执行安装命令前自动断开链接，使安装在工作树内物化成一份独立依赖。
- 注册 `create_worktree`、`checkout_worktree` 工具。
- `create_worktree` / `checkout_worktree` 支持可选 `carry_staged` 参数（默认 `false`）：把已暂存（index）改动携带进新工作树、或携带回本地检出，避免暂存内容在隔离/移除工作树时丢失。
- 提供创建、状态、检出和放弃 API：`/api/dsh-worktree/*`。
- 将工作树状态注入系统提示：`is_worktree: true`。
- 检出时创建或切换本地分支，并带回完整会话历史。
- 放弃工作树时清理临时分支和 ledger 记录。

## 携带暂存（carry_staged）

git worktree 的 index 与暂存状态是每个工作树私有的：`git worktree add` 始终从本地 `main` 分支干净检出，
未提交改动不会跟随；移除工作树时未提交改动也随之删除。为避免「有暂存时创建/检出工作树
导致内容丢失」，两个工具都提供开关：

```ts
// 创建时把源仓库已暂存改动带入新工作树（不携带未暂存/未跟踪改动）
create_worktree({ branch_name: 'dsh/feature-xyz', carry_staged: true })

// 检出时把工作树已暂存改动带回本地分支，再移除工作树
checkout_worktree({ worktree_hash_dirname: '[hash]/[dirname]', branch_name: 'dsh/feature-xyz', carry_staged: true })
```

语义说明：

- `carry_staged` 只移动「已暂存（index）」状态：修改、新增、删除的暂存条目会在目标目录
  重建为同样的暂存状态（文件内容同步到 index，`git status` 分布一致）。
- 未暂存与未跟踪改动按 git worktree 的设计不携带：创建时留在源仓库，检出时随工作树移除。
- 实现基于 `git diff --cached --binary` + `git apply --cached`，只触碰补丁涉及的路径，
  不使用仓库级共享的 `git stash`，避免跨 worktree 污染 stash 列表或覆盖目标目录无关改动。
- 创建时始终以本地 `refs/heads/main` 为内容来源；若该分支不存在或无法解析，创建会在执行 worktree 操作前明确失败。
- 创建时携带失败会回滚刚创建的工作树；检出时携带失败会回滚到检出前分支并保留工作树。

## 依赖目录自动链接（安装后独立）

`git worktree add` 只检出 tracked 文件，`node_modules` 等被 gitignore 的依赖目录不会跟随。
每次都完整安装代价高，因此新建工作树时默认把**源仓库的依赖目录以目录联接挂进工作树**
（Windows junction / POSIX 目录符号链接），工作树开箱即用。

链接是共享的：包管理器若直接写入会穿透链接污染源仓库 —— pnpm 还会把源仓库的 workspace
链接改写成指向工作树，工作树删除后留下一批悬空链接（
[pnpm#14286](https://github.com/pnpm/pnpm/issues/14286)）。因此插件在 `tools/execute`
钩子里检测到安装类命令（`pnpm/npm/yarn/bun install|add|ci…`、`pip/uv/poetry`、`cargo`、
`go mod`、`bundle`、`composer` 等）时，会**先摘掉工作树内的链接**，让这次安装在
工作树内物化成一份独立目录，源仓库不受影响。

- 断开只删链接本身，绝不递归链接目标；已独立安装的真实目录原样保留。
- 放弃/检出删除工作树前同样先断开链接，确保 `fs.rm` 不会进入源仓库。
- 链接失败（权限/占用/跨卷）只记录日志，不阻断工作树创建；此时按提示自行安装即可。
- 链接目录可配置：`linkDependencies`（默认 `true`）与 `linkDependencyDirectories`
  （默认 `['node_modules']`）。

## 可靠删除（junction 安全）

放弃/检出会移除工作树目录。Git for Windows 旧版本递归删除时会跟随 NTFS junction，
误删 junction 目标内容，因此磁盘删除绝不交给 Git：

1. （可选）先终止仍以工作树为 cwd 的进程：宿主把该能力注册为 ctx 服务后，插件经
   `ctx.get('worktreeProcessController')` 探测并按「探测后调用」约定读取
   `stopSessionProcesses`；未注册即跳过（公共 DSH API 暂无按会话停止进程的能力）。
   注意宿主 ctx 是 cordis 代理，未注入的属性直接读取会抛
   `cannot get property ... without inject`，因此探测失败或控制器异常都不会中断删除。
2. 目录重命名到同卷 `<worktreesRoot>/.trash/[hash]/[dirname]` 后用
   `fs.rm({ recursive, force, maxRetries: 10, retryDelay: 100 })` 删除；重命名失败
   （跨卷/句柄占用）时退回直接 `fs.rm`，外层再重试 3 次（间隔 2s）。
3. 目录删除后顺带移除因此变空的 `worktrees/[hash]` 与 `.trash/[hash]` 容器目录
   （`rmdir` 仅对空目录生效，非空/不存在时静默跳过），避免每次放弃/检出都在
   `<worktreesRoot>` 下残留一个空 `<hash>` 文件夹；收尾为尽力而为，失败不影响删除结果。
4. `git worktree prune --expire now` 只清理 Git 管理记录；之后才删除本插件拥有的
   `dsh/*` 分支。任一步失败都会保留绑定（ledger），可通过再次放弃/重试收敛。
5. 残留状态收敛：目录-only（中断遗留）在 `ensureWorktree` 重建前被 fs 删除；管理记录-only
   在创建前被 prune；两者共存时拒绝覆盖已注册但缺少绑定的完整工作树。

## 异步放弃（discard job）

- `POST /discard` 立即返回 `{ ok, jobId }`，后台执行删除；同一会话/工作树的重复请求去重。
- `GET /status` 在删除期间返回 `mode: 'deleting'`、失败返回 `mode: 'failed'`（含 error 与
  worktreeKey/path），完成后回落到常规 status 语义。
- 客户端乐观标记 `deleting` 并轮询直至收敛；归档会话的清理在请求失败/任务失败时清除
  去重标记，等待下次快照重试。

## 状态复核节流与请求模型

客户端的 hydration 请求分三级，目标是**请求量与会话数、事件数都解耦**：

1. **批量发现**：列表快照/启动时一次 `GET /bindings`（经节流器 + 在途去重）拿到全部工作树
   绑定与未收敛的删除任务。**绝不为列表里每个会话各打一次 `/status`** —— 那是首次加载
   几百次请求的来源（实测某 profile 400 个会话）。只有会话集合真的变化（新增/移除）才重新
   同步，纯状态变化（running/标题）不触发。
2. **当前会话校准**：模式选择器只在当前会话渲染，只有它需要确定 `isGit`，因此切换会话时为
   它打一次 `/status`（每个会话最多一次，结果缓存在 store）。工作树会话的 `isGit` 恒为
   `true`（由绑定得出），无需请求。
3. **回合结束复核**：工作树会话在 `running: true → false` 边沿复核一次，用于收敛 Agent 的
   `checkout_worktree` / `discard_worktree` —— **一个回合一次请求**，而不是逐事件一次。
   核心版本拿不到 `running` 位时退回「自身事件驱动 + 节流」，功能不退化。

上述所有路径（含 discard 任务轮询收敛）最终都经同一个 per-session 节流器
（`SESSION_RECONCILE_MIN_INTERVAL_MS`，默认 1200ms：窗口内首次立即执行，其余合并为窗口
末尾的一次拖尾执行），因此不存在任何绕过节流窗口的请求入口。

**「宿主解析不出」（`isGit: null`）的重试必须有界**：这类会话可能是启动/新建竞态，也可能是
**永久**的（会话列表里长期存在宿主已不再持有的历史会话；实测某 profile 83 个会话中有 77 个
永远解析不出）。重试因此同时受三重约束——只在会话出现后的 `HYDRATION_RETRY_WINDOW_MS`
（默认 10s）内、受全局 `HYDRATION_RETRY_BUDGET_PER_SECOND`（默认 8 次/秒，所有未解析会话
共享）、以及单会话次数上限；顺延同样计入次数，重试链必然终止（用例断言窗口过后
`setTimeout` 残留为 0）。任一约束耗尽即永久退出复核，用户切回该会话时再重新校准一次。

宿主侧 `/status` 对已绑定工作树的会话直接判定 `isGit: true`（工作树由 `git worktree add`
创建，必然在 Git 仓库内），不再为每次复核 fork 一个 `git rev-parse` 子进程。

## 归档会话：不参与任何检测

归档（侧栏隐藏）的会话**完全退出检测**：不查 `/status`、不扫绑定、不挂会话事件订阅、不因归档
集合反复快照而重放。

历史实现对这个集合里的**每个** archivedSessionId 都打一次 `/status`（挂载时 + 每次工作区
快照），且失败时会话会被移出 `cleanedArchives` 导致下次快照再打一次（无界）；清理后还会用
500ms 间隔轮询最多 120 次。归档集合里那些宿主已不再持有的历史会话（`/status` 永久返回
`isGit: null`）会把它放大成几十上百次请求。

现在唯一的请求是：用户**本次点击归档**、且本端 store 已知该会话是工作树会话时，发一次
fire-and-forget 的 `discard`（删除由宿主后台完成；归档会话没有 UI 需要收敛，因此不轮询、
不重试、失败不重放）。绝大多数归档会话（无工作树）零请求；启动时即便是「归档且持有工作树」
的会话也**不做任何探测**（其工作树保留在磁盘上，需要时由用户显式放弃）。

## API

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/dsh-worktree/bindings` | 批量绑定视图：全部工作树绑定 + 未收敛删除任务（hydration 入口） |
| GET | `/api/dsh-worktree/status` | 单个会话的状态（当前会话 `isGit` 校准、回合结束复核、job 进度） |
| POST | `/api/dsh-worktree/create` | 为预分配的新会话创建工作树 |
| POST | `/api/dsh-worktree/attach` | 把工作树会话归属到源项目 Workspace |
| POST | `/api/dsh-worktree/checkout` | 检出本地并带回会话历史 |
| POST | `/api/dsh-worktree/discard` | 放弃更改（异步 job） |

## 用户流程

1. 用户明确要求使用 worktree 后，Agent 调用 `create_worktree`。
2. 插件创建 `~/.dsh/worktrees/[hash]/[dirname]`，并把会话交接到新工作树。
3. 在工作树会话中修改、测试和提交代码。
4. 用户明确请求或批准后，才能调用 `checkout_worktree`；该操作会把改动带回本地分支并移除工作树。
5. 如果不需要保留改动，可从面板执行放弃操作。

> `checkout_worktree` 是用户授权操作。任务完成、PR 合并或 Agent 的便利性都不能代替用户授权。

## 要求

- 项目目录必须是 Git 仓库。
- 宿主环境需要可执行的 `git`。
- 插件需要 DSH 的 tools、systemPrompt、webServer、sessions、workspaceRegistry 和 agents 服务。

## 许可证

[MIT](../../LICENSE.md) © [Hairyf](https://github.com/hairyf)
