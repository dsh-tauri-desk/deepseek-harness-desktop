export function isDesktopHost(): boolean {
  return typeof window !== 'undefined' && window.dshDesktop !== undefined
}
