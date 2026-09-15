/** 插件 id（npm 包名）：宿主错误注册表与插件列表的主键。 */
let nonceSeq = 0
/** 生成全局唯一的请求 nonce（`<pluginId>:<seq>`，进程内递增）。 */
export function getNonce(): string {
  nonceSeq += 1
  return `dsh-tauri:${nonceSeq}`
}
