import type { Diagnostic } from './diagnostic'
import type { TableRow, TableSchema } from './table'

export interface TablePreview {
  schema: TableSchema
  sampleRows: readonly TableRow[]
  totalRows?: number
  sheetNames?: readonly string[]
  diagnostics: readonly Diagnostic[]
}

export interface WorkspaceImportResult {
  table: TableSchema
  recordCount: number
  diagnostics: readonly Diagnostic[]
}

export interface ExportFileResult {
  fileName: string
  mimeType: string
  bytes: Uint8Array
  recordCount?: number
  columnCount?: number
  diagnostics: readonly Diagnostic[]
}
