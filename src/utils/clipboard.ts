import { writeText } from '@tauri-apps/plugin-clipboard-manager'

export function writeClipboardText(text: string): Promise<void> {
  return writeText(text)
}
