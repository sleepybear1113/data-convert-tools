import type { Diagnostic } from '../model/diagnostic'
import type { CellValue } from '../model/value'

export type DbfFieldType =
  | 'C'
  | 'N'
  | 'F'
  | 'Y'
  | 'I'
  | 'L'
  | 'D'
  | 'T'
  | 'B'
  | 'M'
  | 'G'
  | 'V'
  | 'Q'
  | '0'
  | 'unknown'

export interface DbfFieldDescriptor {
  name: string
  type: DbfFieldType
  /** Field width in bytes. Binary and date/time fields have fixed widths. */
  length: number
  decimalPlaces: number
  /** VFP field flags: 0x01 system, 0x02 nullable, 0x04 binary. */
  flags?: number
  nullable: boolean
  system?: boolean
}

export interface DbfHeader {
  fileVersion: number
  languageDriver: number
  recordCount: number
  headerLength: number
  recordLength: number
  /** Bytes between the 0x0d descriptor terminator and the first record. */
  trailingHeader: Uint8Array
}

export interface DbfRecord {
  values: readonly CellValue[]
  deleted: boolean
  /** The complete on-disk record, including its deletion flag. */
  raw?: Uint8Array
}

export interface DbfReadOptions {
  /** Defaults to the language driver encoding, then GBK. */
  encoding?: string
  /** Deleted records are omitted by default. */
  includeDeleted?: boolean
  /** Throw on malformed field data instead of returning null/replacement data. */
  strict?: boolean
}

export interface DbfReadResult {
  header: DbfHeader
  fields: readonly DbfFieldDescriptor[]
  records: AsyncIterable<DbfRecord>
  diagnostics: readonly Diagnostic[]
}

export interface DbfRecordSource {
  recordCount: number
  records: AsyncIterable<DbfRecord>
}

export interface DbfWriteOptions {
  /** Only Visual FoxPro 0x30 is supported. Defaults to 0x30. */
  fileVersion?: number
  /** Defaults to GBK. */
  encoding?: string
  /** Defaults to 0x7a for GBK, otherwise zero. */
  languageDriver?: number
  strict?: boolean
  /** Preserved verbatim after the field descriptor terminator. */
  trailingHeader?: Uint8Array
}
