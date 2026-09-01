import type { ReactElement } from 'react'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { useMemo } from 'react'

function parseMarkdown(text: string): string {
  return DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true, breaks: false }) as string)
}

export function MarkdownPreview(props: { text: string }): ReactElement {
  const html = useMemo(() => parseMarkdown(props.text), [props.text])
  return <div className="dpte-mdBody" dangerouslySetInnerHTML={{ __html: html }} />
}
