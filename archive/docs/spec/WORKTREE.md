### 需求规格说明书：Tauri 客户端内置 Git Worktree 插件集成

**项目名称**：`dsh-tauri-worktree` 插件集成

**目标**：在 Tauri 桌面端集成 Git Worktree 能力，支持在独立隔离的环境中进行对话与代码变更，并提供一键合并带回本地或放弃更改的能力。

---

### 一、 UI / UX 交互需求

#### 1. 模式选择下拉框扩展

* **位置**：聊天框上方模式选择器（ DOM 节点 `._root_19372_1`）右侧。
* **交互逻辑**：
* 点击展开下拉菜单，新增 **工作树** 选项（默认项为 **本地**）。
* 切换为 **工作树** 后，后续消息发送将在隔离的 Worktree 环境中处理。
* 用户支持选择已有工作树或切换回本地工作区。



#### 2. 会话处理状态与日志展示

发送消息后，聊天界面需实时显示工作区创建进度：

* **阶段 1（加载中）**：
`[loadingIcon] 正在准备工作区` $\rightarrow$ `[loadingIcon] 正在检出文件`
* **阶段 2（完成/可展开日志）**：
`已创建工作区` > `点击可查看调用 logs`
* **日志展开视图**：
```text
[info] Starting worktree creation
Preparing worktree (detached HEAD 0689db7)
HEAD is now at 0689db7 Merge pull request #106 ...
Worktree created at ~/.dsh/worktrees/[hash]/[dirname]

```


* **阶段 3（模型响应）**：
`正在思考...`（LLM 基于创建好的工作树环境进行回复）。

#### 3. 顶部提示条 (Surface)

会话处于 Worktree 模式时，聊天框上方需**常驻**顶部 Surface 提示条：

$$\text{[ 该会话正在工作树进行 ]} \quad \text{---------------------- [ 空白区 ] ----------------------} \quad \text{[ 检出本地 ] \ \ [ 放弃 ]}$$

#### 4. 模态框 (Dialog) 交互

* **检出本地弹窗**：
* **标题**：`将更改带回本地检出并继续`
* **表单/信息**：
* 本地检出分支名输入框：预填 `dsh/`（例：`dsh/feature-xyz`）
* 显示当前关联路径：`[工作区 hash]/[dirname]`
* 显示目标项目路径：`[项目路径]`


* **操作按钮**：`确认检出并合并` / `取消`


* **放弃更改弹窗**：
* **标题**：`放弃工作树更改`
* **提示文本**：`确认放弃吗？这将删除当前会话及对应的临时工作树。`
* **操作按钮**：`确认放弃`（危险操作） / `取消`



#### 5. 会话列表标识

* 当会话绑定了 Worktree 时，侧边栏会话列表项的时间标识（ DOM 节点 `.YDXeBa_time`）**左侧显示 Git 分支图标**。
* 完成“检出本地”后，该会话恢复为普通本地会话，移除分支图标，后续对话在本地工作区继续。

---

### 二、 系统架构与后端逻辑

#### 1. 工作树创建与存储路径

* **Hash 生成**：根据当前项目路径与会话 ID 自动计算唯一哈希值 `[hash]`。
* **存储目录**：`~/.dsh/worktrees/[hash]/[dirname]`

#### 2. Tool 扩展与 Agent 感知

* **新增 Tool 声明**：
```typescript
checkout_worktree(params: {
  worktree_hash_dirname: string;
  branch_name: string;
}): Promise<void>;

```


* **Agent 系统提示词（System Prompt）注入**：
* 处于 Worktree 环境时，注入上下文标识 `is_worktree: true`。
* **自发调用逻辑**：当需要“提交 PR”、“合并到本地”、“切回主分支”等 Git 操作指令时，Agent 应主动触发 `checkout_worktree` 工具。


---

### 三、 参考实现与依赖

* `packages/clutch-dsh-worktree` (Cerbur/clutch-dsh)
* `dsh-worktree-panel` (HeathHe/dsh-worktree-panel)