## Workspace Routing & Context Guidelines

在执行优化前，请根据当前任务的上下文范围主动读取并参照相应的规范文档：

- **桌面端开发 (`Desktop`)**：
  若修改范围包含桌面端应用，请优先遵循 `docs/AGENTS.desktop.md`。
- **内置插件开发 (`Plugins(packages)`)**：
  若修改范围包含内置插件，请优先遵循 `docs/AGENTS.plugins.md`。
- **全栈/跨模块开发 (`Full Stack`)**：
  若同时涉及桌面端与内置插件，必须同时参照并整合 `docs/AGENTS.desktop.md` 和 `docs/AGENTS.plugins.md` 的规范。
