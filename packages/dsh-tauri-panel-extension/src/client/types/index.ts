/**
 * types/index.ts — 客户端共享类型聚合 barrel。
 *
 * 按领域分文件（protocol / skills / mcp / runtime），本文件只 re-export，
 * 保持「client/types/ 是共享类型唯一集中位置」的约定，同时避免单个
 * types 文件塞多领域。
 */

export * from './mcp'
export * from './protocol'
export * from './runtime'
export * from './skills'
