/**
 * 生成导出文件名中的时间戳片段，格式 `yyyymmdd_hhmmss`（本地时间）。
 */
export function exportFileTimestamp(date: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  const datePart = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
  const timePart = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  return `${datePart}_${timePart}`
}
