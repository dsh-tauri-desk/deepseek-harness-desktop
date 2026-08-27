# `dsh-tauri-turnrewind` 架构设计

## 1. 目标与边界

`dsh-tauri-turnrewind` 是一个独立的 DSH 插件：为一次 Agent 对话回合（turn）建立可恢复的文件基线，并允许用户通过 `/undo` 或消息旁的 Undo 操作，把该回合造成的工作区修改撤销。

它服务于「代码改得不好，撤销这一轮对话写入的文件」这一场景，不等同于：

- 仅删除/隐藏聊天消息；
- Git 的 `reset`、`revert` 或提交历史管理；
- 恢复任意时刻的完整工作区备份；
- 撤销用户在 DSH 之外手动修改的内容。

插件必须同时支持：

1. **单回合撤销**：撤销选中的一次对话回合及其直接文件影响。
2. **分支撤销**：选中父对话回合时，递归撤销该回合和该节点以下所有子回合的文件影响。
3. **安全撤销**：撤销前检测文件是否已被后来回合、用户或外部程序改动；不静默覆盖有冲突的文件。
4. **可恢复撤销**：执行 undo 前先生成一个反向恢复点，使后续可以实现 redo，且用户误操作不会立即不可逆。
5. **本地优先**：账本和文件内容只保存到本机用户数据目录，不上传远端。

## 2. 方案选择

### 2.1 独立插件，而非 `dsh-tauri-ui` 的内置逻辑

| 模块 | 应负责的内容 | 不应负责的内容 |
| --- | --- | --- |
| `dsh-tauri-turnrewind` | turn 生命周期、快照账本、文件恢复、冲突检测、`/undo`、Undo UI | 桌面壳通用导航与无关 UI |
| `dsh-tauri-ui` | 可选：提供稳定的桌面风格容器/样式约定 | 文件快照、会话回滚业务规则 |
| `dsh-tauri` | Tauri bridge 的通用通信能力 | 回滚策略和账本模型 |
| Desktop Rust shell | 只在插件确实需要受控文件系统能力时提供窄桥接 | 直接承担每个插件的业务状态 |

核心逻辑应独立发布为 `dsh-tauri-turnrewind`。这样它可单独升级、测试、启停，也不会把长期文件恢复能力耦合到壳层 UI 插件中。

### 2.2 Host / Client 划分

```text
┌─────────────────────────────────────────────────────────────────┐
│ Client（浏览器）                                                 │
│  - `/undo` 输入命令解析/提示                                    │
│  - 每个 Agent turn 的 Undo 按钮                                 │
│  - 子树撤销确认框、冲突列表、结果卡片                           │
│  - 调用 Package-private Host RPC                                │
└───────────────────────────────┬─────────────────────────────────┘
                                │ JSON RPC
┌───────────────────────────────▼─────────────────────────────────┐
│ Host（DSH Node 进程）                                            │
│  - 监听真实 turn 生命周期                                       │
│  - 文件变更检测、私有 Git 快照、持久账本                        │
│  - 会话/分支关系查询与撤销计划计算                              │
│  - 文件恢复、冲突检测、审计                                     │
│  - 可选：注册 `undo_turn` Agent Tool                            │
└───────────────────────────────┬─────────────────────────────────┘
                                │ 受限文件读写能力
┌───────────────────────────────▼─────────────────────────────────┐
│ Workspace                                                         │
│  - 本地工作区或 dsh-tauri-worktree 创建的隔离 worktree           │
└─────────────────────────────────────────────────────────────────┘
```

文件和会话生命周期属于 Host；消息操作和交互属于 Client。Client 不保存快照，也不自行决定可恢复的文件内容。

实际开发前必须通过 Cordis Inspect 查询当前版本的：

- 会话、对话节点和分支关系的真实 Service/Event 契约；
- turn 发送、完成、失败、取消的生命周期事件；
- 文件工具、workspace、sandbox 的实际边界；
- 消息 action / turn tail / 输入区命令的 Slot 契约；
- 可用的 Host 文件系统或 Tauri bridge API。

本文定义架构和语义，不假定这些上游接口的具体名称。

## 3. 核心概念

### 3.1 Turn

一个 turn 从用户消息提交开始，到 Agent 的工具调用、文件修改、最终响应完成/失败/取消为止。每个可撤销 turn 至少关联：

- `sessionId`：所在会话；
- `turnId`：稳定的对话/响应节点标识；
- `parentTurnId`：父节点；
- `workspaceKey`：规范化后的工作区身份；
- `startedAt`、`settledAt`；
- `status`：`active`、`settled`、`failed`、`cancelled`、`undone`、`superseded`；
- `touchedPaths`：该 turn 真正改动过的相对路径；
- `preimage`：每个受影响路径在 turn 开始前的状态；
- `postimage`：每个受影响路径在 turn 结束后的状态。

一个没有改动文件的 turn 仍可显示为「无文件修改」，但 Undo 操作应禁用或明确反馈无可恢复内容。

### 3.2 工作区身份

`workspaceKey` 不能仅由显示路径构成。它至少包含：

```json
{
  "canonicalPath": "规范化后的绝对路径",
  "kind": "local | worktree",
  "sourceWorkspaceKey": "worktree 时关联源项目，可选",
  "sessionId": "worktree 时用于隔离，可选"
}
```

本地工作区与 `dsh-tauri-worktree` worktree 必须被视为不同恢复域；不得跨目录恢复文件。worktree 被检出回本地或放弃后，关联账本保留为历史记录，但原 worktree 路径不可继续执行恢复。

### 3.3 文件状态（FileState）

每个路径的状态必须表达「文件存在性」而不只是内容：

```json
{
  "path": "相对于 workspace 的 POSIX 路径",
  "kind": "file | directory | symlink | absent",
  "gitRef": "私有快照仓库中的 tree/blob 引用；仅普通文件需要 blob",
  "mode": 0,
  "linkTarget": "仅符号链接需要",
  "digest": "工作区状态摘要"
}
```

因此能正确处理：

- 修改既有文件；
- 新建文件（undo 时删除）；
- 删除文件（undo 时恢复）；
- 空文件；
- 文件权限变化；
- 符号链接。

首个版本应明确限制：超大文件、特殊设备文件、不可读文件、目录级重命名与二进制文件的支持策略。不能可靠保存的路径必须出现在 turn 结果和 undo 预检中，不能静默跳过。

## 4. 持久化设计

### 4.1 数据目录

插件私有数据放在 DSH 用户目录下的稳定位置，例如：

```text
$DSH_HOME/turnrewind/
├─ snapshots/
│  └─ <workspace-hash>.git   # 插件私有 Git 快照仓库
├─ ledger.sqlite             # turn、路径和操作审计账本
├─ indexes/
│  └─ <workspace-hash>.json  # 可重建的工作区扫描索引
├─ locks/
│  └─ <workspace-hash>.lock  # 每个恢复域的独占锁
└─ quarantine/               # 可选：撤销前额外保存的冲突文件
```

私有 Git 仓库和账本都必须位于 `$DSH_HOME`，不可写入用户项目的 Git 工作树，也不可让内部快照出现在用户当前分支中。

### 4.2 私有 Git 快照仓库

对于每个 `workspaceKey`，插件在 `$DSH_HOME/turnrewind/snapshots/<workspace-hash>.git` 维护一个独立 Git 仓库。它只保存工作区文件快照，不改变用户项目仓库的 `HEAD`、当前分支、index、stash 或提交历史。

每个 turn 对应一个内部快照引用或合成提交：

```text
refs/turnrewind/<turn-id>  →  Git tree / commit
```

Git 负责 blob/tree 的内容寻址、去重、压缩和读取历史版本；SQLite 仍是 turn 与快照的权威映射，负责保存 `sessionId`、父子关系、路径清单、状态和 undo 操作记录。恢复时按路径从私有快照读取内容，再写回用户工作区，禁止使用 `git reset --hard`、`git checkout .` 或 `git clean -fd`。

快照提交流程必须是：扫描工作区 → 将允许路径导入私有仓库 → 写入/校验 Git tree 或 commit → 原子提交 SQLite 事务。Git 快照引用不存在或内容读取失败时，该 turn 不得标记为可撤销。

Git 仓库只是内部存储，不等于用户项目的版本历史；插件不能执行会改变用户项目工作区状态的 Git 命令。

### 4.3 账本与事务

账本首版使用 SQLite，原因是需要按 `sessionId`、`turnId`、父子关系和路径高效查询，并需要原子事务。Git snapshot ref 保存文件版本，SQLite 保存 turn 语义与操作状态；两者必须在可恢复的提交流程中保持一致。

一个 snapshot ref 逻辑上代表该 turn 结算后的完整允许路径树，但不要求每个 turn 重新复制所有文件：首个恢复域建立基线树，后续 turn 基于上一 snapshot tree 只替换变化路径对应的 blob/tree 项，再生成新的 Git tree/commit。这样既能按任意 turn 读取路径状态，也能保持每轮增量写入。

建议的逻辑表：

```text
workspaces(workspace_key, canonical_path, kind, status, created_at)
turns(turn_id, session_id, parent_turn_id, workspace_key, status,
      started_at, settled_at, agent_message_id, reversible, note)
turn_paths(turn_id, path, pre_state_json, post_state_json, capture_state)
operations(operation_id, kind, target_turn_id, requested_at, settled_at,
           outcome, before_restore_ref, actor)
operation_paths(operation_id, path, expected_current_digest,
                actual_current_digest, resolution, result)
```

账本永远记录事实，不把 `undone` 理解为删除历史：

- `turns.status = undone` 表明该 turn 当前已被恢复掉；
- 新的 Agent 改动会形成后续 turn，绝不覆写旧 turn；
- `operations` 保存每次预检、确认、冲突处理和结果，供 redo、诊断和审计使用。

### 4.4 保留策略

内容备份可能变大，因此需有配置与可见状态：

- 默认最大存储容量；
- 默认保留天数；
- 最少保留最近 N 个可恢复 turn；
- 清理前不删除仍被任何非过期 turn 引用的 Git snapshot/ref；
- 清理不可恢复旧记录时，保留元数据并将其标为 `expired`；
- 清理 Git 对象前必须确认没有任何 turn、operation 或 redo 引用；
- 存储空间不足时，不建立「看似可撤销但快照缺失」的记录；本 turn 必须标记为不可撤销并告知用户。

## 5. 变更捕获策略

### 5.1 推荐：工具边界捕获 + 结算校验

只靠文件监视器会误记用户手动编辑和其他进程的变化；只靠 Agent 工具返回值又会漏掉命令、脚本、Git 操作的间接改动。首选组合是：

1. **Turn 开始**：登记活动 turn 与工作区基线观测点。
2. **已知写入工具前**：捕获其声明/推导出的候选路径的 preimage。
3. **已知写入工具后**：读取候选路径，记录 postimage 与实际改动。
4. **Turn 结算**：对工作区运行受控差异扫描，补齐 shell、测试脚本、Git、格式化器等间接产生的修改。
5. **Turn 完成**：将变化后的工作区状态导入该 workspace 的私有 Git 快照仓库，并将 snapshot ref、路径集合和状态在单一账本事务中提交。

差异扫描优先使用 Git 的受限路径状态能力（若工作区是 Git 仓库），但不能依赖用户项目 Git：非 Git 目录仍须通过目录索引完成扫描，快照照样写入插件自己的私有 Git 仓库。

### 5.2 首版性能约束

不在每个 turn 无条件复制整个工作区。采用「目录清单 + 受影响路径导入私有 Git 快照」：

- 开始时捕获可比较的路径索引（路径、类型、mtime、大小、可选 hash）；
- 结算时重新扫描并比对索引；
- 仅将真实变化的路径导入私有 Git 快照仓库，由 Git 负责 blob/tree 去重；
- 新增/删除路径也生成 FileState，并记录对应的 Git tree/blob 状态。

对大型仓库，扫描要：

- 跳过 `.git`、`node_modules`、构建产物和用户配置的排除路径；
- 利用 Git 状态或增量目录索引缩小范围；
- 在界面显示「正在整理可撤销改动」，而不是阻塞或伪造完成状态。

若扫描失败、被取消或有未授权路径，turn 必须标记 `reversible = false` 或 `partiallyReversible = true`，并附带明确原因。

## 6. 撤销语义

### 6.1 默认单回合 Undo

对目标 turn `T`：

1. 目标路径集合为 `T.touchedPaths`；
2. 每个路径的目标状态为 `T.preimage[path]`；
3. 当前文件状态必须仍与 `T.postimage[path]` 匹配，才属于无冲突可自动恢复；
4. 恢复后标记 `T` 为 `undone`，写入一次 `undo` operation；
5. 撤销前的当前状态写成反向恢复点。

这确保「撤销 T」只影响 T 实际触及的文件，并不会直接整体还原工作区。

### 6.2 递归分支 Undo

对用户点击的父节点 `P`，撤销集合是同一恢复域内以 `P` 为根、尚未撤销的对话子树：

```text
P
├─ A
│  └─ B
└─ C
```

撤销顺序固定为**后序（叶子到根）**：`B → A → C → P`。这样对同一路径，最终落盘内容是 P 开始前的状态。

重要限制：只遍历真实的会话树后代，不通过时间范围猜测「后来发生的全部 turn」。同一工作区中的其他会话、其他分支或用户手动变更不属于该撤销集合，必须作为外部状态处理。

### 6.3 重叠文件与基线选择

如果父子 turn 都修改 `src/a.ts`：

```text
P.pre = v1, P.post = v2
A.pre = v2, A.post = v3
B.pre = v3, B.post = v4
```

撤销 `P` 子树后，`src/a.ts` 的目标是 `v1`，而不是依次盲写每个状态。计划器应先按路径聚合：

- 目标状态 = 撤销集合中最早祖先对该路径的 `preimage`；
- 期望当前状态 = 撤销集合中最后叶子对该路径的 `postimage`；
- 执行时每路径只写一次。

这避免多次写入、减少中间失败状态，并让预检结果可解释。

## 7. 冲突与安全模型

### 7.1 冲突定义

对于撤销计划中的路径，若磁盘当前状态不等于该路径的 `expectedCurrentState`，就不能默认覆盖。常见原因：

- 用户在 Agent 完成后手动编辑；
- 同一工作区的其他会话修改；
- 外部编辑器、watcher 或格式化器修改；
- 目标子树以外的后继 turn 改写同一文件；
- 文件被移动、删除或权限变化。

### 7.2 三段式流程

Undo 必须分为：

1. **预检（plan）**：只读计算目标 turn、路径集合、目标状态和冲突；
2. **确认（confirm）**：Client 展示摘要；无冲突可一键继续，有冲突必须显式选择；
3. **执行（apply）**：重新验证预检版本/磁盘摘要后，再在 workspace 独占锁内写入。

预检返回的数据应只包含所需叶子信息：

```json
{
  "targetTurnId": "...",
  "scope": "single | subtree",
  "turnCount": 3,
  "summary": { "modified": 4, "created": 1, "deleted": 2 },
  "conflicts": [
    {
      "path": "src/a.ts",
      "reason": "current-state-differs",
      "expectedDigest": "...",
      "actualDigest": "..."
    }
  ],
  "planVersion": "opaque-token"
}
```

### 7.3 冲突决议

首版支持：

- **取消**：不写任何文件；
- **仅恢复无冲突文件**：需要明确显示哪些路径未恢复；
- **强制恢复冲突文件**：危险操作，必须二次确认；执行前把当前内容写入反向恢复点/`quarantine`。

首版不做自动三方合并。自动合并应在后续版本单独设计，因为文本合并、二进制文件、删除与重命名需要不同语义。

### 7.4 原子性与故障恢复

文件系统跨多路径不能真正全局原子，因此采用「尽量全成或可恢复」策略：

1. 获取 workspace 锁；
2. 再次验证 `planVersion` 和当前摘要；
3. 为所有将要覆盖/删除的路径先写入撤销前状态的私有 Git snapshot，并记录 operation 引用；
4. 写入临时文件并原子替换，删除移入受控临时区；
5. 所有路径成功后，在一次账本事务中记录 operation 和 turn 状态；
6. 任一步失败，利用撤销前 snapshot 回滚已经写入的路径，并记录 `partial_failure`。

恢复操作被外部编辑器打断时，应停止并报告，不继续覆盖未知状态。

## 8. 用户入口与交互

### 8.1 `/undo` 命令

输入区识别本地命令，不把控制指令发送给模型：

```text
/undo                 # 当前会话最新可撤销 turn
/undo <turn-id>       # 指定 turn
/undo --subtree <id>  # 指定父节点及子树
/undo --dry-run ...   # 只显示计划
```

若 DSH 的输入架构不支持 Client 本地拦截，则由 Host 注册一个窄 `undo_turn` 工具或命令服务，并在 system prompt 中说明它只用于用户明确发出的撤销请求。不可让 Agent 自主调用 undo。

### 8.2 消息旁 Undo

Agent 完成的 turn 在复制按钮附近增加二级操作：

- 单一叶子 turn：`撤销本次修改`；
- 有子对话的父节点：`撤销此分支修改…`；
- 无文件改动/不可恢复/已撤销：按钮禁用并展示原因。

点击父节点时，确认框必须说明：

```text
将撤销此节点及其 4 个后续子回合的文件修改。
涉及 8 个文件：修改 5、新建 2、恢复删除 1。
```

### 8.3 结果呈现

执行完成后在目标 turn 下显示紧凑结果卡：

```text
已撤销 3 个回合的改动
恢复 4 个文件、删除 1 个新建文件；0 个冲突
[查看详情] [恢复此撤销（Redo）]
```

部分成功时必须标为警告而非成功，并列出未恢复路径和原因。

## 9. Git 快照与 Worktree 的关系

### 9.1 Git 的职责

Git 是推荐的底层快照引擎，但不是 turn 账本，也不是用户项目的控制器。私有 Git 快照仓库负责：

- 保存文件内容、目录树、文件模式和必要的符号链接信息；
- 通过 blob/tree 的内容寻址实现去重与压缩；
- 提供路径读取、版本比较和 diff 能力；
- 为每个 turn 提供稳定的内部 snapshot ref。

SQLite 账本负责：

- `turnId` 与 snapshot ref 的映射；
- session、parent/child 对话树；
- workspace 恢复域；
- touched paths、可恢复性、undo/redo operation 和审计。

这两个层次不能互相替代：没有 Git 快照无法恢复文件，没有 turn 账本无法理解「撤销哪一次对话」。

### 9.2 严禁污染用户项目仓库

首选实现是在 `$DSH_HOME/turnrewind/snapshots/<workspace-hash>.git` 使用插件自己的私有仓库。对于用户项目仓库：

- 不执行 `git reset --hard`、`git checkout .`、`git clean -fd`；
- 不移动用户 `HEAD`，不切换当前分支；
- 不改写用户 index、stash、config 或提交历史；
- 不把内部 snapshot commit 放进用户当前分支；
- 不因 turn rewind 自动创建用户可见的业务提交。

如果未来为了性能考虑使用用户仓库的 object database 或隐藏 ref，也必须显式隔离并通过专门设计评审；它不是首版方案。

### 9.3 非 Git 工作区

用户项目没有 Git 时，仍通过目录索引发现变化，并把文件导入插件私有 Git 仓库。因此「不依赖 Git」的含义是**不依赖用户项目存在 Git**，而不是完全不使用 Git 实现快照。

### 9.4 与 `dsh-tauri-worktree` 集成

`dsh-tauri-worktree` 提供隔离目录；`dsh-tauri-turnrewind` 对该目录创建独立的 `workspaceKey` 和私有 Git 快照仓库。

- 在 worktree 内 undo：只修改该 worktree，不影响源工作区；
- worktree 放弃后：保留审计记录但禁用恢复；
- worktree 检出/合并回本地后：默认不自动迁移 snapshot ref，因为路径、Git 状态与用户手工合并结果可能已不同；后续可增加显式迁移向导；
- 不跨 local/worktree 恢复，即使二者来自同一 Git 仓库。

## 10. 权限与并发

### 10.1 权限

只允许读写当前 turn 所绑定、已授权的 workspace 根目录。拒绝：

- 路径逃逸（`..`、符号链接逃逸等）；
- workspace 外绝对路径；
- 未经确认的危险覆盖；
- 回滚 Agent 未创建的其他恢复域。

若 Host 需要文件系统能力，必须沿用 DSH 宿主的 sandbox/approval 语义，不能由插件绕过。任何 Tauri bridge 也必须是窄接口：以 workspace 相对路径和已签发的恢复计划令牌为输入，而不是暴露任意路径读写。

### 10.2 并发

同一 workspaceKey 在以下时刻需独占：

- turn 的最终变更扫描和账本提交；
- undo/redo 的预检确认到执行；
- 垃圾回收中删除私有 Git snapshot/ref 引用。

不同 workspaceKey 可并行。若另一个 Agent turn 正在该工作区写入，Undo UI 应显示「等待当前回合完成」或拒绝执行，不能与写入同时进行。

## 11. 组件与接口

```text
plugins/dsh-tauri-turnrewind/
├─ package.json
├─ cordis.patch.yml
├─ lib/
│  ├─ index.js                 # 当前 Host composition 原型
│  └─ core/
│     ├─ git-snapshot.js       # 私有 Git 快照与受限恢复
│     ├─ ledger.js             # SQLite turn/operation 账本
│     └─ planner.js            # 计划与冲突分类纯函数
├─ test/
│  ├─ planner.test.js        # 已有：子树顺序、路径聚合、冲突分类
│  ├─ git-snapshot.test.js   # 已有：Git 快照、增删改恢复、路径逃逸
│  ├─ ledger.test.js         # 已有：账本持久化与 active 恢复
│  └─ lifecycle.test.js      # 待补：真实 DSH 事件与命令集成
└─ README.md
```

Client 到 Host 的 RPC 仅暴露：

```text
turnrewind.status(turnId)
turnrewind.plan({ turnId, scope })
turnrewind.apply({ planVersion, conflictPolicy })
turnrewind.redo({ operationId })
```

`planVersion` 是一次性、带 workspace/turn/摘要绑定的 opaque token。Client 不传文件内容、绝对路径或自行计算的恢复目标。

## 12. 状态机

```text
Turn:
  active
    ├─ settled       # 已扫描并可恢复
    ├─ partial       # 扫描/权限缺失，部分可恢复
    ├─ failed        # Agent/工具失败，仍可在可确认时恢复
    └─ cancelled     # 取消，仍进行最佳努力结算

Undo operation:
  planned → confirmed → applying → applied
                    └→ cancelled
                    └→ conflicted
                    └→ partial_failure

Applied undo:
  redo_available → redone | redo_expired
```

Agent 文本回复成功不是「可撤销」的判断标准；只有结算扫描和账本提交成功才是。

## 13. 分阶段交付

### Phase 0：契约调研与技术验证

- 用 Cordis Inspect 确认 turn/session/tree/Slot/file API；
- 验证能可靠拿到用户消息节点、Agent 完成节点、父子关系；
- 验证 Host 在宿主 sandbox 内可对授权 workspace 做最小读写；
- 为本地 Git、非 Git、worktree 三类目录制作探针。

**退出条件**：形成真实 API 对照表，明确哪些能力是插件直接获得、哪些要由 `dsh-tauri` 补充桥接。

### Phase 1：Host MVP（单回合、无冲突）

- 单 workspace；
- turn 结束后扫描并保存变更路径；
- 单个叶子 turn 的 dry-run 与无冲突恢复；
- SQLite 账本、私有 Git 快照、操作审计；
- CLI/Tool 入口，无 Client 消息按钮。

**退出条件**：修改/新增/删除文件均可被稳定恢复，进程重启后账本仍可用。

### Phase 2：安全交互与冲突处理

- Client `/undo`；
- 消息旁 Undo 按钮；
- 预检确认框；
- 冲突列表、跳过与强制恢复；
- undo 前反向恢复点。

**退出条件**：外部编辑不会被默认静默覆盖，所有实际写入都有可审计结果。

### Phase 3：会话子树与 redo

- 查询真实父子对话树；
- 后序递归撤销；
- 路径聚合与重叠文件基线选择；
- redo；
- 跨会话同工作区冲突提示。

**退出条件**：父节点撤销可稳定恢复到父 turn 前状态，不伤及无关会话的文件。

### Phase 4：性能、容量与 Worktree 联动

- 大仓库索引优化、排除规则；
- 配额与 GC；
- worktree 专用恢复域与 UI 状态；
- 诊断页和可导出审计。

## 14. 验收测试矩阵

至少覆盖：

| 场景 | 预期 |
| --- | --- |
| 修改既有文件 | 恢复 turn 前内容 |
| 新建文件 | undo 后文件不存在 |
| 删除文件 | undo 后文件恢复 |
| 同一文件连续三 turn 修改 | 父子树 undo 最终恢复到祖先 preimage |
| 父 turn 下多个子分支 | 只撤销所选父节点的全部后代 |
| 子树外 turn 改同一文件 | 显示冲突，不默认覆盖 |
| 用户手动编辑目标文件 | 显示冲突，可取消/跳过/强制 |
| 非 Git 目录 | 不依赖用户项目 Git，仍可通过插件私有 Git 快照恢复 |
| Git dirty 工作区 | 不改变 index、branch、commit |
| Worktree 会话 | 只影响该 worktree |
| Agent 失败/取消 | 最佳努力结算并如实标记可恢复性 |
| Host 进程重启 | 已结算 turn 仍可 plan/undo |
| 磁盘不足/Git 快照写失败 | 不产生伪可撤销状态 |
| 文件恢复中断 | 已写文件由反向恢复点回退，并记录失败 |

## 15. 个人仓库到组织仓库的发布流程

插件采用「个人仓库验证 → 转移到组织 → 正式发布」的生命周期。仓库转移的目的不是复制代码，而是在验证稳定后将同一个 GitHub 仓库的所有权、维护权和发布权交给组织。

### 15.1 阶段一：个人仓库开发

先在开发者个人账号下创建插件仓库，例如：

```text
github.com/<个人账号>/dsh-tauri-turnrewind
```

个人仓库阶段用于：

- 建立 Host/Client 插件骨架和共享协议；
- 实现私有 Git 快照仓库与 SQLite turn 账本；
- 验证单回合 dry-run、无冲突 undo 和新增/修改/删除文件恢复；
- 在 DSH Desktop debug 环境中安装并运行插件；
- 验证 `/undo`、消息旁 Undo、父节点递归撤销和冲突提示；
- 运行单元测试、集成测试和手工恢复测试；
- 允许快速调整数据模型、UI 和 Cordis API 接入，不要求此阶段就进入正式发布链路。

个人仓库阶段不得把试验性快照、用户项目文件或本地 `$DSH_HOME` 数据提交到 Git。应提前配置 `.gitignore`，排除：

```text
node_modules/
dist/
coverage/
*.sqlite
*.sqlite-*
.turnrewind/
```

### 15.2 阶段一退出条件

满足以下条件后，才进入组织转移：

- 插件能在干净环境安装并启动；
- Host 进程重启后 turn 账本仍可读取；
- 修改、创建、删除文件的 undo 均有测试覆盖；
- 文件被用户或其他 turn 改动后不会默认静默覆盖；
- 父节点递归 undo 不会影响子树外的会话或工作区；
- Git dirty 工作区的 branch、HEAD、index、stash 和 commit 不被修改；
- 本地 Git 项目和非 Git 项目都完成基本验证；
- `dsh-tauri-worktree` 场景已确认恢复域隔离；
- CI 至少能完成安装、类型检查、测试和构建；
- README 已说明安装方式、权限范围、限制和数据存储位置。

### 15.3 阶段二：转移到组织仓库

稳定后，通过 GitHub 仓库 Settings 的 **Transfer ownership** 将仓库直接转移到组织，例如：

```text
github.com/<个人账号>/dsh-tauri-turnrewind
    ↓
github.com/dsh-tauri-desk/dsh-tauri-turnrewind
```

应转移原仓库，而不是新建一个空的组织仓库再复制代码。直接转移可以保留：

- Git 提交历史、分支和标签；
- Issues、Pull Requests、Releases 和 Wiki（具体以 GitHub 当前规则为准）；
- 原仓库地址到新地址的跳转关系。

转移前应先完成一次备份，并确认组织允许接收该仓库。转移后立即检查：

- 组织成员权限、分支保护和 CODEOWNERS；
- GitHub Actions workflow、Secrets、Variables 和 Environments；
- 第三方 Actions、Artifact、缓存和发布权限；
- GitHub Packages 或 npm 发布身份、Token 和包访问权限；
- Release、Tag、Issue 模板和项目主页链接；
- README、文档和插件内部仓库地址。

仓库转移不会自动完成 npm 包所有权或发布权限迁移。若插件发布为 npm 包，必须单独确认包名、npm organization、maintainer、provenance 和 publish workflow。

### 15.4 阶段三：组织正式发布

组织仓库接管后，再配置正式发布链路：

1. 在组织仓库中建立受保护的 `main` 分支和 PR 检查；
2. 配置组织 CI：安装、lint/typecheck、单元测试、集成测试和构建；
3. 通过 Release 或 npm 发布经过验证的版本，不直接发布个人仓库试验版本；
4. 记录插件版本、Git tag、npm 版本和兼容的 DSH 核心版本；
5. 发布后在干净的 DSH Desktop 环境中验证安装和升级；
6. 确认稳定后，再修改桌面端的 `src-tauri/resources/preset-plugins.json`：
   - `spec` 指向组织发布的 npm 包或 GitHub 来源；
   - `repoUrl` 更新为组织仓库地址；
   - 若作为内置插件，更新版本并执行 `pnpm build` 验证 `prebuild`；
   - 只有确认捆绑产物、启动自愈和升级流程正常后，才进入桌面端发布。

桌面端集成顺序应保持：

```text
个人仓库开发
  → debug 安装和功能验证
  → 退出条件检查
  → GitHub Transfer ownership
  → 组织 CI / 权限 / npm / Release 配置
  → 发布正式插件版本
  → 更新 dsh-desktop 的 preset-plugins.json
  → 构建并验证桌面端
```

### 15.5 版本和回滚原则

- 个人仓库阶段可以使用 `0.x` 版本和实验性 tag，但必须标明不可用于生产；
- 转移到组织后，正式版本由组织仓库的 tag 和 Release 管理；
- 桌面端的内置插件版本只引用已验证的正式版本；
- 插件发布失败时，优先回滚桌面端的插件版本声明或使用上一版插件，不直接修改用户工作区；
- 插件代码、插件配置和桌面端 `preset-plugins.json` 的变更都应保留可追踪的 Git 提交。

## 16. 三种回退模式的可行性比较

本节比较设置中提供的两大类、三种具体模式。三种模式都复用同一个文件恢复安全核心：先 plan、检查冲突、确认当前文件仍符合 turn 完成后的状态，再执行恢复。区别只在于**会话历史如何处理**。

### 16.1 设置结构

建议在插件设置中使用一个平坦配置项：

```text
turnrewind.mode = conversation-rewind | conversation-rewind-context | branch-rewind
```

对应界面：

```text
回退模式
├─ 原会话回退
│  ├─ 完全回溯（OpenCode 模式）
│  └─ 保留对话并在下一次提示词中说明文件已回退
└─ 新建分支回退（Claude Code 模式）
```

默认值建议为：

```text
conversation-rewind-context
```

原因是它不会删除历史，也不需要第一版就协调 session fork，风险和实现面最小。

### 16.2 模式一：完全回溯（OpenCode 模式）

用户点击目标 turn 的 Undo 后：

1. 恢复目标 turn 修改过的文件；
2. 删除目标 turn 之后的 LLM 回复和相关对话记录；
3. 保留目标 turn 之前的用户提示词与对话；
4. 将目标 turn 对应的用户提示词复制回输入框，等待用户重新发送。

抽象结果：

```text
原会话：A → 用户提示 P → LLM 回复 R → 后续历史
Undo 后：A
输入框：P
工作区：恢复到 P 之前
```

**可行性判断：暂不适合作为第一版。**

当前 DSH 的 `sessionPersistence` 是 append-only，`sessions` 提供 `fork(source, boundary)`，但没有公开的“从当前 session 删除尾部事件”或“重写历史日志”方法。直接改 JSONL/SQLite 会破坏：

- session seq 连续性；
- append-only 持久化约束；
- projection/replay 平衡；
- 其他已打开页面对同一 session 的观察；
- 子 Agent 和父子 session lineage；
- 失败恢复和审计记录。

如果未来要支持此模式，应把它实现为**产品级 session rewind/fork**，而不是物理删除日志：保留原日志，创建一个截断前缀的新 session，并由 Client 将原用户 prompt 放入草稿。但这样实际上已经逐渐接近模式三，不能把它误认为简单删除。

### 16.3 模式二：原会话保留 + 下次提示词注入

用户点击 Undo 后：

1. 恢复目标 turn 修改过的文件；
2. 原会话的所有消息和 LLM 回复保留；
3. 为当前 session 持久化一条 pending rewind notice；
4. 下一次 Agent step 通过 `agent/pre-step` 把说明加入模型收到的 messages；
5. notice 消费后清除，避免每次提示词重复注入。

模型下一次收到的上下文中增加类似说明：

```text
[Turn rewind notice]
The workspace was reverted to the state before the previous turn.
The following files were reverted:
- src/login.tsx
- src/auth.ts

Treat the current files on disk as authoritative. Do not assume the reverted
changes still exist; re-read the files before making further edits.
```

**可行性判断：最适合作为第一版。**

已确认的 DSH 接口正好覆盖它：

- 文件恢复使用现有 Host 恢复核心；
- pending notice 可由插件私有账本保存；
- `agent/pre-step` 是真实的 waterfall，可替换进入下一 step 的 messages；
- `session/event` 可观察会话事件，但不需要改写历史；
- 不需要删除已提交的 session event；
- 不需要创建新 agent 或切换前端当前 session。

当前 DSH 的 agent loop 会把 `agent/pre-step` 接受后的 messages 作为 `user/message` 追加到 append-only session log。因此本插件的第一版采用**插件来源的用户角色 notice**：它不伪装为人类输入，带 `source.kind: 'plugin'`、插件名和 `form: 'rewind-notice'`，但会在下一次 step 的历史中留下一个可审计的显式记录。这样模型能收到它，用户也能看见发生了什么，而原有用户消息和 LLM 回复不会被删除或重写。

notice 只在下一次成功进入的 step 消费一次；如果该 step 被拒绝或取消，notice 保持 pending。连续 Undo 会将同一 session/workspace 旧的 pending notice 标记为 `superseded`，只让模型看到最新回退状态。

**主要风险：**原会话历史仍然包含“修改已经存在”的旧 LLM 回复，所以 notice 必须明确要求“以当前磁盘文件为准并重新读取”。

### 16.4 模式三：新建分支回退（Claude Code 模式）

用户点击 Undo 后：

1. 预检并恢复目标 turn 修改的文件；
2. 在目标 turn 之前找到合法的 completed-turn event boundary；
3. 使用 DSH 的 `sessions.fork(source, boundary, childSessionId)` 创建新 session；
4. 新 session 继承目标 turn 之前的历史，不包含目标 turn 及后续回复；
5. 在新 session 的元数据或首个上下文中记录这是一次 turnrewind 分支；
6. Client 使用 `sessions.fork({ sessionId, atSeq })` 并 `sessions.open(newSessionId)` 切换到新会话。

抽象结果：

```text
旧会话：A → P → R → 后续历史（保留）
新会话：A
工作区：恢复到 P 之前
后续对话：发生在新会话
```

**可行性判断：正式产品模式可行，但不适合作为最先落地的模式。**

当前 DSH 已确认提供：

- Host `sessions.fork(source, boundary, childSessionId)`；
- Client `sessions.fork({ sessionId, atSeq })`；
- Client `sessions.open(newSessionId)`；
- Session header 中的 parent lineage；
- fork 边界必须落在合法的 completed-turn boundary，不能截断 open turn。

仍需解决：

- turn 的文件 snapshot 边界和 session event seq 的精确对应；
- 恢复文件与 fork 之间的并发锁和失败补偿；
- fork 成功但 Client 切换失败时的用户提示；
- 原 session、子 session 和同 workspace 其他 session 的冲突；
- worktree 会话在 fork 后的 workspace 归属；
- 当前输入草稿、附件和 UI 选中状态如何迁移；
- 旧会话标记为 rewound 的持久化方式。

因此模式三应在模式二稳定后实现，优先复用 DSH 正式 fork API，绝不手工复制或修改 session 日志。

### 16.5 三种模式对比

| 模式 | 历史处理 | DSH API 匹配度 | 实现复杂度 | 数据安全 | 推荐顺序 |
| --- | --- | --- | --- | --- | --- |
| 完全回溯 | 物理删除目标后的历史，提示词回填输入框 | 低；append-only 没有删除尾部 API | 高 | 低，容易破坏日志或丢历史 | 3 |
| 原会话 + 下次注入 | 历史保留，下一次 step 注入回退说明 | 高；`agent/pre-step` 可直接承载 | 低 | 高，不破坏历史 | **1** |
| 新建分支回退 | 原会话保留，新 session 从目标前 fork | 高；Host/Client 均有 fork API | 中 | 高，但需要边界协调 | 2 |

### 16.6 首选落地方案

第一阶段选择：

```text
模式二：原会话保留 + 下次提示词注入
```

第一版范围：

- 设置页提供三种模式，但默认选中模式二；
- `/undo` 根据当前设置执行文件恢复；
- 模式二将撤销状态与一次性 rewind notice 在同一 SQLite 事务中提交；
- 下一次 `agent/pre-step` 进入时消费 notice，并以带插件来源的可审计 message 注入模型请求；
- 冲突仍然默认阻止恢复；
- 不删除或重写已有 session 历史；
- 不创建新 session；
- 不做父节点递归和 redo，先验证单回合完整链路。

第二阶段再实现模式三：

- 建立 turn event seq 与文件 snapshot 的精确映射；
- 使用正式 `sessions.fork` API；
- 在 Client 侧自动打开新 session；
- 增加旧/新分支关系展示和失败补偿。

模式一最后考虑，并且产品语义应改成“从历史前缀创建可重试会话”，而不是直接删除 append-only 日志。

## 17. 未决问题

1. DSH 当前会话树是否为严格树、是否支持共享节点或消息重试分叉？实际 API 决定递归算法。
2. 哪个生命周期点最能准确界定「用户请求的一次 turn」？需要先查 Event 合约。
3. 现有 sandbox 是否已提供用于 Host 插件的路径受限文件访问？若没有，`dsh-tauri` 需要增加哪一个最窄的桥接接口？
4. 首版是否支持二进制文件、符号链接、权限位和重命名，还是先明确拒绝并提示？
5. `/undo` 是纯 Client 本地命令，还是 Host Tool；这取决于输入区 Slot 的真实能力。
6. redo 的保留时间和容量是否与 turn snapshot 共用配额？
7. 是否允许未来版本将 Git 私有快照仓库优化为用户仓库的隐藏 refs？若允许，需要额外的隔离、清理和故障恢复设计。
8. 模式二的 rewind notice 是否只注入下一次模型 step，还是也需要以不可伪装的系统结果卡展示给用户？
9. 模式三的 fork boundary 如何从 turn 生命周期稳定映射到 session event seq？

这些问题应在 Phase 0 通过真实接口调研和最小原型回答，不能靠猜测上游实现。
