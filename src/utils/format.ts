/** 人类可读的字节数：B / KB / MB（备份压缩包大小等展示场景共用） */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024)
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024)
    return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}
