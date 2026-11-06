import type { ColumnDataType, TableSchema } from './table'

export type DataSelection =
  | { kind: 'table'; tableName: string }
  | { kind: 'query'; sql: string; resultId?: string }
  | { kind: 'workspace' }

export interface ColumnMapping {
  sourceIndex: number
  included: boolean
  targetName: string
  targetType?: ColumnDataType
  dbfType?: string
  dbfSize?: number
  dbfDecimalPlaces?: number
}

export interface ImportMapping {
  /** Optional at the Worker boundary; execution only requires targetTableName and columns. */
  sourceSchema?: TableSchema
  targetTableName: string
  columns: readonly ColumnMapping[]
}

export type ExportFormat = 'dbf' | 'sqlite' | 'xlsx' | 'csv'

export interface ExportOptions {
  format: ExportFormat
  selection: DataSelection
  fileName: string
  strict: boolean
  includeMetadata: boolean
  tableName?: string
  sheetName?: string
  encoding?: string
  bom?: boolean
  delimiter?: string
  lineEnding?: '\n' | '\r\n'
  columns?: readonly ColumnMapping[]
}
