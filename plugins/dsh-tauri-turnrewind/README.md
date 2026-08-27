# dsh-tauri-turnrewind

本地开发中的 DSH turn 回滚插件。

> 当前 `cordis.patch.yml` 已为本地 debug profile 的实验启用而挂载插件。它仍是原型：恢复路径直接使用 Node/Git，尚未接入受控的宿主 sandbox/Tauri bridge；仅可在可丢弃的测试工作区中启用，不能作为生产功能使用。

## 当前状态

这是 Host MVP 原型，当前实现：

- 为已领取的 Agent turn 建立私有 Git 快照；
- 将快照映射记录到 `$DSH_HOME/turnrewind/ledger.sqlite`；
- 注册人类命令 `/undo`；
- `/undo` 只处理当前会话最新的单个可恢复 turn；
- `/undo --dry-run` 只输出预检计划，不修改文件；
- 恢复前比较当前文件与 turn 完成时的快照，发现变化则拒绝覆盖；
- 同一 workspace 的活动 turn 或 undo 操作互斥；
- 插件重启时将未完成 turn 标记为 abandoned；
- 不修改用户项目的 HEAD、分支、index、stash 或提交历史。

当前尚未启用：

- 父对话递归 undo；
- 消息旁的 Client Undo 按钮；
- redo；
- 大型仓库增量扫描和完整的特殊文件支持。

## 本地安装到 debug profile

在当前 checkout 中执行：

```powershell
pnpm exec vitest run plugins/dsh-tauri-turnrewind/test --testTimeout=30000
$env:DSH_HOME = "$env:USERPROFILE\.dsh.dev"
node "$env:APPDATA\io.github.hairyf.deepseek-harness-desktop\dependencies\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js" plugin --profile web add "$(Resolve-Path plugins/dsh-tauri-turnrewind)"
```

或者把 `cordis.patch.yml` 的 `turnrewind` row 合并到 profile 的 `cordis.patch.yml`。插件包必须先通过 `pnpm add` / `dsh plugin add` 安装，不能仅把源码目录放在项目里就期待 DSH 加载。

## 安全边界

快照存放在 `$DSH_HOME/turnrewind/snapshots/<workspace-hash>.git`。插件不会调用用户项目的 `git reset --hard`、`git checkout .` 或 `git clean -fd`。

这是实验版本，正式启用前还需要通过真实 DSH 页面验证 turn 生命周期、文件扫描边界和 profile 重启恢复。
