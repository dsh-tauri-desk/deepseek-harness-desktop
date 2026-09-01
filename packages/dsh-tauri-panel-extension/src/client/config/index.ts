/** config/index.ts — 技能创建器的待预填会话集合（模块级单例）。 */

/** 待预填草稿的会话 id：createSkill 打开新会话前登记，prefill 组件消费后移除。 */
export const pendingPrefills = new Set<string>()
