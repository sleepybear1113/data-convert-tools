import type { SourceMetadata } from './metadata'
import type { CellValue } from './value'

export type ColumnDataType =
  | 'unknown'
  | 'empty'
  | 'string'
  | 'integer'
  | 'decimal'
  | 'float'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'binary'

export interface SourceColumnMetadata {
  name: string
  type?: string
  size?: number
  decimalPlaces?: number
  flags?: number
  nullable?: boolean
  system?: boolean
}

export interface ColumnSchema {
  id: string
  name: string
  dataType: ColumnDataType
  nullable: boolean
  source?: SourceColumnMetadata
}

export interface TableSchema {
  id: string
  name: string
  columns: readonly ColumnSchema[]
  source?: SourceMetadata
}

/** Rows use column indexes instead of objects so duplicate source names are not lost. */
export type TableRow = readonly CellValue[]

export interface RowPage {
  offset: number
  rows: readonly TableRow[]
  totalRows?: number
}
