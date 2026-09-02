/**
 * client/types/index.ts — 客户端共享类型聚合 barrel。
 *
 * 按领域分文件（protocol / scheduler），本文件只 re-export，保持
 * 「client/types/ 是共享类型唯一集中位置」的约定。
 */

export * from './protocol'
export * from './scheduler'
