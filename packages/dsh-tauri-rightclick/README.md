# dsh-tauri-rightclick

为 DeepSeek Harness 应用封装端提供更完整、接近原生客户端的鼠标右键体验，覆盖会话、工作区、未分组会话、设置页、对话正文、链接与输入框。菜单与提示文案支持中英文并自动跟随宿主 UI 语言。官方已有的会话操作转交官方组件。

> [!WARNING]
> 本插件面向承载 DeepSeek Harness Web UI 的应用封装端（Tauri、EAC、Electron、WebView2、CEF、Qt WebEngine 等），不面向直接在普通浏览器中打开的 `dsh web`。

## 安装

在承载 Web UI 的 Profile（例如 `web` 或 `tauri`）下安装本工作区的构建产物：

```bash
pnpm --filter dsh-tauri-rightclick build
dsh plugin --profile web add ./packages/dsh-tauri-rightclick
```

重启 `dsh web` 或承载它的应用封装端后生效。

### 更新 / 卸载

```bash
dsh plugin --profile web up dsh-tauri-rightclick
dsh plugin --profile web remove dsh-tauri-rightclick
```

## 内置上下文

- 会话：官方重命名、分叉、归档；打开目录、复制目录和会话 ID；临时“新会话”不处理。
- 工作区及其“新会话”入口：新建会话、打开目录、重命名、复制路径、归档会话和安全移除工作区。
- “未分组”：归档全部未分组正式会话、刷新。
- 普通文本：复制所选文本；全选严格限定在当前对话内容 slot 或设置弹窗，不包含应用侧边栏。
- 链接或选中的网址：使用系统默认浏览器打开、复制链接。
- 输入框：撤销、重做、剪切、复制、粘贴、全选。
- 所有插件菜单：刷新当前 Harness 页面。

## 兼容策略

- 不修改 `@deepseek-ai/*`、Tauri 壳或其他社区插件。
- 通过会话行的无障碍语义定位目标，通过 `sessions` 和 `workspaces` 公开服务执行业务；无法确认目标时保留浏览器默认菜单。
- 常规操作继续使用 Harness 公开服务；打开 URL 通过插件宿主路由交给系统默认浏览器。
- 插件卸载后不留下补丁。
- 与 dsh-better-sidebar 共存：better-sidebar 会包装宿主的 `workspaces.openPath` 把所有路径导向侧边栏编辑器。为避免目录被当文件打开（`xxx is a directory`），本插件“在资源管理器中打开”直接调用宿主 RPC `host.openPath`（`POST /api/host.openPath`），目录始终交给系统文件管理器；URL 不会传入文件路径接口，而由插件宿主路由交给系统默认浏览器。

## 扩展协议

其他 Web 插件可通过全局注册表登记扩展信息。`run` 会在点击菜单项时执行，`visible` 可按会话决定是否显示：

```js
const menu = globalThis[Symbol.for('dsh.rightclick-menu.extensions')]
const dispose = menu.register({
  id: 'example.session-details',
  order: 100,
  label: '会话详情',
  visible: ({ session }) => Boolean(session),
  run: ({ session }) => console.log(session),
})
```

每次打开右键菜单还会派发 `dsh:rightclick-menu` 事件，`detail` 包含 `row`、官方菜单 `action`、`session`、`workspace`、原始 `target`、鼠标坐标 `x/y` 和当前 `extensions`。扩展插件应在卸载时调用注册返回的 disposer。

## 宿主 API

| 路由 | 方法 | 说明 |
| --- | --- | --- |
| `/api/dsh-rightclick-menu/open-url` | POST | 系统默认浏览器打开外链（同源 JSON；body: `{ url }`，仅 http/https） |

## 为什么不在会话菜单提供“置顶会话”

Codex 的“置顶聊天”由独立的 pin 状态驱动：被置顶的会话固定显示在置顶分区，未置顶的会话仍按最近更新时间排序。DeepSeek Harness 当前公开的会话与工作区状态中没有对应的 `pinned` 字段、置顶集合、置顶 RPC 或状态变更事件；侧栏只有“最近更新”和“手动排序”两种整体排序方式，都无法同时满足“固定置顶 + 其他会话继续按时间排序”。因此本插件不提供置顶，也不会用切换全局手动排序、直接修改 Harness 本地存储、重排 React DOM 或修改会话日志等方式模拟置顶。

## 开发

```bash
pnpm --filter dsh-tauri-rightclick dev      # tsdown --watch
pnpm --filter dsh-tauri-rightclick test     # vitest
pnpm --filter dsh-tauri-rightclick typecheck
```
