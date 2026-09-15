# Third-party notices

Substantial portions of the scheduled-task panel are adapted from
[`MichengAI/dsh-automation`](https://github.com/MichengAI/dsh-automation)
(`@michengai/dsh-automation`) at the adopted baseline commit
`f1bc91a3437f0b952631a46a8363089587b9ae6a` (`v0.1.32`), plus the DSH `0.1.5-rc.1`
host-compatibility follow-up from upstream `c426c3d` (`v0.1.35`):

- **Host, unattended execution** — `src/host/service/executor.ts` (aligned
  line-by-line with upstream `src/executor.ts`, `executeAutomationRun`),
  `src/host/service/permission-presets.ts`, `src/host/service/options.ts`,
  `src/host/types/index.ts`.
- **Client** — `src/client/components/menu.tsx` + `menu.cssr.ts`,
  `src/client/components/model-picker.tsx` + `model-picker.cssr.ts`,
  `src/client/components/task-create-dialog.tsx`,
  `src/client/components/prefill-bridge.tsx`, `src/client/prefill.ts`,
  `src/client/register/prefill.ts`, `src/client/types/scheduler.ts`,
  `src/client/types/protocol.ts` (structure, interaction and ARIA copied from the
  upstream menu / model picker / chat-prefill bridge).

Copyright 2026 MichengAI contributors. These portions are used and modified under
the Apache License, Version 2.0. Adapted files carry an inline attribution
comment at the top.

The full upstream source, license and NOTICE are retained as the Git submodule at
`source/dsh-automation`. The scope of the adaptation, the deliberately retained
differences and the verification history are recorded in
[`docs/sync-log.md`](./docs/sync-log.md).

## Retained upstream NOTICE

Reproduced verbatim from the upstream `NOTICE` file, as required by Apache-2.0
§4(d):

```text
dsh-automation
Copyright 2026 MichengAI contributors

本项目的 TypeScript 源码、构建脚本与项目文档采用 Apache License 2.0。

产品模型参考了 DeepSeek Harness 社区中的独立自动化实践：
- 独立 Session 调度与审计历史 (titanwings/dsh-automation，MIT)

上述参考实现的许可证与版权仍归其原作者所有；本仓库实现为独立编写，不复制其专有代码。
```
