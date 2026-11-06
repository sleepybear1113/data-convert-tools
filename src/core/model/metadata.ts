export type SourceFormat = 'dbf' | 'sqlite' | 'xlsx' | 'csv' | 'sql'

export interface DbfStoredField {
  name: string
  type: string
  length: number
  decimalPlaces: number
  flags?: number
  nullable: boolean
  system?: boolean
}

export interface DbfSourceMetadata {
  format: 'dbf'
  fileName?: string
  fileVersion: number
  languageDriver: number
  encoding: string
  headerLength: number
  recordLength: number
  /** VFP bytes between the field terminator and the first record. */
  trailingHeader?: Uint8Array
  sourceRecordCount?: number
  fieldDescriptors?: readonly DbfStoredField[]
  includeDeleted?: boolean
  deletedColumnName?: string
}

export interface FileSourceMetadata {
  format: Exclude<SourceFormat, 'dbf' | 'sql'>
  fileName?: string
  sheetName?: string
  encoding?: string
}

export interface QuerySourceMetadata {
  format: 'sql'
  sql: string
}

export type SourceMetadata =
  | DbfSourceMetadata
  | FileSourceMetadata
  | QuerySourceMetadata
