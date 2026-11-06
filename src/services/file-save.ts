import type { ExportFileResult } from '../core/model/work'

export function sanitizeFileName(fileName: string, fallback = 'export'): string {
  const sanitized = fileName
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim()

  return sanitized || fallback
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')

  anchor.href = url
  anchor.download = sanitizeFileName(fileName)
  anchor.click()

  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

export function downloadExport(result: ExportFileResult): void {
  const bytes = result.bytes.buffer.slice(
    result.bytes.byteOffset,
    result.bytes.byteOffset + result.bytes.byteLength,
  ) as ArrayBuffer
  downloadBlob(new Blob([bytes], { type: result.mimeType }), result.fileName)
}
