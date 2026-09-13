# dsh-tauri-edit-message

DSH 桌面端的**消息编辑**：把已经发出去的用户消息改掉，**丢弃这条消息之后的历史并重新生成回答**。

- 悬停 / 停留在用户气泡上时，官方操作行里多出一个 **Edit** 图标按钮（与 Copy 同级）。
- 点击后官方气泡隐藏，原位置换成宽 100%、圆角、灰底的多行编辑框，右下角是「取消 / 发送」。
- `Enter` 提交、`Shift + Enter` 换行、`Esc` 取消。
- 提交后宿主用**种子会话**从该轮之前精确重建，并把改后的提问重新排队生成。

规范来源：[`docs/spec/EDIT_MESSAGE.md`](../../docs/spec/EDIT_MESSAGE.md)。

## 交互

```text
默认状态                                         编辑状态
┌────────────────────────────────┐              ┌────────────────────────────────────────┐
│            帮我整理一下这段代码的需求。│              │ 帮我整理一下这段代码的需求，并输出一个      │
└────────────────────────────────┘              │ ASCII 界面。|                           │
                             [✎] [Copy]           │                                        │
                                                │                [ 取消 (白) ] [ 发送 (黑) ] │
                                                └────────────────────────────────────────┘
```

| 元素 | 行为 |
|---|---|
| 操作行里的 `✎` | 进入编辑态（与官方 Copy 一起随悬停显隐） |
| `取消` / `Esc` | 退出编辑态，官方气泡原样恢复（草稿丢弃） |
| `发送` / `Enter` | 提交：截断该消息所在轮次，重建会话并重新生成 |
| `Shift + Enter` | 换行（不提交） |

## 实现要点

**定位（客户端，DOM 注入）**：不接管 `conversation.chat.node`，官方气泡、气泡列与附件行
由内核渲染，插件只用语义锚点追加自己的节点：

| 依赖 | 来源 |
|---|---|
| `[data-chat-flow-kind="user"]` | 官方 chat 行的语义标记 |
| `data-chat-turn` | 官方行上的轮次锚点 |
| `.xzv4MW_actions` / `.xzv4MW_action` | 官方操作行与图标按钮（Edit 按钮复用其类名，尺寸 / hover 同源） |
| `.Sixlwa_bubble` / `.Sixlwa_userStack` | 官方气泡与气泡列（编辑时隐藏气泡、面板插进气泡列） |
| `ctx.sessions.list` 的 `current` | 当前会话 id（行上没有会话属性，取列表快照） |

注入节点都带 `data-mtx-injected`，观察器与遍历会跳过它们，不会自激；官方 React 重建
操作行后由 MutationObserver 在同一批变更里补回。样式走 css-render 节点
（`mountStyle` + `createLifecycleController` 统一释放），不注入 `<style>`。

**截断（宿主，种子会话）**：内核会话日志只追加，没有原地改消息的原语。插件折叠出全部
已闭合回合，定位被编辑消息所在回合，取该回合 `turn/start` 之前（含之前全部）的事件作为
`ctx.agents.create({ seed })` 的种子，再把改后的用户消息 `followup` 进新会话。

刻意**不用** `sessions.fork`：fork 的切点是「第一个 ≥ atSeq 的 `turn/end` 再推进到下一轮
`turn/start`」，以某轮为锚会**整轮复制**它（「编辑后多出一个副本」的根因）；种子会话能
精确停在轮次之前。

**硬约束（踩过的坑）**：`inheritedEventCount` 必须等于实际交给 `agents.create` 的 seed
长度——内核会话构造函数会断言 `seeded session constructor seed must equal its inherited
prefix`，多一条 / 少一条都会让创建直接 409。

## 目录

```text
src/
  index.ts                  # 宿主 barrel（apply / inject / 协议常量）
  shared/constants.ts       # 跨半区协议：插件名 + /edit-message
  host/
    apply.ts                # inject + 路由注册（可选服务一律 ctx.get 反射读取）
    types/index.ts          # 宿主最小契约（会话事件 / 头 / 回合 / 编辑计划）
    routes/index.ts         # POST /edit-message（回环校验 + JSON 体 + 错误归一）
    service/
      edit-session.ts       # 回合折叠、编辑规划、种子会话、重新生成
      session-record.ts     # 会话记录归一（live 优先，其次 sessionQuery）
  client/
    index.ts                # inject + 装配（运行时句柄 + DOM 注入）
    constants/ types/ apis/ styles/ dom/
```

## 开发

```bash
pnpm --filter dsh-tauri-edit-message build       # tsdown（host src/index.ts / client src/client/index.ts）
pnpm --filter dsh-tauri-edit-message typecheck   # tsc
pnpm exec eslint packages/dsh-tauri-edit-message --fix
```

没有自定义构建脚本：两半都由 `dsh-tauri-tsdown` 的 `defineDshConfig()` 产出
（client 输出 `dist/client.cjs`，由 loader 包进 `window.__ModuleLoader__.load({ id, factory })`）。

内置插件接入：已声明在 `packages/dsh-tauri-bundle/package.json` 的 `dependencies` 与
`src-tauri/resources/internal-plugins.json` 中。

## 已知限制

- **附件原样保留**：只改写文本块；原消息里的图片 / 文件会跟着改后的消息一起进入新会话。
- **正在生成的回合不能编辑**：只有当轮 `turn/end` 已落定才可提交（提交前会先取消该会话
  仍在生成的回答）。
- **旧会话留在列表里**：重建产生的是新会话，原会话不被改写也不自动删除。