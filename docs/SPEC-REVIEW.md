# 规范评审（SPEC-REVIEW）

> 视角：一次「把整套规范实际执行到底」之后的复盘。
> 覆盖范围：`AGENTS.md` → `docs/AGENTS.desktop.md` + `docs/AGENTS.plugins.md`，
> 以及本轮口头追加的 hooks / 目录 / 命名规则（reause 化、`ui/<领域>/`、`Panel.*` 复合组件、
> `config/hooks` 事件总线、`useWakeLock`、内联根副作用、删除中间层组件等）。
> 结论先行：**这是一套「以"唯一来源 + 声明式副作用"为核心的架构规范」，而不是风格规范。**

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
