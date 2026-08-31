# dsh-tauri-session

DeepSeek Harness 桌面端插件：管理「已归档的聊天」的设置页（搜索 / 排序 / 分组 /
项目选择 / 取消归档 / 全部删除），并在官方工作区浏览器的「删除工作区」菜单旁
追加「归档工作区」入口。

采用 host half / client half 架构：

- `src/*.ts`：宿主侧（node half）实现。
- `src/client/*.ts(x)`：浏览器侧（browser half）实现，渲染设置分区与 DOM 补丁。

## 功能

- **设置页「归档」**：在设置侧边栏新增「归档」导航项，内容为「已归档的聊天」列表。
- **归档页控件**：搜索框（搜索已归档的聊天）、排序方式（更新时间 / 创建时间 /
  按字母排序）、项目选择框 —— 使用官方
  `@deepseek-ai/dsh-client-ui-primitives` 组件（`Input` / `Menu` / `Button`）；
  下拉触发器对齐官方「通用设置」Select 的 pill 样式（36px 全圆角、无边框、
  `bg-module-platform` 底）。
- **分组规则**：排序方式同时影响「组」与「组内聊天」（两级都排序）；组按成员
  聚合值排序，组内按排序方式排序；无项目组统一命名为「未分组」。
- **取消归档**：从宿主归档集合移除该会话后，回到其原来的工作区组（宿主归档
  从不修改工作区 sessionIds 记账，会话在组内保留的位置自动恢复显示）；成功后
  弹「对话已取消归档 [查看]」toast，查看可跳转到恢复的会话。
- **彻底删除**：每行垃圾桶与「全部删除」（危险色）为破坏性操作，均经官方
  `Modal` 二次确认（单项：「删除已归档聊天？」；全部：「删除所有已归档本地
  聊天？」）—— 从宿主归档集合移除并物理删除会话数据（宿主无公开「删除会话」
  API，按 `$DSH_HOME/sessions/<group>/session-<id>/` 有界扫描删除的是会话
  持久化目录，宿主重启后从持久化重建索引，会话从工作区与归档中彻底消失）。
- **加载态**：变更（取消归档 / 删除）进行中时动作按钮禁用并弹 loading toast，
  完成后消失；失败在页面顶部显示错误。

## 归档机制（v2：宿主归档集合）

v2 起插件不再自持 `archive.json`，而是直接使用**宿主 `WorkspaceRegistry` 的归档
集合**（`archivedSessionIds`，持久化、对官方所有分组界面隐藏、不动工作区记账）——
与官方会话行菜单里的「归档」动作写入的是同一份数据，因此两种入口归档的会话都会
出现在本插件的「已归档的聊天」页面。

- 宿主公开 API 只有 `archiveSession`（没有 unarchive），因此「取消归档」/「全部
  删除」经由注册表内部状态机（`enqueueOperation` + `requireState` + `setState`）
  改写归档集合；若宿主升级改变内部结构，接口会明确报错而不是静默降级。
- 插件初始化时会把 v1 自持的 `~/.dsh/dsh-tauri-session/archive.json` 记录一次性
  迁入宿主归档集合并删除旧文件（会话已不存在的僵尸记录随旧文件丢弃）。

## 宿主路由（/api/dsh-session/*）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/archived` | 宿主归档集合 id + 每个会话的创建元数据（读 host session header） |
| POST | `/archive` | 归档单个会话 |
| POST | `/archive-workspace` | 归档一组会话（一次调用） |
| POST | `/unarchive` | 取消归档（改写宿主归档集合） |
| POST | `/delete` | 彻底删除单个归档会话（归档集合移除 + 物理删除会话数据） |
| POST | `/clear` | 彻底删除全部已归档会话（同上，批量） |

## 客户端补丁（workspace-patch.ts）

官方 WorkspaceBrowser 的「删除工作区」是项目行「…」菜单（primitives `Menu`，
portal 渲染到 `document.body`）里的 `button[role=menuitem]` 条目，不是侧边栏按钮。
补丁因此：

1. 监听每个项目行（`[role=treeitem][aria-expanded]`）「…」按钮的点击，按行标题与
   运行时快照唯一匹配记录其工作区 id；
2. 扫描 portal 菜单：**保留**官方「删除工作区」条目（官方 Modal 确认、非破坏性：
   文件夹与会话记录保留，会话归入未分组），在其后**追加**「归档工作区」条目，
   点击 → 客户端样式确认框 → 归档该组全部会话（`/api/dsh-session/archive-workspace`）。

归档目标与会话清单全部来自运行时快照（`workspace.sessionIds`），不依赖
「组容器里装得下会话行」的 DOM 启发式——官方浏览器在组折叠时不渲染会话行，
旧实现会因此「全部折叠时无动作、部分展开时错归档到相邻工作区」。

## 目录约定

- 旧版（v1）自有状态目录 `$DSH_HOME/dsh-tauri-session/`（默认
  `~/.dsh/dsh-tauri-session/`）仅在迁移旧记录时读取；v2 不再写入。

## 开发

```bash
pnpm install
pnpm -F dsh-tauri-session typecheck
pnpm -F dsh-tauri-session test -- --run
pnpm -F dsh-tauri-session build
```

全局校验：

```bash
pnpm run lint --fix
pnpm run typecheck
pnpm run test -- --run
pnpm run build
```
