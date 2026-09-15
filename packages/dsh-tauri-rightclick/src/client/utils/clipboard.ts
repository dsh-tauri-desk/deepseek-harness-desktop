export async function writeClipboard(value: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value)
      return true
    }
    catch {}
  }
  return legacyCopy(value)
}

export async function readClipboard(): Promise<string | null> {
  if (navigator.clipboard?.readText) {
    try {
      return await navigator.clipboard.readText()
    }
    catch {}
  }
  return null
}

// --- internal ---

/** Clipboard API 不可写时的兜底：临时 textarea + execCommand。 */
function legacyCopy(value: string): boolean {
  const field = document.createElement('textarea')
  field.value = value
  field.setAttribute('readonly', '')
  field.style.cssText = 'position:fixed;left:-9999px;top:0'
  document.body.appendChild(field)
  field.select()
  const copied = document.execCommand('copy')
  field.remove()
  return copied
}
