# Pet 后续实现 TODO 与交接

> 状态：暂停实现，保存检查点，待用户回家后继续。
>
> 分支：`dsh/issue-308-pet`
>
> 本文是下一轮工作的唯一实施清单。旧 PR #319 feedback 不在本任务范围内。

## 1. 最新用户反馈（最高优先级）

当前版本存在以下回归，继续开发时必须先复现，再修复：

1. 拖动时的转向动画与 Codex 精灵图移动动画消失。
2. 为气泡预留的窗口顶部区域太大，形成大片透明但会拦截鼠标的区域。
3. 气泡此前完全不显示；用户已修复 `ToastProvider`/样式接入，因此“能显示”不再是待办，
   但会话气泡调用和动作仲裁仍未完成。
4. 动作与气泡缺少仲裁：
   - 会话正在 work 时，点击不得触发动画或新增气泡；
   - work 动画与会话气泡不得被点击动作覆盖；
   - 多会话气泡通过多次调用现有 `toast()` 自然叠加；不要自行管理 HeroUI queue；
   - 会话 Toast 不显示关闭按钮，不显示 loading 状态。
5. `src/pet/pet.tsx` 仍把 `packages/dsh-tauri-pet/assets/*` 当作 ESM 模块直接导入；
   这是错误的运行时资源边界。Rust 必须从内置插件目录加载这些媒体，并以子 WebView 可消费的
   URL/数据提供给 pet WebView。
6. 必须重新对照以下三个参考实现，不得只做表面样式模仿：
   - `source/dsh-pet`
   - `source/codex-to-dsh-pet`
   - `source/BongoCat`

## 2. 不得改变的产品规格

### 2.1 启用与可见性

- 宠物默认关闭。
- 用户第一次启用后，`pet_enabled` 永久持久化为启用；隐藏/收起不能把它改回关闭。
- `visible` 是进程内瞬时状态：收起后本次运行隐藏；应用下次启动时，已启用宠物应重新显示。
- 侧栏按钮：
  - 尚未启用：第一次点击执行启用；
  - 已启用：后续点击只执行唤醒/收起。

### 2.2 内置宠物

- 唯一内置宠物名称必须是 `Maid DeepSeek Whale`。
- 中文描述必须精确为：

  `一只小小的七比蓝头发的鲸鱼女仆Codex宠物，穿着海军蓝裙子，白色褶边，蓝眼睛，侧鳍和鲸鱼尾巴。`

- 不得恢复“猫咪小助手”或“柴犬阿黄”。
- 内置素材来自 dsh-pet，副本归属于 `packages/dsh-tauri-pet/assets/`。
- `src/pet/pet.tsx` 不得通过 ESM import 引用这些资源；Rust 层应从已部署的内置插件目录
  `resources/node_modules/dsh-tauri-pet/assets/`（开发环境使用对应的实际插件包目录）读取，
  再通过受控 Tauri command/自定义协议提供给 pet 子 WebView。
- 内置 id 是 `maid-deepseek-whale`；旧内置 id 必须归一化到该 id。

### 2.3 设置页

- 设置入口和第一个 tab 显示 `Pets`；第二个 tab 显示 `Codex`。
- 不显示刷新按钮。
- 布局以 `docs/plugins/宠物设置页面.md` 为基础，新规格覆盖旧草图中的冲突内容。
- Pets tab：内置宠物 + Chat 创建的宠物。
- Codex tab：直接读取 Codex 宠物，并支持 ZIP 导入。
- 只能选择一个宠物；选择新宠物会替换旧选择。
- 50%–200%、步长 5 的宠物大小滑条必须位于整个设置页底部，两个 tab 下都可见。
- “创建”启动新会话，在输入框填入以下精确文本，但不得自动提交：

  `/hatch-dsh-pet 根据你对我的了解，养一只宠物`

### 2.4 数据归属

- 内置 dsh-pet 副本的源码/包内归属：`packages/dsh-tauri-pet/assets/`。
- 内置媒体的运行时所有权：Rust 解析内置插件实际部署目录并读取；pet 子 WebView 只消费
  Rust 返回的资源，不依赖 Vite 跨目录 ESM asset import，也不假设源码 checkout 存在。
- Chat 创建宠物：release 使用 `~/.dsh/pets`；desktop debug 按现有运行时约定使用
  `~/.dsh.dev/pets`。
- Codex 宠物：直接读取 `~/.codex/pets`，不复制到 DSH 数据目录。
- Codex ZIP 导入：安全解压到 `~/.codex/pets/<manifest-id>`，不得保留原始 ZIP。
- Chat/Codex 文件系统 id 分别为 `chat:<manifest-id>`、`codex:<manifest-id>`。
- 自定义宠物格式为 Codex v2：8 列 × 11 行 spritesheet，`spriteVersionNumber: 2`。

### 2.5 动画范围

- 用户已明确要求移除宠物自动移动/漫游逻辑。
- 仍需保留并正确仲裁：idle、turn、moving-left、moving-right、waving、waiting、running、review、failed。
- 不得用定时器主动移动 Tauri 窗口。

## 3. 参考仓库与固定版本

三个仓库均为 Git 子模块；继续前执行：

```bash
git submodule update --init --recursive
```

| 子模块 | 固定提交 | 用途 |
|---|---|---|
| `source/dsh-pet` | `899150eb85c819820b9e990b595dfc261f341bc2` | WebM 动作权重、连续播放、气泡样式与交互 |
| `source/codex-to-dsh-pet` | `b8d2de30255488d3fc497d7d667b1d828910a3e3` | Codex v2 atlas、会话状态映射、动作优先级 |
| `source/BongoCat` | `44f44bcf2b17b8e16463ad479a477a949d01cc9a` | Tauri 桌宠窗口、原生拖动、尺寸、DPI 与鼠标穿透基准 |

### 3.1 dsh-pet 必查位置

- `source/dsh-pet/dsh-pet/assets/config.jsonc:69-166`
  定义 idle、turn、drag、click、move、动作分类和权重。
- `source/dsh-pet/dsh-pet/src/client/bubble.ts:10-57`
  定义气泡 DOM、白色圆角主体及尾部。
- `source/dsh-pet/dsh-pet/src/client/bubble.ts:60-119`
  定义气泡显示、缩放、定位及生命周期。
- `source/dsh-pet/README.md:74-83`
  说明连续加权动画、转向、移动与双缓冲。

继续时需要形成对照表：参考行为、当前 DSH 行为、差异、是否采用及原因。

### 3.2 Codex pets 必查位置

替换后的仓库 `codex-to-dsh-pet` 结构已变：入口 `lib/client.js` 由 `build.js` 注入配置/图集后从
`lib/client.template.js` 生成（未入库），因此按函数名定位（行号会随版本漂移，不标注）：

- `source/codex-to-dsh-pet/lib/client.template.js`：`ANIMATIONS` 表（`createCodexPet` 内）
  定义各动作的行号/帧数，`setAnimation`/`play` 支持 `mode:"once"` + `then`，即一次性
  动作播放后回到指定动作（默认 idle）的序列。
- `source/codex-to-dsh-pet/lib/client.template.js`：`deriveActivity()`
  （`packages/dsh-codex-pet/src/client.js` 有同函数）——会话状态映射已改为
  pending→waiting、runningCalls→running、running===true→review、其余→idle；
  旧快照字段 pendingInteraction/completed/lastAgentError 与 failed 会话映射已不存在。
- `source/codex-to-dsh-pet/lib/client.template.js`：`createCodexPet` 的 pointer 事件处理
  （拖动方向→runningLeft/runningRight、hover→waving、双击→jumping）；
  `PetOverlay` 的 `RESTORE_BY_ACTIVITY`/`syncToActivity` 负责播放后按会话活动恢复。
- `source/codex-to-dsh-pet/packages/dsh-codex-pet/src/client.js`：完整预构建插件的
  `PetOverlay`（活动气泡、摘要气泡与 activity journal 面板），可用于会话提示信息设计对照。

继续时必须重点复核“高优先级动作阻塞低优先级动作”的机制，不能继续使用简单的
`localActivity ?? sessionActivity`。

### 3.3 BongoCat 必查位置

- `source/BongoCat/src/pages/main/index.vue:89-100`
  按模型尺寸与 scale 动态设置 Tauri 窗口物理尺寸，避免固定大矩形占位。
- `source/BongoCat/src/pages/main/index.vue:114-120`
  显示/隐藏和 `setIgnoreCursorEvents` 鼠标穿透独立控制。
- `source/BongoCat/src/pages/main/index.vue:138-140`
  `handleMouseDown()` 直接调用 `appWindow.startDragging()`，由操作系统处理跨屏/DPI 拖动。
- `source/BongoCat/src/composables/useWindowState.ts:25-55`
  监听 move/resize/scale change，并在 DPI 变化后重新夹取窗口位置。
- `source/BongoCat/src/composables/useWindowState.ts:59-99`
  记录物理位置/尺寸并仅在有效显示器上恢复。
- `source/BongoCat/src-tauri/tauri.conf.json:14-26`
  桌宠窗口为 transparent、decorations false、alwaysOnTop、skipTaskbar、shadow false。
- `source/BongoCat/src-tauri/capabilities/default.json:8-17`
  明确允许 start-dragging、set-size、set-ignore-cursor-events、set-position。

BongoCat 是窗口行为基准，不是完整交互基准。它在 mousedown 立即原生拖动，不需要区分
点击、双击、动作动画和会话状态；DSH 不能盲目照搬，需要在原生拖动外增加事件仲裁。

## 4. 当前实现检查点

### 4.1 已完成并应保留

- 三个参考仓库已加入 `source/*` 子模块。
- 内置 WebM/GIF 与 MIT attribution 已放入 `packages/dsh-tauri-pet`；这些是包内源文件，
  尚未完成 Rust → pet 子 WebView 的正确运行时资源加载边界。
- `packages/dsh-tauri-pet/THIRD_PARTY_NOTICES.md` 记录 dsh-pet 素材来源。
- `packages/dsh-tauri-pet/skills/hatch-dsh-pet/SKILL.md` 提供内置 hatch skill。
- `packages/dsh-tauri-pet/cordis.patch.yml` 注册 skill filesystem provider。
- `src-tauri/resources/internal-plugins.json` 注册生产内置插件。
- Settings 已实现 Pets/Codex 两个 tab、单一内置鲸鱼、Chat/Codex 列表、Codex 导入、
  创建会话与精确 draft prefill。
- 大小滑条已移动到设置页最底部。
- `pet_enabled` 持久，`visible` 瞬时；旧设置写入通过
  `preserve_persisted_fields` 保留宠物字段。
- Rust 已实现 Chat/Codex 列表、自定义素材读取、安全 ZIP 导入和源限定 id。
- 宠物 renderer 使用 `pet://status` 事件，不再 1.5 秒轮询。
- 自动移动窗口逻辑已经移除。
- Codex v2 8×11 atlas renderer 和会话状态映射已经存在。
- Tauri capability 已包含 `core:window:allow-start-dragging` 和
  `core:window:allow-set-position`。

### 4.2 已知当前回归及原因假设

#### A. 拖动转向/精灵动画消失

当前 `src/pet/pet.tsx` 在 pointerdown 立即调用 `appWindow.startDragging()`。
操作系统进入原生移动循环后，WebView 不保证继续收到 pointermove，因此依赖
`handlePointerMove` 设置 moving-left/right 的逻辑不会可靠执行。

待办：

- [ ] 在 Windows/macOS/Linux 实测 `startDragging()` 期间 `appWindow.onMoved` 是否持续触发。
- [ ] 优先用窗口 `onMoved` 的物理 X 差值判断方向并驱动 turn/moving 动画；不要重新手算
  不同 DPI 显示器上的 pointer CSS 坐标。
- [ ] 拖动开始、方向变化、拖动结束应进入明确状态机，不得依赖互相竞争的 React state。
- [ ] 拖动结束后恢复“拖动前的会话状态”，而不是一律恢复 idle。
- [ ] 自定义 atlas 与内置 WebM 都要验证转向/移动动画。
- [ ] 保留 OS 原生拖动，确保从屏幕一到不同 DPI 的屏幕二仍与鼠标 1:1。
- [ ] DPI 变化后参考 BongoCat 监听 `onScaleChanged`，重新夹取位置与刷新尺寸。

#### B. 顶部透明不可点击区域过大

当前 `src-tauri/src/desktop/pet.rs` 用最高 Codex 帧高度再加固定 120px 顶部气泡区计算
整个 pet WebView；透明 WebView 仍会拦截其矩形范围内的鼠标。单纯增大同一窗口无法同时满足
“气泡在宠物上方”和“宠物外透明区域可点击穿透”。

待办：

- [ ] 撤销/重构固定 `PET_WINDOW_TOP_PAD = 120.0` 的方案。
- [ ] 宠物主窗口应像 BongoCat 一样尽量紧贴当前模型实际可见尺寸。
- [ ] 首选评估独立 `pet-toast` 透明 Tauri 窗口：
  - 主 pet 窗口只负责宠物点击与拖动；
  - toast 窗口位于 pet 上方并随 pet 的 move/resize/scale 事件同步；
  - toast 窗口调用 `setIgnoreCursorEvents(true)`，不拦截桌面点击；
  - toast 窗口同样 alwaysOnTop、decorations false、shadow false、skipTaskbar；
  - 跨显示器/DPI 后使用真实物理位置重新定位。
- [ ] 若不使用独立窗口，必须证明替代方案能做到非矩形区域鼠标穿透；仅靠 CSS
  `pointer-events:none` 不足，因为 WebView 窗口本身仍会拦截桌面应用。
- [ ] 50%、100%、150%、200% 以及 192×208 自定义帧都要测气泡不重叠、不截断。

#### C. 点击与会话气泡调用

用户已修复 Toast 完全不显示的问题，当前接入为：

- `src/pet/main.tsx` 使用项目现有 `ToastProvider` 包裹 `PetWindow`；
- `src/pet/pet.css` 引入 `@heroui/styles`；
- `src/pet/pet.tsx` 调用 `@/utils/toast` 暴露的 `toast()`。

因此后续不得重新引入局部 `Toast.Queue`/`Toast.Provider`。项目级 `toast()` 已按 placement
维护 HeroUI 队列，并支持同一 placement 最多显示 3 条。用户明确指出：多会话只需要为每个
应显示的会话分别调用一次 `toast()`，不需要 pet 实现自行处理队列。

当前剩余问题：`showBubble()` 仍在每次调用前后执行全局 `toast.clear()`，这会清除已有会话
Toast，无法叠加；而 `PetStatus` 目前只有一个 `bubble` 字段，也不足以表达“多个会话各调用
一次”的事件语义。

待办：

- [ ] 保留项目现有 `ToastProvider` + `toast()` 接入，不创建 pet 专属 queue。
- [ ] 删除每次显示前的 `toast.clear()`；进行中会话由 `toast.close(key)` 精确结束，只有点击等
  短提示使用 `toast(text, { timeout, placement:'top' })` 的 timeout。
- [ ] 多会话活动产生一条提示时调用一次 `toast()`；有 N 个进行中会话就调用 N 次，并保存
  `sessionId → toastKey` 映射（`toast()` 的返回值就是该条 key）。
- [ ] Rust/插件到 pet WebView 的气泡协议改为会话事件语义，并携带稳定 session id，避免
  `get_pet_status` 或相同状态重复同步时反复弹出；去重会话事件，不管理 HeroUI 队列。
- [ ] 会话进入进行态时：若该 session 尚无 Toast，调用一次 `toast()` 并记录 key；已有 key
  则不得重复创建。
- [ ] 会话完成、失败、取消或离开进行态时：实时取出该 session 的 key，调用
  `toast.close(key)` 只关闭这一条，并删除映射；不得影响其他进行中会话。
- [ ] `toast.clear()` 的语义是清除全部 Toast，只能用于 `hide_pet`、窗口卸载或明确的全局
  重置；任何单个会话的状态变化都不得调用它。
- [ ] review/failed 是否先替换为结果 Toast 再按 timeout 消失，需对照参考实现后固定；无论
  采用何种结果展示，都必须先关闭该会话原有的进行中 Toast。
- [ ] 点击 Toast 仅在允许点击动作时调用一次 `toast()`。
- [ ] 不传 `isLoading`，不添加 action；现有项目 `ToastProvider` 本身不渲染 pet 自定义关闭按钮。
- [ ] 添加调用层测试或事件钩子，验证两个会话各触发一次时出现两条 Toast，且没有显式
  close/loading UI。

#### D. 内置媒体资源边界错误

当前 `src/pet/pet.tsx:14-23` 直接从
`../../packages/dsh-tauri-pet/assets/*.webm|gif` 进行 ESM import。这样会让应用 Web bundle
直接拥有插件资源，依赖 monorepo 源码相对路径，并绕过内置插件的部署/运行时边界。

目标架构：

1. 资源仍打包在 `packages/dsh-tauri-pet/assets/`，由 `package.json#files` 随内置插件部署到
   `resources/node_modules/dsh-tauri-pet/assets/`。
2. Rust 解析当前实际内置插件目录，开发态与生产态不能硬编码同一个绝对路径。
3. Rust 校验请求的 built-in pet id 和固定 asset name，仅允许白名单文件；禁止任意路径、
   `..`、绝对路径或 MIME 欺骗。
4. Rust 读取资源并向 pet 子 WebView 提供可消费结果。可选方案应先比较后定稿：
   - 首选受控自定义 URI/protocol 或 Tauri asset URL，避免每次把大 WebM base64 化；
   - 若沿用 command，返回受限资源 URL/二进制，而不是源码路径；
   - GIF fallback 同样走该边界。
5. `src/pet/pet.tsx` 初始加载一次 built-in asset manifest，例如
   `{ idle, turn, move, wave, waiting, running, review, failed, bubble, fallback }`，然后用返回 URL
   构建 `ASSET_URLS`；不得再保留这些媒体的 ESM import。
6. 资源加载失败使用 `PET_BUILTIN_ASSET_*` 大写错误前缀，并有明确 fallback/错误日志。

待办：

- [ ] 复用/扩展 `get_pet_asset`，或新增命名清晰的 built-in asset manifest command。
- [ ] 抽出“内置插件目录解析”函数并测试 development、production resource layout。
- [ ] 校验所有 9 个 WebM + GIF 均来自 `dsh-tauri-pet/assets` 白名单。
- [ ] 更新 `src/hooks/use-iframe-invoke.ts` command allowlist（如果新增命令）。
- [ ] 删除 `src/pet/pet.tsx` 的 10 个跨包媒体 import。
- [ ] 验证 `pnpm build` 输出不再把这些媒体复制为 Vite ESM asset；Tauri release 中插件目录资源完整。
- [ ] 开发版、安装版 3080、路径含中文/空格的安装目录都要验证。

## 5. 动作与气泡仲裁规范

继续实现前先提取纯 reducer/state machine 并写单元测试，不要再把规则散落在多个 effect 和
pointer handler 中。

建议输入：

- `sessionActivity`: idle / waiting / running / review / failed
- `interactionActivity`: null / turn / moving-left / moving-right / waving / bubble
- `dragPhase`: idle / starting / dragging / ending
- `sessionToastEvents[]`（只用于决定何时调用 `toast()`，不是自建 UI queue）
- `interactionToastEvent`（允许时调用一次 `toast()`）

最低规则：

1. waiting/running 视为 work lock。
2. work lock 时：
   - 点击无 waving/bubble 动画；
   - 点击不添加交互 Toast；
   - 拖动仍可移动窗口，但不得覆盖 work 动画和会话 Toast。
3. review/failed 的点击策略必须在实现前明确并测试；默认应优先保留会话状态，不让点击覆盖。
4. 非 work 的 idle 状态允许：
   - 点击 → waving + 一条交互 Toast；
   - 双击 → bubble effect，但不能破坏已有会话 Toast。
5. 拖动方向动画只在没有更高优先级会话动画时成为有效视觉状态。
6. 同一时间只播放一个宠物视觉动作，但会话 Toast 可以多条叠加。
7. 所有一次性动作结束后恢复当前 sessionActivity，而不是写死 idle。
8. 新高优先级状态到来时，取消低优先级动作的 timer/Promise 后续提交，防止过期回调覆盖状态。

建议有效动作优先级：

```text
failed/review/running/waiting（会话）
  > dragging direction（仅无 work lock 时显示）
  > click/double-click interaction
  > idle
```

最终优先级需结合 dsh-pet 与 Codex pets 对照结果确认，但必须满足用户明确的 work 阻塞规则。

## 6. HeroUI Toast 实施要求

- 继续使用项目现有 `src/components/toast-provider.tsx` 和 `src/utils/toast.ts`；不要在 pet 内部
  新建或直接操作 `Toast.Queue`。
- `src/pet/main.tsx` 已用 `ToastProvider` 包裹 `PetWindow`，这是用户修复 Toast 可见性的改动，
  应保留。
- 多会话叠加的实现是多次调用 `toast()`：每个进行中会话调用一次，不额外处理 HeroUI queue。
- `toast()` 返回单条 Toast key；必须维护 `sessionId → toastKey`，用于按会话精确关闭。
- 单个会话完成/失败/取消/离开进行态时调用 `toast.close(key)`，实时关闭对应 Toast。
- `toast.clear()` 只表示清除全部 Toast，仅限 pet hide、WebView 卸载或全局重置；普通显示流程
  和单会话状态变化不得调用，否则会删除其他会话的 Toast。
- 进行中会话 Toast 不应依赖固定 timeout 自动消失；其主要生命周期由该会话实时状态和
  `toast.close(key)` 管理。点击类短提示仍可使用 timeout。
- 不传 `isLoading`，不传 action，不新增关闭按钮。
- Toast 应位于宠物之上，尺寸增大时仍不覆盖角色头部。
- Toast 容器必须保持透明桌面窗口安全，不得给 html/body/root 添加不透明背景。
- 如果采用独立 toast 窗口，窗口必须鼠标穿透，并与 pet 的移动、尺寸和 DPI 同步。
- 必须验证中文长文本、英文、连续多次 `toast()`、超时、会话状态切换与 pet hide/show。

## 7. 代码地图

### 插件客户端

- `packages/dsh-tauri-pet/src/client/components/pet-settings.tsx`：双 tab、卡片、导入、底部尺寸滑条。
- `packages/dsh-tauri-pet/src/client/register/pet.ts`：设置页注册、新会话创建、prefill map。
- `packages/dsh-tauri-pet/src/client/components/prefill.tsx`：调用 `inputActions.setDraft()`，不得 submit。
- `packages/dsh-tauri-pet/src/client/service/activity.ts`：会话状态 → pet activity/bubble bridge。
- `packages/dsh-tauri-pet/src/client/utils/activity.ts`：状态映射和 Unicode bubble 截断。
- `packages/dsh-tauri-pet/src/client/service/pet.ts`：Tauri invoke 协议。
- `packages/dsh-tauri-pet/src/client/dom/sidebar-icon.ts`：启用与瞬时 show/hide。
- `packages/dsh-tauri-pet/src/client/styles/index.ts`：css-render 设置页样式。

已修复过的精确错误，避免重复排查：

```text
src/client/service/pet.ts(1,88): error TS1002: Unterminated string literal.
```

原因是 `../types` import 缺少闭合引号；当前已经修复。

### Pet WebView

- `src/pet/pet.tsx`：状态事件、WebM/atlas、HeroUI Toast、点击与 Tauri 原生拖动。
- `src/pet/pet.css`：透明窗口、宠物尺寸和 Toast 样式。
- `src/pet/state.ts`：纯视觉/atlas 状态逻辑。
- `src/pet/state.test.ts`：纯状态测试，由根 `vite.config.ts` 的 test include 发现。
- `src/pet/main.tsx`：用户已加入项目级 `ToastProvider`，必须保留。
- `src/utils/toast.ts`：统一 `toast()`、`toast.close(key)`、`toast.clear()` API；pet 不直接管理 queue。

### Rust/Tauri

- `src-tauri/src/bridge/pet.rs`：状态、持久设置、列表、素材、ZIP 导入、activity/bubble、窗口移动命令。
- `src-tauri/src/desktop/pet.rs`：窗口创建、尺寸、位置、显示/隐藏；顶部透明区域问题的主要位置。
- `src-tauri/src/config/setting.rs`：pet 设置默认值和 stale whole-setting 写保护。
- `src-tauri/src/desktop/builder.rs`：命令注册。
- `src-tauri/capabilities/default.json`：窗口权限。
- `src/hooks/use-iframe-invoke.ts`：iframe invoke 白名单。

## 8. 安全导入约束（不得回退）

Codex ZIP 导入已经实现以下约束，后续重构不可弱化：

- 压缩文件最大 32 MiB；
- 最多 512 entries；
- 解压总量最大 128 MiB；
- manifest 最大 64 KiB；
- spritesheet 最大 8 MiB；
- 拒绝 traversal、绝对路径、反斜杠/冒号路径、symlink/special entry、重复输出路径；
- 只接受 v2 PNG/WebP spritesheet；
- 图片维度必须可被 8×11 整除，单边不超过 16384，总像素不超过 64 Mi；
- 使用进程 mutex 串行导入；
- 先进入 staging，再按 manifest id 原子 rename；
- 失败只清理本次 staging，不能误删别的导入；
- 不能以 ZIP 上传文件名决定最终宠物目录。

## 9. 测试与验收清单

### 9.1 自动测试

继续后至少运行：

```bash
pnpm --filter dsh-tauri-pet typecheck
pnpm --filter dsh-tauri-pet build
pnpm typecheck
pnpm exec eslint src/pet packages/dsh-tauri-pet/src/client --max-warnings=0
pnpm exec vitest run src/pet/state.test.ts
pnpm --filter dsh-tauri-pet exec vitest run src/client/utils/activity.test.ts
pnpm test -- --run
pnpm build

cargo check --manifest-path src-tauri/Cargo.toml --lib
cargo test --manifest-path src-tauri/Cargo.toml bridge::pet::tests --lib
cargo test --manifest-path src-tauri/Cargo.toml desktop::pet::tests --lib
cargo test --manifest-path src-tauri/Cargo.toml --lib

git diff --check
```

说明：整个仓库 `cargo fmt --all -- --check` 和全 workspace ESLint 存在任务外历史问题；仍要对
本次修改文件做 scoped rustfmt/ESLint，且目标路径必须零 warning。

### 9.2 当前检查点已通过，但不是最终验收

在最新回归报告之前/保存检查点时已通过：

- `pnpm typecheck`
- 目标 pet/plugin ESLint，零 warning
- pet Vitest：6/6
- plugin activity Vitest：3/3
- Rust desktop pet tests：4/4
- 此前完整 `pnpm test -- --run`：27 files / 200 tests
- 此前 `cargo test --lib`：452 passed
- 此前 `pnpm build`
- 此前 `pnpm tauri build --no-bundle`
- `git diff --check`

这些测试没有覆盖用户最新指出的 UI 回归，不能据此宣称功能完成。

### 9.3 手工矩阵

#### 拖动与 DPI

- [ ] 100%→100% 两屏，左右拖动与鼠标 1:1。
- [ ] 100%→125%、100%→150%、125%→200% 混合 DPI。
- [ ] 两屏左右、上下、负坐标排列。
- [ ] 跨屏过程中方向动画持续；结束后恢复正确 session activity。
- [ ] 内置 WebM 和 Codex atlas 分别验证。

#### 窗口命中区域

- [ ] 50%、100%、150%、200% 尺寸。
- [ ] 宠物外透明区域可点击到底下应用。
- [ ] 宠物可点击/拖动。
- [ ] Toast 区域不阻塞桌面点击。
- [ ] hide/show 后命中区域和 Toast 窗口同步。

#### 动作/气泡仲裁

- [ ] idle 单击：waving + 交互 Toast。
- [ ] idle 双击：bubble effect，且不清掉会话 Toast。
- [ ] waiting/running 点击：无新动画、无新气泡。
- [ ] work 中拖动：窗口可移动，但 work 动画/气泡保持。
- [ ] 两个进行中会话分别调用两次 `toast()`，同时显示两条 Toast，不显示关闭按钮和 loading。
- [ ] 其中一个会话完成时立即 `toast.close(key)` 关闭对应单条，另一个会话 Toast 保持显示。
- [ ] pet hide/WebView 卸载时 `toast.clear()` 清除全部 Toast。
- [ ] review/failed 转换后没有旧 timer 把状态覆盖回 idle。
- [ ] 中文长文本不会覆盖宠物或超出窗口。

#### 设置与数据

- [ ] 首次安装宠物默认关闭。
- [ ] 第一次启用后重启仍启用。
- [ ] 收起后本次隐藏，重启后已启用宠物恢复显示。
- [ ] 大小滑条在两个 tab 的页面底部。
- [ ] Create 新会话仅 prefill 精确提示词，不自动发送。
- [ ] Chat 列表读取 DSH pets；Codex 列表读取 `~/.codex/pets`。
- [ ] ZIP 导入安全约束有正向与恶意样例测试。

## 10. 生产 GUI 验证与部署

目标 GUI 是现有 `http://127.0.0.1:3080`，不是另起的 Vite 页面。

已知环境：

- 安装版 executable：
  `D:\software\Deepseek Harness Desktop\deepseek-harness-desktop.exe`
- 当前仓库 release executable：
  `D:\projects\dsh-tauri-desk\deepseek-harness-desktop\src-tauri\target\release\deepseek-harness-desktop.exe`
- 安装版资源：
  `D:\software\Deepseek Harness Desktop\resources\node_modules`
- production profile：
  `C:\Users\wwu71\.dsh\profiles\alpha\package.json`

最终继续时：

1. 重新构建插件、Web shell 和 Tauri release；旧 release 构建早于最新修复，不能直接当最终产物。
2. 关闭/替换安装版 executable 与 resources 时保留用户 profile 数据。
3. 不启动替代 server 冒充 3080。
4. 刷新现有 3080 GUI，确认生产 profile 实际加载 `dsh-tauri-pet`。
5. 使用浏览器/DevTools 检查 console、插件激活状态、设置页和 Tauri 窗口行为。
6. 记录截图或可复现步骤，完成上述混合 DPI 与 Toast 交互矩阵。

## 11. 下一轮建议顺序

1. 先运行当前测试并在 GUI 复现三项回归，记录视频/截图和显示器 DPI。
2. 阅读三个子模块的指定代码，形成差异对照表。
3. 先实现并测试纯动作/气泡仲裁 reducer。
4. 用 `onMoved` + OS `startDragging()` 恢复拖动方向动画，保持跨 DPI 原生拖动。
5. 由 Rust 从内置插件部署目录加载 built-in 媒体并提供给 pet 子 WebView，删除跨包 ESM asset import。
6. 将 Toast 从 pet 主窗口的固定顶部占位中解耦，优先验证独立鼠标穿透窗口。
7. 以 `sessionId → toastKey` 驱动多次 `toast()` 和实时 `toast.close(key)`；不要改造或自行管理 HeroUI queue。
8. 跑自动测试、构建和完整手工矩阵。
9. 构建/部署并验证现有 3080 GUI。

## 12. 本检查点明确不代表完成

该提交是用户要求的下班交接检查点，包含大部分新规格实现及最新未解决回归。不要合并为最终功能，
不要关闭目标/issue，也不要根据自动测试通过就宣称 UX 已验收。继续工作的首要任务是解决本文第 1 节。
