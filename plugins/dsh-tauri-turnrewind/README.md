# dsh-tauri-turnrewind

本地开发中的 DSH turn 回滚插件。

> 当前 `cordis.patch.yml` 已为本地 debug profile 的实验启用而挂载插件。它仍是原型：恢复路径直接使用 Node/Git，尚未接入受控的宿主 sandbox/Tauri bridge；仅可在可丢弃的测试工作区中启用，不能作为生产功能使用。

## 当前状态

这是 Host MVP 原型，当前实现：

- 为已领取的 Agent turn 建立私有 Git 快照；
- 将快照映射记录到 `$DSH_HOME/ledger.sqlite`；
- **工作区资格守卫**：家目录、家目录的祖先、盘根目录，以及超过快照预算（文件数 / 总大小 / 单文件大小）的目录不做快照，turn 记为 `skipped` 并向 `/undo` 说明原因（见「工作区资格与快照预算」）；
- **不可用弹窗**：客户端半（`lib/client.js`）通过 `turnrewind` 会话投影检测到不可用提示时，在 Web UI 内弹出模态对话框（中英双语、每个浏览器只弹一次）；
- 注册人类命令 `/undo`；
- `/undo` 只处理当前会话最新的单个可恢复 turn；
- `/undo --dry-run` 只输出预检计划，不修改文件；
- 恢复前比较当前文件与 turn 完成时的快照，发现变化则拒绝覆盖；
- 同一 workspace 的活动 turn 或 undo 操作互斥；
- 插件重启时将未完成 turn 标记为 abandoned；
- 每次 Undo 的回退提示独立持久化；下一次模型 step 一次性注入全部 pending notice；
- 不修改用户项目的 HEAD、分支、index、stash 或提交历史。

## 使用方法

在已加载本插件的 DSH 会话中：

```text
/undo --dry-run
```

先查看撤销预检。它只检查，不修改文件。

确认预检结果中的文件和冲突数量正确后，再执行：

```text
/undo
```

也可以指定完整 turn ID：

```text
/undo <session-id>:<turn-number>
```

当前支持的命令：

```text
/undo
/undo --dry-run
/undo <turn-id>
```

当前不支持：

```text
/undo --subtree
```

父对话递归撤销、redo、消息旁 Undo 按钮和设置页模式切换尚未实现。

## 工作区资格与快照预算

快照的第一版实现会对任意工作区做全量基线，曾有用户在 QQ 机器人会话（默认工作目录是家目录、约 250 GB 内容）上触发 `git add --all` 级别的灾难。现在 turn 开始前会先做资格检查，不合格的工作区**不建快照、不产生可撤销 turn**，并在账本中记为 `skipped`（`/undo` 会显示原因）。两层检查：

1. **系统目录直接拒绝**：家目录本身、家目录的祖先目录（如 `C:\Users`、`C:\`）、以及任何盘符根目录。这类目录无论多小都不做快照。
2. **预算预扫描**（带元数据的快速遍历，超限立即中止）：
   - 文件数上限：默认 50,000（环境变量 `TURNREWIND_MAX_FILES`）；
   - 总大小上限：默认 1 GiB（环境变量 `TURNREWIND_MAX_BYTES`）；
   - 单文件上限：64 MB（与恢复读取上限一致，超限文件永远无法恢复，因此整个工作区拒绝快照）；
   - `.git`、`node_modules`、`dist`、`build`、`coverage`、`.turnrewind` 目录不计入预算。

被拒绝的 turn 仍正常执行，只是不提供 undo。同时该会话会收到一条一次性提示（`[Turn rewind unavailable]`），说明工作区被拒绝的原因；每个会话只提示一次，后续 turn 不再重复打扰。提示会以两种形态呈现：

1. **会话内消息**：插件来源的上下文注入消息，模型和用户都可见、可审计；
2. **Web UI 弹窗**：宿主端 `turnrewind` 会话投影（`lib/core/dialog-projection.js`）把提示折叠进会话列表快照，客户端半（`lib/client.js`）从 `sessions.list` 的 `projectionValues.turnrewind` 读到后弹出模态对话框，按提示 id 在 `localStorage` 去重——同一浏览器每条提示只弹一次，重装/换浏览器会重弹一次。

若确有合法的大工作区需要 undo，可通过环境变量放宽预算，自行承担快照耗时与磁盘占用。

### 清理已膨胀的快照数据

如果某个工作区在旧版本下已经生成过巨大快照，先停止 DSH Host 进程，再执行：

```powershell
node plugins\dsh-tauri-turnrewind\lib\purge-workspace.js "C:\Users\<user>"          # release 数据目录 ~/.dsh
node plugins\dsh-tauri-turnrewind\lib\purge-workspace.js "C:\Users\<user>" --home "$env:USERPROFILE\.dsh.dev"  # debug
```

该命令删除该工作区对应的私有快照仓库（`$DSH_HOME/snapshots/<hash>.git`）及其全部账本记录（turns / operations / notices / workspaces），其他工作区的数据不受影响。

## Undo 的工作区范围

Undo 的范围是：

```text
当前 session 绑定的 workspace（session header 的 cwd）
```

例如当前 session 的工作区是：

```text
C:\Users\YT16228\Desktop\test
```

插件只会比较和恢复该目录以内、且被快照规则允许的文件。它不是“恢复整台电脑”，也不是“恢复所有 Agent 访问过的路径”。

一次 turn 的文件范围是：

```text
turn 开始时的 workspace 快照
        ↓
Agent 执行
        ↓
turn 结束时的 workspace 快照
        ↓
两次快照之间发生变化的文件
```

Undo 只恢复两次快照之间发生变化的文件：

- Agent 修改的文件：恢复到 turn 开始前；
- Agent 新建的文件：Undo 时删除；
- Agent 删除的文件：Undo 时恢复；
- 未发生变化的文件：不处理。

## Workspace 外的文件

如果 Agent 访问或修改了 workspace 外的文件，当前版本**不会捕获，也不会 Undo**。

例如当前 workspace 是：

```text
C:\Users\YT16228\Desktop\test
```

Agent 修改了：

```text
C:\Users\YT16228\Desktop\test\a.txt
C:\Users\YT16228\Desktop\other\b.txt
```

执行 `/undo` 时：

```text
test\a.txt       → 可能被恢复
test 之外的 b.txt → 不会被处理
```

workspace 外的修改不会：

- 写入 turn 的 before/after snapshot；
- 出现在 `/undo --dry-run` 文件列表；
- 被 `/undo` 恢复；
- 出现在 rewind notice 的文件列表中。

在 `workspace-write` 权限模式下，宿主 sandbox 通常会阻止 Agent 写出 workspace；但如果使用 `danger-full-access` 或其他方式允许外部写入，**Agent 能写成功不代表 turnrewind 能回退这些文件**。

插件自己的恢复操作会拒绝以下路径：

```text
../outside.txt
C:\OtherProject\file.txt
workspace 内指向外部的符号链接路径
```

如果确实需要管理多个项目，应将它们作为独立 workspace 分别运行，不要把多个项目目录混成一个恢复域。

## 不同修改方式的捕获规则

当前插件按 workspace 在 turn 前后的实际差异捕获，不按工具名称判断来源。因此以下 Agent 修改方式通常都会被纳入当前 turn：

- Agent `write`；
- Agent `edit`；
- Agent 使用 Git Bash/bash；
- Agent 使用 PowerShell/pwsh；
- Agent 运行格式化工具；
- Agent 运行生成脚本；
- Agent 通过 Git 命令间接修改文件；
- Agent 执行其他会改写 workspace 文件的程序。

准确语义是：

```text
该 workspace 在本 turn 期间发生的允许范围内变化
```

不是：

```text
百分之百证明该变化由 AI 直接写入
```

如果用户或其他程序在 Agent turn 执行期间同时修改同一个 workspace，当前 MVP 可能无法区分来源，也可能把这些变化一起记录到该 turn。建议等待 Agent 完成或打断后，再手动编辑同一 workspace。

如果用户是在 turn 完成后修改文件，Undo 预检会将当前内容与 Agent turn 完成时的快照进行比较。内容不一致时会显示冲突，并默认拒绝覆盖。

## 冲突是什么意思

Undo 不是无条件覆盖。它会检查：

```text
当前文件状态 == Agent turn 完成时的文件状态？
```

如果相等，文件可以安全恢复到 turn 开始前。

如果不相等，就会显示类似：

```text
Undo preflight: turn <turn-id>; 5 file(s); 5 conflict(s): 4.txt, 5.txt, 6.txt, 7.json, 8.md.
```

含义是：

- 目标 turn 涉及 5 个文件；
- 当前文件与该 turn 完成时的快照不一致；
- 插件无法确认这些变化是否来自用户、其他 turn 或外部程序；
- 默认不会覆盖，文件保持当前状态。

Windows 的 `CRLF` 与 Unix 的 `LF` 换行差异会被文本状态比较规范化，不应单独造成冲突。二进制文件仍按原始字节比较。

当前没有“跳过冲突文件”和“强制覆盖冲突文件”的用户命令；遇到冲突应先检查文件，再决定是否手动处理。

## 多次 Undo 与模型提示

每次 Undo 都会产生一条独立的 pending rewind notice：

```text
Undo C → notice C
Undo B → notice B
Undo A → notice A
```

如果在发送下一条普通消息之前连续执行多次 Undo，下一次模型 step 会一次性收到全部 notice，顺序为：

```text
C、B、A
```

每条 notice 会列出：

- 被撤销的 turn；
- 该次 Undo 涉及的文件；
- “当前磁盘文件是权威状态”；
- “不要假设旧修改仍存在，请重新读取文件”。

notice 只消费一次。下一次模型 step 后不会重复注入。

## Git 与快照存储

快照存放在插件私有目录：

```text
$DSH_HOME/snapshots/<workspace-hash>.git
```

账本存放在：

```text
$DSH_HOME/ledger.sqlite
```

插件不会调用用户项目的：

```bash
git reset --hard
git checkout .
git clean -fd
```

也不会修改用户项目的：

```text
HEAD
当前分支
index
stash
commit history
```

## 默认排除项

为降低敏感信息和无关产物进入私有 snapshot 的风险，默认排除：

```text
.git/
node_modules/
dist/
build/
coverage/
.turnrewind/
.env
.env.*
*.pem
*.key
id_rsa*
credentials*
*secret*
*token*
```

这些规则意味着：被排除文件的变化不会进入本 turn 的 Undo 范围。插件仍是实验原型，不应把它当作秘密信息保护工具。

## Debug 安装

在当前 checkout 中执行：

```powershell
pnpm exec vitest run plugins/dsh-tauri-turnrewind/test --testTimeout=30000
$env:DSH_HOME = "$env:USERPROFILE\.dsh.dev"
node "$env:APPDATA\io.github.hairyf.deepseek-harness-desktop\dependencies\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js" plugin --profile web add "$(Resolve-Path plugins/dsh-tauri-turnrewind)"
```

插件包必须先通过 `pnpm add` / `dsh plugin add` 安装，不能仅把源码目录放在项目里就期待 DSH 加载。修改 Host 代码后需要重启对应的 DSH debug Host 进程。

## 测试

运行插件测试：

```powershell
pnpm exec eslint plugins/dsh-tauri-turnrewind
pnpm exec vitest run plugins/dsh-tauri-turnrewind/test --testTimeout=30000
```

当前测试覆盖 Git 快照、增删改恢复、中文路径、CRLF、路径逃逸、符号链接、敏感文件排除、账本生命周期、interrupted turn 和多次 notice。

## 当前限制

这是实验版本，正式启用前仍需要：

- 接入受控的宿主 sandbox/Tauri bridge；
- 完成 DSH lifecycle integration tests；
- 快照/扫描改为异步执行（当前 `spawnSync` 会阻塞 Host 事件循环）；
- 完善 Git 仓库工作区的增量基线（参考 OpenCode：共享用户对象库 + 仅 stage 变更路径）；
- 完善多 workspace 并发锁；
- 实现父对话递归 undo；
- 实现 redo 和冲突处理 UI；
- 实现消息旁 Undo 按钮；
- 增加 snapshot 数量/容量清理；
- 明确二进制、重命名、权限位和特殊文件策略。
