/**
 * client/types.ts — 客户端共享类型聚合 barrel。
 *
 * 按领域分文件（archive / locale / runtime / ui），本文件只 re-export，保持
 * 「client/types/ 是共享类型唯一集中位置」的约定，同时避免单个杂烩。
 */

export * from './archive'
export * from './locale'
export * from './runtime'
export * from './ui'
