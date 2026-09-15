/** 右侧边栏控制器里本插件会用到的最小面（只声明真正调用的方法，不复制宿主契约）。 */
export interface SidebarRightFace {
  /** 打开一个页类型（新内核 `ctx.sidebarRight.openTab`）。 */
  openTab?: (kind: string) => unknown
}

/** 渲染/点击那一刻探测到的运行时能力（旧内核上全部缺席）。 */
export interface Capabilities {
  /** 右侧边栏控制器最小面；缺席表示旧内核。 */
  sidebar: SidebarRightFace | undefined
  /** 是否具备「应用内右侧边栏预览」能力（「打开文件」的判据）。 */
  sidebarPreview: boolean
  /** 右侧边栏是否注册了「文件树」页类型（「审核」按钮的判据）。 */
  fileTree: boolean
}
