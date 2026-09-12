/** dsh 侧持久化的主题偏好（`$DSH_HOME/settings.yaml` 的 `ui-theme.preference`） */
export type DshThemePreference = 'dark' | 'light' | 'system'

/** 解析后的最终主题：落到 `<html data-theme>`，由 CSS 变量切换配色 */
export type ResolvedTheme = 'dark' | 'light'
