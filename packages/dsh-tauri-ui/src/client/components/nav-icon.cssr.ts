import { cssr } from '../utils/cssr'

const { bem: { b } } = cssr

/** 设置导航行图标（官方 primitives 图标的外层对齐）。 */
export default b('settings-nav-icon', {
  flex: 'none',
})
