/**
 * Gravity UI Icons `circle-tree.svg`.
 * Source: https://github.com/gravity-ui/icons/blob/main/svgs/circle-tree.svg
 * License: MIT, © 2022 YANDEX LLC (see NOTICE).
 */
import type { ReactElement } from 'react'

const CIRCLE_TREE_PATH = 'M2.327.504A.75.75 0 0 1 3 1.25V2a1.5 1.5 0 0 0 1.5 1.5h2.588A3.25 3.25 0 0 1 10.25 1l.167.004A3.25 3.25 0 0 1 13.5 4.25l-.004.167A3.25 3.25 0 0 1 10.25 7.5l-.167-.004A3.25 3.25 0 0 1 7.088 5H4.5c-.547 0-1.058-.15-1.5-.405V10a1.5 1.5 0 0 0 1.5 1.5h2.588a3.25 3.25 0 1 1 0 1.5H4.5a3 3 0 0 1-3-3V1.25A.75.75 0 0 1 2.25.5zM10.25 10.5a1.75 1.75 0 1 0 0 3.5 1.75 1.75 0 0 0 0-3.5m0-8a1.75 1.75 0 1 0 0 3.5 1.75 1.75 0 0 0 0-3.5'

export function CircleTreeIcon({ size = 16 }: { size?: number }): ReactElement {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} fill="none" viewBox="0 0 16 16" aria-hidden="true">
      <path fill="currentColor" fillRule="evenodd" d={CIRCLE_TREE_PATH} clipRule="evenodd" />
    </svg>
  )
}

/** Returns the same icon for DOM insertion outside the React render tree. */
export function circleTreeSvg(size: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" fill="none" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="${CIRCLE_TREE_PATH}" clip-rule="evenodd"/></svg>`
}
