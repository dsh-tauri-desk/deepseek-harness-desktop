# 规范评审（SPEC-REVIEW）

> 视角：一次「把整套规范实际执行到底」之后的复盘。
> 覆盖范围：`AGENTS.md` → `docs/AGENTS.desktop.md` + `docs/AGENTS.plugins.md`，
> 以及本轮口头追加的 hooks / 目录 / 命名规则（reause 化、`ui/<领域>/`、`Panel.*` 复合组件、
> `config/hooks` 事件总线、`useWakeLock`、内联根副作用、删除中间层组件等）。
> 结论先行：**这是一套「以"唯一来源 + 声明式副作用"为核心的架构规范」，而不是风格规范。**
>
> **本文分两部分**：
> - 第一部分（§1–§8）**规范评审**：这套规范长什么样、强项与张力在哪，写于改造进行中；
> - 第二部分（§9–§22）**重构实战手册**：把整套改造（壳层 reause 化 → 桥迁到插件侧 → Rust 删 shim →
>   typecheck/lint/CI 交付）全过程踩过的坑、判定顺序与检查清单固化下来，供下一次重构直接照做。

---

## 1. 一句话画像

> 风格交给 eslint（antfu preset）和框架（HeroUI / react-compiler），
> 规范只回答三件事：**副作用怎么写**（reause）、**代码放哪里**（components / ui / hooks / store）、
> **一个事实允许存在几份**（一律一份）。

它有三个不太常见的取向：

1. **能用 hook 表达的行为，不允许用命令式 effect 表达**——把「什么时候执行」从时序问题变成依赖问题。
2. **能删的中间层一律删**——只做转发的组件、只做包装的函数、只存在于一个模块的 util，都不配拥有独立文件。
3. **规范与事故记忆绑定**——注释里常驻 `issue #469` / `#437` / `#303` / `#441` 这类编号，
   写的是「为什么必须这样」，而不是「这样写更优雅」。

---

## 2. 四条主干（含本轮证据）

### 主干一：副作用声明式化（reause 收口）

`useEffect` 被压缩为最后手段，其余全部映射到 reause：

| 需求 | 写法 | 本轮替换量 |
| --- | --- | --- |
| 观察值变化 | `useWatch` / `useWhenever` | plugin-recovery、pet-window、pet-source、harness-updater |
| 仅挂载一次 | `useMount` | layout、setup-preinstall、preinstall store 调用点 |
| 订阅 Tauri 事件 | `useListen`（`hooks/use-listen.ts`） | dsh-plugins / dsh-profiles / dsh-cores / backup / theme / pet-status / macos-menu / update-core |
| DOM 事件 | `useEventListener` | iframe 四个 message 桥、zoom、dev 快捷键 |
| 轮询 / 延时 | `useIntervalFn` / `promiseTimeout` | 桌面端更新轮询、iframe 可见性兜底、备份探测 |
| 系统偏好 / 溢出 | `usePreferredDark` / `useElementOverflow` | theme、ellipsis |
| 布尔开关 | `useToggle` | config-core / config-profile / backup |
| 跨组件瞬时事件 | `createEventHook` + `useListener(hooks[key].on, cb)` | `config/hooks.ts` 两个键 |

结果：`useEffect` 从「十几个文件里到处都是」收敛到 **8 个文件、8 处，且每一处都需要注销外部资源**
（Tauri 窗口 `onResized/onMoved`、`listen` 的注册竞态、在途下载取消、ref 同步）。
同时 `react-use` 与 `@hairy/react-lib` 被彻底摘除（依赖树 + lock 均已无这两个包）。

**评价**：这条主干最大的收益不是"少写代码"，而是**消除了 effect 之间的隐式时序**。
`listen → resolve → setState` 这类竞态过去在 12 个地方各写一遍（还各带一个 `disposed` 标志），
现在只有一个实现、一种语义。

### 主干二：唯一来源（single source of truth）

本轮几乎所有指令都可以还原成同一句话：**同一事实只允许存在一份，其余地方要么 import，要么删除。**

- `delay` 本地实现 → `@hairy/utils` 的 `delay`；
- `readiness` / `runtime-exit` / `internal-plugin-phase` 从 `utils/` 搬进 `store/modules/harness/`——
  它们本来就只服务 harness 状态机，放在全局 utils 里等于宣布"谁都能用"；
- `panel-header` + `panel-loadable` + `panel-progress` → 一个 `Panel`（`Panel.Header/Loadable/Progress`）；
- `desktop-updater` / `download-toast-trigger` / `harness-updater` 三个组件 → 内联进 `layout/index.tsx`
  （它们只产出副作用或一个 holder，不值得各自占一个文件）；
- `use-macos-app-menu` → 内联进 `navbar.tsx`（只有一个消费方）；
- `events.ts` 两个 `createEventHook` → 收进 `config/hooks.ts` 的 `hooks` 键表；
- `writeClipboardText` 的 toast 从 4 个调用点收进 helper（避免"同一动作在多处提示"）；
- `navigator.wakeLock` 猴补丁 → `useWakeLock` + `useWatch(..., release)`。

**评价**：这是整套规范里最"硬"的一条，也最容易被低估。它的真正作用是把**重构成本从 O(引用点) 降到 O(1)**：
删掉一个中间层，编译器立刻告诉你还有谁在依赖它。

### 主干三：目录即架构（components / ui / hooks / store / styles）

| 位置 | 判定标准 | 本轮落点 |
| --- | --- | --- |
| `components/` | 只依赖 HeroUI / reause / 纯工具，无业务语义 | `panel.tsx`、`logs.utils.ts`、`ellipsis/item/info/logs/modal` |
| `ui/<领域>/` | 依赖 store、Tauri 命令或某业务领域 | `ui/config/*`(7)、`ui/dialog/*`(4)、`ui/pet/hint`、`ui/plugin/recovery` |
| `hooks/` | 可复用的 React 行为（含跨窗口的 `useWindowDraggable`） | 14 个 |
| `store/modules/<name>/` | 状态 + 该状态专属的纯函数 | harness 内聚 `readiness/runtime/utils/constants` |
| `layout/index.tsx` | 壳层唯一根副作用挂载点 | 启动、更新轮询、下载提示、更新提示、唤醒锁 |

命名规则同样"随位置走"：进 `ui/config/` 就去掉 `config-` 前缀（`backup.tsx`），
进 `ui/dialog/` 就去掉 `-dialog` 后缀（`about.tsx` / `update.tsx` / `update-core.tsx`）；
复合组件用点号导出而不是多文件（`Panel.Header`），与 HeroUI 的 `Modal.*` / `Select.*` 一致。

**评价**：`components` vs `ui` 的切分是整个规范里**最容易判断、也最容易自动化检查**的一条
（"这个文件 import 了 store 吗？"）。它替代了常见的 `features/` `modules/` `shared/` 三件套，
规则少、歧义小。

### 主干四：规范 = 运行手册（不只写"应该"，更写"为什么必须"）

`docs/AGENTS.desktop.md` 的 Pitfalls 段落里是 pnpm store 绑定、原生模块 ABI、Windows 进程树、
Linux inotify 上限这类**真实的、会让人损失半天时间**的故障；注释里写的是
"为什么必须 `CREATE_NO_WINDOW`"、"为什么 `startDragging()` 的 Promise 不代表拖拽结束"。

**评价**：这使它区别于大多数 AGENTS.md（那些只是风格清单）。
事故记忆被固化下来之后，规范才具备"防止同一个坑踩第二次"的能力——
这也是它特别适合 AI 协作者的原因：agent 读规则会偷懒，读"踩坑史"不会。

---

## 3. 规范里没写、但一直在遵守的隐含原则

1. **能删就删，不留兼容层**：本轮净减 8 个文件（删 10 / 增 2），没有一处 `_legacy` / `_old` 过渡。
2. **一个文件一个存在理由**：说不出"它为什么不能被合并"的文件会被合并。
3. **why > what**：注释只解释原因与平台差异，不解释代码本身在做什么。
4. **平台差异显式化**：Windows / macOS / Linux 的分支必须留下依据（issue 号或上游行为）。
5. **测试锁"接线"，不只锁"行为"**：`readFileSync` + 字符串断言，专门防止"改了 A 忘了改 B"。
6. **重构以 `git mv` 进行**：保留 blame 与 diff 可读性（本轮 23 处重命名全部如此）。

---

## 4. 强项（可验证，不是感受）

- **删除率高**：一次深度改造删掉 10 个文件、合并 3 个组件、内联 3 个组件，几乎没有为此付出可读性代价。
- **grep 成本极低**：想知道"谁在订阅事件"只需 `useListen`；想知道"哪些 effect 还活着"只需数 `useEffect`。
- **路径可预测**：看到 `ui/config/plugin.tsx` 就能推断它依赖 `store/modules/plugin`（如存在）与 `@/components/*`。
- **和编译器/新库同向**：`no useCallback/useMemo` + react-compiler、reause 声明式副作用、
  HeroUI 复合组件，三者不互相打架。
- **对 AI 友好**：规则表 + 目录决策 + 事故库，正好是 agent 最容易消费的三类文档形态。

---

## 5. 张力与风险（这一节是评审的重点）

### 5.1 规范靠"最新口头指令"承载，缺少版本与动机索引

现象：本轮十几条规则都是对话里给出的；`AGENTS.desktop.md` 只是被动追认。
影响：新协作者（人或 agent）不知道哪条是硬约束、哪条是偏好，也不知道例外的边界。
建议：把每条规则写成三元组 **规则 / 动机 / 反例**，并在文首标注"必须 / 建议 / 仅供参考"三档；
本次已在 `docs/AGENTS.desktop.md` 的 Hooks 段落先试了表格化的写法，可以推广到全部规则。

### 5.2 源码契约测试与"搬迁型重构"强耦合

现象：本轮 17 个测试文件被改动，其中大多数只是 `new URL('../src/components/config-x.tsx')` 换路径。
影响：重构的摩擦成本被转移到测试上，长期会让人"懒得搬"，规范随之腐化。
建议：二选一——
① 路径断言集中到一处（如 `test/contracts/paths.ts` 导出 `SOURCES.pluginPanel`），搬迁只改一行；
② 契约测试改为**行为断言**（导入真实模块、断言导出与调用），仅在需要时读源码。
`test/wake-lock.test.ts`（断言两个入口都释放唤醒锁）已经是"语义断言"的正确形态，可作为模板。

### 5.3 `useEffect` 的例外只有原则、没有白名单

现象："只在需要卸载清理时使用"依赖判断力；`src/hooks/use-invoke.ts`（本轮新增、目前无人引用）
就写成了 `useEffect(..., [channel, args, options])`。
建议：显式列出合法类别 + 注释标记，例如：

```tsx
// keep:effect 取消在途请求（无法用 reause 表达）
useEffect(() => { ... }, [disposable])
```

再配合 lint 最小检查（禁止 `react-use` / `@hairy/react-lib`、对新增 `useEffect` 给出告警）。

### 5.4 目录树会腐化，决策树不会

现象：`AGENTS.desktop.md` 里的树两轮内已被改写两次（`config-*` → `ui/config/*`、`panel-*` → `panel.tsx`）。
建议：文档只保留"放哪里的判定顺序"（4 条问句即可），具体文件清单交给 `tree`/README，
或用一个脚本生成，避免文档与仓库赛跑。

### 5.5 `src/utils/` 有杂货铺倾向

现象：本轮把 `log` / `readiness` / `runtime-exit` / `events` 四类"其实有明确归属"的东西搬走，方向正确。
建议：把判定写成硬规则——
**只被一个 store 模块使用 → 该模块目录内；跨模块且无状态 → `utils/`；含 React → `hooks/`；
含副作用生命周期 → `hooks/` 或 store 模块。** `utils/` 只留纯函数与全局单例（toast / clipboard / zoom / logger）。

### 5.6 规范假设了"串行重构"，并发写同一工作区会互相踩

现象：本轮我与另一个会话同时改同一棵树——一次 `git stash` 误伤了对方未提交的工作，
随后对方又开了一波（`use-invoke.ts`、`bubble-copy` → `pet/utils/bubble.ts`），
目前索引里两方改动被一起 `git add` 了。
建议：在 `AGENTS.md` 增加协作条款：重构前先 `git status` 声明范围；避免对整棵树做
`stash`/`checkout`/`reset` 这类粗粒度操作；并发时改成"新增文件 + 明确点名的编辑"。

### 5.7 "提示只出现一次"尚未成为显式规则

现象：`writeClipboardText` 的 toast 收口之前，成功/失败提示在 4 个调用点各写一份。
建议：补一条 **副作用与用户提示的唯一出处** 规则（谁执行谁提示，调用点只记日志），
并把"重复 toast"列入 review checklist。

### 5.8 reause 优先 ≠ reause 万能

现象：`ellipsis.tsx` 改用 `useElementOverflow`（ResizeObserver + MutationObserver）后，
语义更好，但"打开前同步测量"变成了"依赖观测值"，字体切换这类不改变盒子的场景理论上可能过期；
反之 `useListen` / `useWatch` / `useMount` 的替换是纯收益。
建议：规范写成 **"优先 reause；不适用的地方必须留下 `// reause 不适用：<原因>` 注释"**，
把例外显式化，而不是留成"这次没换可能是忘了"。

---

## 6. 成熟度评分（主观，但明确）

| 维度 | 分数 | 依据 |
| --- | --- | --- |
| 一致性 | ★★★★★ | 规则少而正交，冲突时能明确裁决（唯一来源 > 就近放置） |
| 可执行性 | ★★★★☆ | 大部分规则人工可判定；少数（`useEffect` 例外）依赖经验 |
| 可自动验证 | ★★★☆☆ | 目录/依赖方向可脚本化，但尚未落地任何 lint/CI 检查 |
| 重构友好度 | ★★★☆☆ | 代码侧极友好；测试侧（源码路径断言）拖后腿 |
| 新人/AI 上手成本 | ★★★★☆ | AGENTS.* + 事故库很有效；规则仍未分级（必须/建议） |
| 长期抗腐化 | ★★★☆☆ | 文档树与"口头规则"是主要腐蚀点 |

---

## 7. 下一步（按性价比排序）

1. **给规范分级**：`必须 / 建议 / 反例`，先做 Hooks 与目录两部分（成本最低、收益最大）。
2. **落地 3 条 lint 规则**：禁止 `react-use`/`@hairy/react-lib`；`useEffect` 新增加注释标记；import 顺序。
3. **测试路径契约集中化**（5.2），让下一次搬迁只改一处。
4. **`AGENTS.desktop.md` 拆分**：规则（AGENTS.desktop.md）+ 事故库（`docs/PITFALLS.md`），
   两者现在混在一起，读者目标不同。
5. **目录树改为决策树**，文件清单用脚本生成。
6. **补并发协作条款**（5.6），并把"提示/副作用唯一出处"写进 checklist（5.7）。
7. **清理遗留**：`src/hooks/use-invoke.ts` 目前无引用且用了 `useEffect`，按规范应删除或改写。

---

## 8. 附录：本轮深度改造的量化观察

| 指标 | 数值 |
| --- | --- |
| `git mv` 重命名 | 21 处（另 2 处为并发会话所改） |
| 删除文件 | 10（3 个 panel 件、3 个 layout 组件、`use-macos-app-menu`、`events`、`disable-wake-lock`、`internal-plugin-phase`） |
| 新增文件 | 2（`components/panel.tsx`、`config/hooks.ts`；`hooks/use-listen.ts` 在早前轮次加入） |
| 文件净变化 | −8 |
| `useEffect` 收敛 | 由 15+ 文件 → **8 文件 8 处，且全部需要卸载清理** |
| 依赖摘除 | `react-use`、`@hairy/react-lib`（lock 已无残留） |
| 测试改动 | 17 个文件（含 1 个重命名） |
| i18n 新增键 | 2（`messages.clipboard_copied` / `messages.clipboard_failed`，中英同步） |
| 并发写入事故 | 1 次（`git stash` 误伤；`stash@{0}` 与 `.temp/reause-wip.patch` 留有备份） |

> 一句话收尾：这套规范真正稀缺的地方在于**它敢于删代码，并且要求每次删除都留下理由**；
> 它目前最大的短板不在规则本身，而在**规则的表达形式（分级、可检查、可生成）**和
> **测试对重构的摩擦**。前者是文档问题，后者是工程问题，都不难修。

---

# 第二部分：重构实战手册

> 这一部分是**操作手册**，不是评价。全部内容来自一次完整改造（最终以 PR #500 交付，CI 全绿），
> 每条都对应一个真实发生过的判断或事故。写下来的目的只有一个：**下一次重构不必重新踩一遍**。

## 9. 本轮改了什么（地图）

| 区域 | 变化 |
| --- | --- |
| 壳层 hook | 全部改用 reause（`useWatch` / `useMount` / `useUnmount` / `useListen` / `useEventListener` / `useIntervalFn` / `promiseTimeout` / `usePreferredDark` / `useElementOverflow` / `useToggle` / `useListener`），`react-use` 摘除 |
| 壳层目录 | `ui/config`（+`components/`、`hooks/`）、`ui/dialog`、`ui/pet`、`ui/plugin`、`styles/`、`types/`、`config/query-keys.ts` |
| 数据层 | 4 个 `use-dsh-*` 内联到唯一消费者；查询键集中；跨消费者缓存由根布局单点写 |
| 桥 | dsh-tauri 客户端补齐 `service/`（invoke / listen / invokeParent / listenParent）+ `hooks/` + `register/*`；Rust 侧删除 `nav.rs`、`style.rs`、zoom 快捷键桥 |
| 缩放 | 真值 `store.setting.zoom_factor` → `useZoomFactor` 落地；平台能力用 `@tauri-apps/plugin-os` 判定 |
| 交付 | `pnpm typecheck` / `lint` / `build:plugins` / `vitest` / `cargo check --locked` 全绿；PR #500 CI 5 个 job 全绿 |

量化：174 files changed、+4658 / −5075；删除 Rust shim 文件 3 处（`nav.rs`、`style.rs` 与 zoom 桥常量）、
删除壳层/插件 hook 与组件文件 8 个；新增 `register/*`、`utils/zoom.ts`、`query-keys.ts`、`types/*` 等。

## 10. 十条硬规则（可直接当 review checklist）

1. **一个事实一份**。本轮的真值表：插件列表 → react-query 缓存 `queryKeys.plugins`；缩放 → `store.setting.zoom_factor`；
   插件异常修复态 → `store.recovery`；平台能力 → `@tauri-apps/plugin-os`；导航折叠状态 → 宿主 `webview.tsx` 的本地 state。
   发现第二份（哪怕只是"顺手的副本"）就删掉一份。
2. **只有一个消费者 → 不建中间层**。hook、组件、命令包装、`utils` 文件都一样：能内联就内联。
3. **写缓存只留一处**。多个组件读同一份数据时，只有"谁把外部事件写进缓存"要收敛（本轮是 `layout/index.tsx` 订阅
   `dsh-plugins-updated` → `setQueryData`），其余消费者只读同一个 key。
4. **查询键集中**在 `src/config/query-keys.ts`，禁止业务文件里散落 `queryKey: ['plugins']`。
5. **契约类型**（Rust 序列化形态）放 `src/types/<领域>.ts` + barrel；组件 props 就近定义在组件文件里。
6. **桥只用白名单原语**：`invoke` / `listen` / `invokeParent` / `listenParent`（+ React 版本）；
   来源校验只在原语里做一次；协议分支只按 `data.type` 分发，不再比对 `data.source`。
7. **能放插件侧就不放注入脚本**（判定表见 §13）：插件跑在 dsh 里，能用应用自己的 API，比 DOM 猜测稳。
8. **归一化在写入侧做一次**，读取侧再做一次兜底（前端算缩放档位，Rust `normalize_zoom_factor` 读时兜底）。
9. **平台差异必须显式且前置**：能力不支持的平台要在"调用之前"判定，不能靠调用失败回退（本轮 macOS 10.15 的
   `WKWebView.pageZoom` 就是崩溃而不是报错）。
10. **重命名/删除原语后立刻 grep 旧符号**。本轮的真实事故：出站原语从本地 `post()` 改成 `invokeParent()` 时漏改一处，
    运行时抛 `ReferenceError: post is not defined`，被插件的 `guard` 捕获后又上报成"插件运行期错误"，
    最终呈现为**修复弹窗**——排查成本远高于当初 grep 一次。

## 11. reause 迁移手册

| 需求 | 写法 | 注意 |
| --- | --- | --- |
| 值变化即执行（含首次） | `useWatch(dep, cb, { immediate: true })` | 本轮所有"挂载即应用一次 + 变化重应用"都用它（缩放真值 → WebView、更新提示） |
| 仅挂载一次 | `useMount(cb)` | 探测类副作用（`refresh_plugin_updates`、首次读数） |
| 卸载清理 | `useUnmount(cb)` | 与 `useMount` 成对使用 |
| 订阅外部事件 | `useListen(event, cb, options?)` | 回调经 ref 转发，闭包不会过期；**不要**再自建 `disposed` 标志 |
| DOM 事件 | `useEventListener(type, cb, options?)` | 支持 capture（缩放快捷键） |
| 轮询 / 延时 | `useIntervalFn` / `promiseTimeout` | 桌面端更新轮询、iframe 可见性兜底、备份探测 |
| 系统偏好 / 元素溢出 | `usePreferredDark` / `useElementOverflow` | 主题、省略号 |
| 布尔开关 | `useToggle` | 面板里的 loading/展开态 |
| 跨组件瞬时事件 | `createEventHook` + `useListener(hooks[key].on, cb)` | 键集中登记在 `config/hooks.ts` |
| 组合多个值 | `useWatch([a, b], cb, ...)` | 数组依赖，避免手写 `useMemo` |

**仍必须用 `useEffect` 的场景**（本轮只剩 8 处）：需要注册并注销**外部资源**——
Tauri 窗口 `onResized` / `onFocusChanged`、在途任务取消、ref 同步、`MutationObserver`。
建议统一注释 `// keep:effect <原因>`，把例外显式化（§5.3）。

**react-compiler 约束**：不要 `useCallback` / `useMemo`；具名函数用 `function` 声明，箭头只做回调。
这不是风格问题——加上 `useMemo` 反而会阻止编译器优化。

## 12. 把 hook 内联进消费者：行为等价清单

内联（4 个 `use-dsh-*` + `use-desktop-zoom`）最容易丢的不是代码，而是**语义细节**。逐项核对：

- [ ] **busy / pending 标记**：`create.isPending || activate.isPending || …` 是否都覆盖（内联后漏一项，按钮就不再禁用）。
- [ ] **是否等待重新拉取**：`await refetch()` 与 `void invalidateQueries()` 不等价。
  本轮刻意保留两种：切换核心/档案"不等联网重拉"（旧服务仍在运行时等重拉会扩大竞态窗口）；
  下载/卸载/更新后"等列表刷新再 toast"（否则用户看到的是旧列表）。
- [ ] **错误提示归属**：mutation 的 `onError` toast 与调用点 catch 的 toast 不能重复；helper 里 unified 的提示
  （如 `writeClipboardText`）不要把成功提示再写回调用点。
- [ ] **挂载探测的时点变化**：`useMount(refreshUpdates)` 原本随"导航栏挂载"跑，内联到面板后变成"打开面板才跑"——
  确认依赖它的 UI（升级按钮）也在面板里。
- [ ] **值不变不重复写**：用 `lastAppliedRef`（或等价守卫）避免重复渲染重复触发外部写。
- [ ] **卸载清理**：内联时容易丢掉 `controller.dispose()` / `unlisten()`。
- [ ] **多消费者不要复制**：内联 >1 个消费者时，复制的是"读取"，不是"写入"（§10.3）。

## 13. 壳层 ↔ iframe 桥规范

**协议**：`{ type, ...payload }`；`source` 字段保留兼容但不参与判定；`event.source === window.parent`（iframe 侧）与
`event.source === iframe.contentWindow` + origin（宿主侧）各校验一次。常量集中在
`packages/dsh-tauri/src/client/constants/index.ts`，与宿主字面量逐字一致。

**能力放哪一侧（本轮判定表）**：

| 能力 | 归属 | 判定依据 |
| --- | --- | --- |
| 侧边栏切换 / 折叠回报 | 插件 `register/sidebar.ts` | 有应用级 API（`ctx.layout`），无需 DOM 猜测 |
| 缩放快捷键 | 插件 `register/zoom-shortcut.ts` | 跨域 iframe 按键不冒泡，插件在 iframe 内捕获即可 |
| iframe 全局样式 | `dsh-tauri-ui` `styles/global.cssr.ts` | 纯样式，插件侧 `mountStyle` 更可控 |
| 通知 API 垫片 | **保留 Rust shim** | 需要替换 `window.Notification` 与 `document.hidden`，属 API 垫片而非通讯 |
| 剪贴板图片回退 | **保留 Rust shim** | 必须在应用自己的 `paste` 监听**之前**接管（捕获阶段 + 时序） |
| boot 失败探测 | **保留 Rust shim** | 必须在**任何插件加载之前**运行（插件挂了就没人报信） |
| WebKit `AbortSignal.any` 兼容 | **保留 Rust shim** | 页面脚本执行前就要就位 |

**让位标记必须"按命令"**：早期 shim 的 `window.__dsh_tauri_bridge__` 一旦置位就"命令与事件全停发"。
当插件只接管其中一条命令时，这种全局让位会导致**其它能力直接消失**；反之若不让位，则同一条命令被处理两次
（侧边栏切两次 = 看起来没反应）。正确做法是：标记语义收窄到"插件接管了侧边栏切换"，shim 只在 toggle 分支让位。

**删除一个注入 shim 的检查清单**：
1. 注入点：`desktop/builder.rs`（非 Windows 链）、`desktop/pet.rs`、`desktop/notification.rs`（Windows `ContentLoading` 列表）；
2. `desktop/mod.rs` 的模块声明；
3. 该文件内的 `#[cfg(test)]`（断言脚本内容的测试要一起删）；
4. rustdoc 链接：`compat.rs` / `paste.rs` / `style.rs` 互相引用了 `[...::SHIM_JS]`，删一个要改一串；
5. 文档：`AGENTS.desktop.md` 的 iframe 桥条目、`AGENTS.plugins.md` 的桥规则；
6. 收尾 grep：旧常量名 + 文件名，零残留。

## 14. 缩放与共享持久化（本轮最曲折的一段）

**真值链路**：`store.setting.zoom_factor` → valtio persist（key `setting`）→ unstorage → Tauri store plugin →
`.store.dat`；Rust 侧 `STORE_SETTING_KEY = "setting"` 是**同一个键**，且读的时候同时兼容"字符串形态"与"对象形态"。
窗口创建时 Rust 会读取并应用（带平台守卫），所以"前端写 store"就等于"持久化"。

**前提（关键）**：persist 插件写的是**整个 store 状态的快照**。只有当 Rust 的 `setting_updated` 全量 payload 已经把
store hydrate 过（含 Rust 独有的字段）之后，前端写回才安全；在 hydrate 之前写共享 key，等于用"部分状态"覆盖整份设置。
→ 结论：**共享 key 的写入必须发生在 hydrate 之后**，这条值得写进 `AGENTS.desktop.md`。

**档位规则两侧同源**：前端 `normalizeZoomFactor`（0.5–2.0、0.1 步长）与 Rust `normalize_zoom_factor` 完全一致；
前端是"写入侧"，Rust 读时再兜底一次（§10.8）。

**平台能力**：wry 在 macOS 上直接调用 `WKWebView.pageZoom`（macOS 11+，**没有 `#available` 守卫**），
而本项目 `minimumSystemVersion = 10.15` → 旧系统上是崩溃而不是报错。因此必须在应用之前判定：
`@tauri-apps/plugin-os` 的 `type()` / `version()`（同步读注入的 `__TAURI_OS_PLUGIN_INTERNALS__`）。
注意 **UA 不可用**：macOS 11 起 WebKit 把 UA 里的系统版本冻结成 `10_15_7`，Catalina 与 Big Sur 之后的 UA 完全一样。

**Tauri 权限**：`Webview.setZoom` 走 `plugin:webview|set_webview_zoom`，**不在** `core:webview:default` 里，
必须显式加 `core:webview:allow-set-webview-zoom`（可在 `src-tauri/gen/schemas/acl-manifests.json` 核实默认集合）。
JS API 没有 zoom getter → 初值只能来自持久化真值或调用方显式传入；不要用 `Window.scaleFactor()`（那是显示器 DPI）。

## 15. Tauri 工程化清单

- **npm 包 ↔ crate 版本必须同 minor**：tauri CLI 构建前校验（如 `@tauri-apps/plugin-os@2.3.x` ↔ `tauri-plugin-os = "2.3"`）。
- **新增 API 先查权限**：`src-tauri/gen/schemas/*-schema.json` + `acl-manifests.json`；capabilities 里没放就运行期被拒。
- **lockfile 同步**：pnpm `--frozen-lockfile` 与 cargo `--locked` 会在不同步时直接失败；
  改 catalog 引用（`catalog:` ↔ `catalog:<name>`）也会改 lock 的 specifier → 改完跑 `pnpm install --lockfile-only`。
- **catalog 卫生**：重复项/未使用项会被 lint 拦（`pnpm/yaml-no-duplicate-catalog-item`、`no-unused-catalog-item`）。

## 16. 调试手册（案例 → 方法）

- **案例 A｜"插件运行期上报了错误"但界面正常**：别先看 F12 猜。先读运行时记录
  `$BASE_DIR/plugin-errors.json`（dev 构建在 `.../dev/`），里面写着 `ReferenceError: post is not defined` ——
  是重构漏改一处符号（§10.10）。**先读运行时事实，再读代码。**
- **案例 B｜F12 有一条 TypeError，但注册表里是另一条**：两者不一定是同一个问题。先确认"哪条记录对应哪次上报 / 哪个 frame"，
  再决定修谁；否则会去修一个不影响症状的错误。
- **案例 C｜"我改了源码，应用却没变化"**：先看**加载的是哪一份**。
  `~/.dsh.dev/profiles/<profile>/node_modules/<plugin>` 在 dev 下是 **junction → 工作区 `packages/<plugin>`**，
  而 `~/.dsh/profiles/*` 指向**安装版 resources**（另一个盘/另一份构建）。搞错这两者会白改半天。
- **案例 D｜tsdown watch 没重建**：watch 是**按包**触发的；本轮 `dsh-tauri-ui` 没跟上（dist 时间戳停在几十分钟前），
  显式 `pnpm --filter dsh-tauri-ui build` 才生效。验证方式：看 `dist/*` 的 mtime 与产物里的关键字。
- **案例 E｜弹窗"透明、与页面内容重叠"**：`bg-panel2/40`（40% alpha）叠在 `bg-black/40` 遮罩上，页面内容直接透出来；
  全屏那支因为底下是实心 `bg-canvas` 才没暴露。→ **半透明面板只允许出现在实心背景之上**。

## 17. 静态自检（不能/不便跑编译器时）

`.temp/check-imports.mjs`（gitignored）：用 Node 解析 `src/` 与 `packages/` 下所有**本地** import
（`@/...` 与相对路径），逐个校验目标文件存在（含 `index.*` 与扩展名推断），跳过 `node_modules` / `dist`。
本轮最终覆盖 **1137 条**，是"移动/删除/内联"之后断链的第一道网。

配套动作：
- 每次结构性改动后立刻跑一次；
- 同时 grep 被删符号与文件名（`NAV_SHIM_JS`、`setupNavBridge`、`__dsh_tauri_bridge__`、`post(`、被删常量）→ 目标零残留；
- 脚本自身也有坑：PowerShell `Select-String -Include` 不带 `-Recurse` 会静默返回空；
  `git status --porcelain` 的 `-like '??*'` 是通配匹配（要用正则 `^\?\?`）——本轮两次被这两个坑误导。

## 18. 交付清单（本地 ↔ CI 对齐）

```bash
# 步骤 1：与 CI 同序（ci.yml 的 plugins job）
pnpm --filter dsh-tauri build && pnpm --filter dsh-tauri-ui build   # 类型指向 dist，必须先构建
pnpm run typecheck
pnpm run lint            # 0 error 才过；warning 不拦
pnpm build:plugins
pnpm run test -- --run

# 步骤 2：Rust（ci.yml 的 rust-test job，三平台矩阵）
cd src-tauri && cargo check --all-features --locked   # 本地快速确认编译与 lock 同步
```

- **开分支前先 `git fetch`**：本轮本地 `main` 落后 origin 3 个提交；因为传入提交只碰 `dsh-tauri-turnrewind/**` 而
  该目录工作区是干净的，`git switch -c <branch> origin/main` 可以**在脏工作区上安全携带改动**（前提正是"不碰已改文件"）。
- **提交信息**：conventional + 中文主题 + 分区 body（`refactor(shell): …`），与仓库现有风格一致。
- **PR**：`gh pr create --base main --title … --body-file <file>`（body 写"概要 / 验证 / 注意"三段）；
  `gh pr checks <n> --watch` 放后台等待；注意 CodeRabbit 对 **>150 文件**会跳过评审（想让它评审就得拆 PR）。
- **合并后要接着推提交时**：已合并 PR 的头不会再更新（`head.sha` 冻结在合并点），
  此时应基于最新 `origin/main` 开**新分支**重放提交（`git cherry-pick`），而不是往已合并分支上继续推。
- **交付期最常见的 3 个 lint 坑**：catalog 重复项（§15）、import/类型导入排序（`pnpm lint:fix` 可自动修）、
  TS 接口需要 `extends ParentMessage` 才能满足索引签名约束（否则 `invokeParent(request)` 直接报 TS2345）。

## 19. 并发写入者协作（§5.6 的操作细则）

- **禁止**对整棵树做 `git stash` / `checkout` / `reset`；改动停留在索引/工作区是安全的，粗粒度操作才会伤人。
- 对方处于"移动文件"的中途时会出现**断链**（本轮 `debug.tsx` 还指着 `@/hooks/use-core-breaking-confirm`，
  而文件已移到 `@/ui/config/hooks/`）——发现即补，别等对方收尾。
- `edit` 工具在文件被对方改过之后会拒绝写入（mtime 变化）→ **重新 read 再改**，不要凭记忆重放。
- **同文件争夺战**：本轮 `docs/SPEC-REVIEW.md` 被对方整篇改写（抽离成"通用开发协议"），我的追写被覆盖一次。
  教训：共享文档的写入要么先确认归属，要么**追加而非重写**，并在交付说明里写清哪一段是谁的。
- 交付时"把所有改动一起提交"（本轮 174 文件包含两个会话的工作），并在 PR 描述里说明来源与验证方式。

## 20. 本次仍未做（遗留）

- `src/hooks/use-invoke.ts`、`use-const.ts`、`use-listen-iframe.ts`、`use-zoom-level.ts` 未接线（knip 会报，CI 未跑 knip）。
- 通知 / 剪贴板 / boot 三个 shim 仍可评估迁移；其中通知垫片可用 dsh 自身的会话聚焦 API 取代"按文案点 DOM"。
- Rust `service::profile::clone` 是 dead code（`cargo check` 有 warning，本次未清）。
- §5.2 的"测试路径契约集中化"仍未落地：本轮又有若干测试因为搬路径而改动。
- `.store.dat` 共享 key 的"必须先 hydrate 再写"这条前提，建议尽快写进 `AGENTS.desktop.md`（§14）。

## 21. 复用的判定顺序（把整套经验压成 6 个问句）

新增/搬迁任何代码前，按顺序问：

1. 这个事实的真值在哪？有没有第二份？
2. 它有几个消费者？只有一个 → 不建中间层，直接内联到消费者。
3. 它依赖 store / Tauri 命令 / 业务领域吗？→ 决定 `components/` 还是 `ui/<领域>/`。
4. 它是值驱动、事件驱动还是需要注销外部资源？→ 决定 `useWatch` / `useListen` / `useEffect(keep:effect)`。
5. 它属于壳层还是 iframe 内？→ 决定"宿主 hook"还是"插件 `register/*`"，以及能不能删掉对应的注入 shim（§13 判定表）。
6. 它在写入侧和读取侧各需不需要兜底（归一化 / 平台判定 / 权限）？

## 22. 量化收尾

| 指标 | 数值 |
| --- | --- |
| 主提交 | 1 个（`refactor(shell): 全面接入 reause，桌面桥收敛到插件侧`） |
| 变更规模 | 174 files，+4658 / −5075 |
| 删除的 Rust 通讯 shim | 3（`nav.rs` 整文件、`style.rs` 整文件、zoom 快捷键桥与其测试） |
| 新增插件侧注册 | 2（`register/sidebar.ts`、`register/zoom-shortcut.ts`）+ `utils/zoom.ts`(+test) |
| 内联的 hook | 5（`use-dsh-cores/plugins/profiles/theme`、`use-desktop-zoom`） |
| 测试 | 本地 vitest 42 files / 323 passed；Rust 530 passed；CI 5 个 job 全绿（含三平台 Rust） |
| 迁移的外部 PR | 4 个提交（PR #498，作者归属保留，已重放到重构后的 main 上） |
| 本地静态自检 | 1137 条 import 全解析 |
| 交付耗时分布 | 编码 ≈ 70%，联调/排障（错误注册表 + junction + watch）≈ 20%，CI 对齐（lint/lock/catalog）≈ 10% |

> 一句话收尾（第二部分）：**这套规范让"删代码"变便宜，而这次改造真正的成本几乎都花在
> "确认哪一份是真的"——哪份插件被加载、哪条错误被记录、哪份 lock 会被校验。
> 下一次开工，先把这四件事查清楚（运行时记录 / junction 指向 / 产物时间戳 / lock 状态），比多写一百行代码更省时间。**
