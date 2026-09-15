/**
 * client/constants/index.ts — 客户端共享常量。
 *
 * 这里只放跨插件、跨版本都稳定的字面量：官方 DOM 的稳定 ARIA 选择器（适配层的 DOM 退级目标）、
 * 协议标识等。适配层（`register/index.adapter.ts`）与各插件注册器一律从这里引用，
 * 不再各自硬编码。领域变多时按 `constants/<domain>.ts` 拆分，本文件保持 barrel。
 */

/**
 * 官方「新建会话」按钮：工作区导航能力缺席时的 DOM 退级目标。
 *
 * 与官方 aria-label 逐字一致（中英双语各一条）；绝不用生成的 CSS module 哈希。
 */
export const NEW_SESSION_SELECTOR = 'button[aria-label="新建会话"],button[aria-label="New session"]'

/** 官方「添加工作区」按钮：工作区创建能力缺席时的 DOM 退级目标。 */
export const ADD_WORKSPACE_SELECTOR = 'button[aria-label="添加工作区"],button[aria-label="Add workspace"]'
