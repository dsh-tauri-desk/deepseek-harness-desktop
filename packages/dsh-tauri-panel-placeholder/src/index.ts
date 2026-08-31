/**
 * dsh-tauri-panel-placeholder 宿主侧（node half）：纯浏览器插件，无宿主行为。
 * loader 按行名导入包根时需要一个可挂载的插件入口；与官方浏览器插件
 * （如 dsh-client-ui-layout）一致，这里提供空 apply。
 */
export function apply(): void {}
