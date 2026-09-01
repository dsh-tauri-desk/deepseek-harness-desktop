# dsh-tauri-panel-extension

`dsh-tauri-panel-extension` 为 [`dsh-tauri-panel`](../dsh-tauri-panel) 增加侧栏“扩展”入口，在会话内容区提供技能与 MCP 管理。

## 界面预览

## 功能

- 技能列表、搜索、来源筛选、启停、查看/编辑和打开目录。
- “新建技能”关闭扩展面板、打开当前工作区的空白会话，并预填 `/skill-creator `（不会自动提交）。
- “导入仓库”通过 GitHub 地址导入技能仓库；仓库技能优先显示，并提供可点击的 GitHub 图标。
- MCP 服务器增删改、启停、从 Claude Code/Codex 导入及重启提示。
- 不包含上游设置页标题“技能与 MCP”和市场模块。

宿主 API 使用同源前缀 `/dsh-tauri-panel-extension/*`，仓库状态保存在 `$DSH_HOME/dsh-tauri-panel-extension`。

## 上游来源

实现基于 [`qinyre/dsh-plugin-capabilities`](https://github.com/qinyre/dsh-plugin-capabilities) commit `3412f8ddf0a92bdc89a3bab104b480f8745ebfc1` 修改，详见 [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md)。开发源以 Git submodule 固定在 `../../soruce/dsh-plugin-capabilities`。

## 逻辑变更

相对上游 commit `3412f8d` 的具体逻辑变更：

- 呈现层从设置页 section 改为侧栏“扩展”面板条目：通过 `sidebar.panel.action` 槽与 `panel.protocol`（含新增的 `closePanelContent` 关闭 API）接入，内容渲染在会话内容区替换视图。
- 移除“技能与 MCP”标题与市场（Market）模块，仅保留“技能”“MCP”两个标签页。
- “新建技能”不再于面板内弹窗创建，改为：关闭扩展面板 → 打开当前工作区的空白会话 → 预填 `/skill-creator `（不自动提交），将创建流程交给 [`skill-creator`](./skills/skill-creator/SKILL.md) 技能承载。
- 技能仓库 UI 从上游完整的仓库管理区（本地/GitHub roots 添加移除、来源分组展示）收敛为“导入仓库”按钮 + 对话框；导入的仓库技能排序优先，并展示可点击的 GitHub 图标链接（仓库地址由宿主端从注册的 root 派生，客户端不持有）。
- 仓库导入沿用上游的 GitHub codeload tarball 方案（不依赖 git 可执行文件），新增 `parseGitHubSource` 支持 `owner/repo`、完整 URL、`.git` 后缀及 `#ref`/`/tree/<ref>` 分支定位，并探测单技能/扁平/嵌套三种仓库结构。
- API 前缀与状态目录改为 `/dsh-tauri-panel-extension/*` 与 `$DSH_HOME/dsh-tauri-panel-extension`，与上游插件同时安装时不冲突；路由与方法授权机制与上游一致。
- 客户端实现遵循本仓库工程约束：上游 raw CSS 字符串整树迁移为 css-render 结构化节点（仅在 `apply()` effect 中挂载）、共享类型与常量集中到 `src/client/types/`/`constants/`、图标仅取 gravity-ui。
- MCP 管理与上游保持一致（增删改、启停、从 Claude Code/Codex 导入、重启提示），新增 JSON/表单双模式编辑器作为增量。

## 许可证

[MIT](../../LICENSE.md) © [Hairyf](https://github.com/hairyf)
