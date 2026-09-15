import type { ReactElement, SVGProps } from 'react'

export function FishMark({ width = 24, height = 24, ...props }: SVGProps<SVGSVGElement> = {}): ReactElement {
  return (
    <svg {...props} width={width} height={height} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 12c3-4.5 9-6 16-6 0 7-13 9-16 6Zm0 0c3 2.5 16 4.5 16-6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="15.5" cy="9.5" r="1" fill="currentColor" />
    </svg>
  )
}

export function PanelLeftOutline({ width = 16, height = 16, ...props }: SVGProps<SVGSVGElement> = {}): ReactElement {
  return (
    <svg {...props} width={width} height={height} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
      <path d="M6.5 3v10" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  )
}

export function IconPlaceholder({ width = 24, height = 24, ...props }: SVGProps<SVGSVGElement> = {}): ReactElement {
  return (
    <svg {...props} width={width} height={height} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path fill="currentColor" d="M13 12.6V9q0-.425-.288-.712T12 8t-.712.288T11 9v3.975q0 .2.075.388t.225.337l2.8 2.8q.275.275.7.275t.7-.275t.275-.7t-.275-.7zm-4.512 8.688q-1.638-.713-2.85-1.925t-1.925-2.85T3 13t.713-3.512t1.924-2.85t2.85-1.925T12 4t3.513.713t2.85 1.925T21 13t-.712 3.513t-1.925 2.85t-2.85 1.925T12 22t-3.512-.712M2.05 7.3q-.275-.275-.275-.7t.275-.7L4.9 3.05q.275-.275.7-.275t.7.275t.275.7t-.275.7L3.45 7.3q-.275.275-.7.275t-.7-.275m19.9 0q-.275.275-.7.275t-.7-.275L17.7 4.45q-.275-.275-.275-.7t.275-.7t.7-.275t.7.275l2.85 2.85q.275.275.275.7t-.275.7M12 20q2.925 0 4.963-2.037T19 13t-2.037-4.962T12 6T7.038 8.038T5 13t2.038 4.963T12 20" />
    </svg>
  )
}

const CIRCLE_TREE_PATH = 'M2.327.504A.75.75 0 0 1 3 1.25V2a1.5 1.5 0 0 0 1.5 1.5h2.588A3.25 3.25 0 0 1 10.25 1l.167.004A3.25 3.25 0 0 1 13.5 4.25l-.004.167A3.25 3.25 0 0 1 10.25 7.5l-.167-.004A3.25 3.25 0 0 1 7.088 5H4.5c-.547 0-1.058-.15-1.5-.405V10a1.5 1.5 0 0 0 1.5 1.5h2.588a3.25 3.25 0 1 1 0 1.5H4.5a3 3 0 0 1-3-3V1.25A.75.75 0 0 1 2.25.5zM10.25 10.5a1.75 1.75 0 1 0 0 3.5 1.75 1.75 0 0 0 0-3.5m0-8a1.75 1.75 0 1 0 0 3.5 1.75 1.75 0 0 0 0-3.5'

export function clockSvg(size: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 16 16" fill="none"><path fill="currentColor" fill-rule="evenodd" d="M13.5 8a5.5 5.5 0 1 1-11 0 5.5 5.5 0 1 1 11 0M15 8A7 7 0 1 1 1 8a7 7 0 0 1 14 0M8.75 4.5a.75.75 0 0 0-1.5 0V8a.75.75 0 0 0 .3.6l2 1.5a.75.75 0 1 0 .9-1.2l-1.7-1.275z" clip-rule="evenodd"/></svg>`
}

export function circleTreeSvg(size: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" fill="none" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="${CIRCLE_TREE_PATH}" clip-rule="evenodd"/></svg>`
}
