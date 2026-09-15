export function textBlock(text: string): Array<{ type: 'text', text: string }> {
  return [{ type: 'text', text }]
}
