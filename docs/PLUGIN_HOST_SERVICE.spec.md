> 该文档已固定，禁止修改。

# 插件宿主端领域服务协议 (Plugin Host Service Protocol)

> 本规范为 [PLUGIN_HOST.spec.md](./PLUGIN_HOST.spec.md) 的**子协议**，整体受 [DEVELOPMENT.spec.md](./DEVELOPMENT.spec.md) 约束[cite: 1]。
> **适用范围**：`packages/*/src/host/service/`[cite: 1]。
> **核心原则**：通过 **「单一导出 + 动词白名单 + 统一签名」** 消除同义冗余、参数散装与职责穿透[cite: 1]。

---

## 一、 唯一定义宏：`defineService`

所有服务统一使用 `dsh-tauri` 导出的 **`defineService`** 声明[cite: 1]：

```typescript
import { defineService } from 'dsh-tauri'

```

* **特性与约束**：运行时零开销，仅在编译期约束服务对象成员**必须全为函数**[cite: 1]。散装状态必须留在模块作用域[cite: 1]。
* **铁律**：严禁自定义/封装其它服务宏，严禁手写裸对象（如 `export const x = {...}`）[cite: 1]。

---

## 二、 三条服务铁律

### 1. 单一导出 (Single Export)

* **一个文件有且仅有一个 `export**`（即服务对象本身）[cite: 1]。
* **导出标识符 = 文件名驼峰化 (kebab-case → camelCase)**，不存在 `name` 属性或第二份字符串身份声明[cite: 1]。
* `service/ledger.ts` $\rightarrow$ `export const ledger`[cite: 1]
* `service/session-context.ts` $\rightarrow$ `export const sessionContext`[cite: 1]


* **禁止导出其它内容**：类型归入 `types/`，常量归入 `config/`[cite: 1]。单模块专属类型与所属模块**同目录同名**（`<module>.types.ts`，见 [PLUGIN_HOST.spec.md](./PLUGIN_HOST.spec.md) 第二章）。私有函数/常量统一收敛于文件末尾 `// --- internal ---` 且不导出[cite: 1]。

### 2. 动词白名单 (Verb Whitelist)

* 服务必须归类为四种角色之一，方法名**只能使用允许的动词**（见第三章）[cite: 1]。
* 允许的动词是**上限**，未被消费的方法一律不写[cite: 1]。禁止出现白名单外的自造动词（如 `getStatus`）[cite: 1]。

### 3. 签名与宿主隔离 (Signatures & Host Isolation)

* **参数扁平**：按业务需求直接传参，不做无意义的单对象包装[cite: 1]。
* **无 `ctx`/`host` 参**：服务方法不得接收 `ctx` 或 `host` 参数[cite: 1]。宿主能力由 `apply.ts` 调用 `setCurrentHostInstance(ctx)` 绑定后，通过 `getCurrentHostInstance()` 按需获取[cite: 1]。
* **隔离访问**：**只有 `service/` 允许调用 `getCurrentHostInstance()**`；`routes/`、`tools/` 等必须经由服务层间接访问宿主能力[cite: 1]。

---

## 三、 服务角色与标准范例

### 3.0 词汇表总览

| 服务角色 | 判定特征 | 允许的动词 | 核心约束 |
| --- | --- | --- | --- |
| **持久化** | 业务实体落盘[cite: 1] | `load` / `save` / `remove` / `list`[cite: 1] | **唯一**允许读写 `storage` 的角色；负责 JSON 容错与校验[cite: 1]。 |
| **长任务** | 异步无法同步等待[cite: 1] | `start` / `lookup` / `unsettled`[cite: 1] | 维护内存状态机 (`pending`/`running`...)；禁止同步阻塞[cite: 1]。 |
| **领域编排** | 主流程组合编排[cite: 1] | 领域动词 (`create` / `checkout` / `attach` / `inherit` ...)[cite: 1] | 组合调用其它服务与 `utils/`，自身不落盘、不调底层命令[cite: 1]。 |
| **只读推演** | 从环境推导事实[cite: 1] | `resolve` / `peek`[cite: 1] | 必须无副作用，推导失败直接返回 `null`，**严禁猜测**[cite: 1]。 |

---

### 3.1 持久化 (Persistence)

```typescript
// service/ledger.ts
import { defineService, storage } from 'dsh-tauri'
import type { Binding } from '../types'

export const ledger = defineService({
  async load(sessionId: string): Promise<Binding | null> {
    const raw = await storage.getItem<Binding>(keyOf(sessionId))
    return raw ?? null
  },
  async save(sessionId: string, binding: Binding): Promise<void> {
    await storage.setItem(keyOf(sessionId), binding)
  },
  async remove(sessionId: string): Promise<void> {
    await storage.removeItem(keyOf(sessionId))
  },
  async list(): Promise<Binding[]> {
    const keys = await storage.getKeys('ledger/')
    const items = await Promise.all(keys.map(k => storage.getItem<Binding>(k)))
    return items.filter((item): item is Binding => Boolean(item))
  },
})

// --- internal ---
function keyOf(sessionId: string) { return `ledger/${sessionId}.json` }

```

### 3.2 长任务 (Long Task)

```typescript
// service/cleaner.ts
import { defineService } from 'dsh-tauri'
import type { DiscardJob } from '../types'

export const cleaner = defineService({
  start(sessionId: string, worktreeKey: string): DiscardJob {
    // 登记任务，合并同键在途 Promise，立即返回 jobId（不阻塞）
  },
  lookup(sessionId: string, jobId?: string): DiscardJob | undefined { /* ... */ },
  unsettled(): DiscardJob[] { /* ... */ },
})

// --- internal ---
const jobs = new Map<string, DiscardJob>()

```

### 3.3 领域编排 (Domain Orchestration)

```typescript
// service/workspace.ts
import { defineService } from 'dsh-tauri'

export const workspace = defineService({
  async create(sessionId: string, projectPath: string) { /* 编排 */ },
  async checkout(sessionId: string, branch: string) { /* 编排 */ },
  async attach(sessionId: string) { /* 编排 */ },
})

```

### 3.4 只读推演 (Read-only Inference)

```typescript
// service/session-context.ts
import { defineService, getCurrentHostInstance } from 'dsh-tauri'

export const sessionContext = defineService({
  resolve(sessionId: string): string | null {
    // 安全推导路径；绝对不回退 process.cwd() 猜测
  },
  peek(sessionId: string) { /* 只读查看，无副作用 */ },
})

```

---

## 四、 违规反面清单

* ❌ **模糊命名**：文件名出现 `manager` / `helper` / `utils` / `common` / `base`[cite: 1]。
* ❌ **冗余后缀**：使用 `xxxService` / `xxxManager` / `xxxHandler`（只允许领域名词裸名）[cite: 1]。
* ❌ **自造动词**：使用白名单外的动作词汇或混用同义词（如 `get` / `fetch` / `read` / `query` 混用）[cite: 1]。
* ❌ **非函数成员**：在服务对象上挂载变量、常量或类型[cite: 1]。
* ❌ **杂物导出**：在 `service/` 文件中导出 `type`、`const` 或内部辅助函数[cite: 1]。
* ❌ **透传宿主**：方法接收 `ctx` 或 `host` 参数[cite: 1]。

---

## 五、 服务层自检清单

* [ ] 服务是否使用 `defineService` 声明，且未新增其它自定义服务宏[cite: 1]？
* [ ] 文件是否有且仅有一个导出，且导出名等于文件名的驼峰形式[cite: 1]？
* [ ] 服务对象是否全部由函数组成（无散装状态/常量）[cite: 1]？
* [ ] 所有方法名是否**完全符合所属角色的动词白名单**[cite: 1]？
* [ ] 方法参数是否扁平，且未包含 `ctx`/`host` 形参[cite: 1]？
* [ ] 是否仅在 `service/` 内部使用 `getCurrentHostInstance()`，其它层绝不接触宿主对象[cite: 1]？
* [ ] 私有函数与常量是否收纳于 `// --- internal ---` 且未导出[cite: 1]？
* [ ] 类型与常量是否已剥离至 `types/` 与 `config/constants.ts`[cite: 1]？