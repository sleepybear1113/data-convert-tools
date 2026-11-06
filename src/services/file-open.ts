import type { ExportFormat } from '../core/model/conversion'

export function readFileBuffer(file: File): Promise<ArrayBuffer> {
  return file.arrayBuffer()
}

export function detectFileFormat(fileName: string): ExportFormat | undefined {
  const extension = fileName.split('.').pop()?.toLowerCase()

  switch (extension) {
    case 'dbf':
    case 'csv':
    case 'xlsx':
      return extension
    case 'sqlite':
    case 'sqlite3':
    case 'db':
      return 'sqlite'
    default:
      return undefined
  }
}
