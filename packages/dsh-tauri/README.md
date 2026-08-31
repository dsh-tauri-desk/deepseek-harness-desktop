# dsh-tauri

`dsh-tauri` 是 DSH Tauri 桌面壳的基础插件。它提供一个无宿主行为的 host half，以及运行在 DSH iframe 中的客户端消息桥。

## 功能

- 将宿主导航栏的侧边栏开关转发至 `layout.toggleSidebar`。
- 将后退、前进命令转发至浏览器历史记录。
- 向宿主回报侧边栏折叠状态和历史边界。
- 隐藏与桌面导航栏重复的官方折叠控件。
- 在插件自身异常时向宿主报告，避免静默失败。

## 相关包

- [`dsh-tauri-ui`](../dsh-tauri-ui)：桌面化 UI。
- [`dsh-tauri-worktree`](../dsh-tauri-worktree)：会话级 Git worktree。
