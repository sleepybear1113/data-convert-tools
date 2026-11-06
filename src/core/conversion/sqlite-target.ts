import Decimal from 'decimal.js'

import type { Diagnostic } from '../model/diagnostic'
import type { ColumnMapping } from '../model/conversion'
import type { ColumnDataType, SourceColumnMetadata, TableRow, TableSchema } from '../model/table'
import type { CellValue } from '../model/value'
import { quoteSqliteIdentifier } from '../utils/identifiers'
import { createColumnMapping, validateColumnMapping } from './mapping'

export interface SqliteTargetOptions {
  tableName?: string
  includeMetadata?: boolean
  metadataTableName?: '__dct_metadata'
}

export const DEFAULT_SQLITE_TARGET_OPTIONS: Required<SqliteTargetOptions> = {
  tableName: 'imported_data',
  includeMetadata: true,
  metadataTableName: '__dct_metadata',
}

export type SqliteStorageType = 'TEXT' | 'INTEGER' | 'REAL' | 'NUMERIC' | 'BLOB'

export interface SqliteTargetColumn {
  sourceIndex: number
  name: string
  dataType: ColumnDataType
  sqliteType: SqliteStorageType
  nullable: boolean
  /** Values must remain decimal/integer strings instead of being coerced to Number. */
  decimalText: boolean
  source?: SourceColumnMetadata
}

export interface SqliteTargetSchema {
  tableName: string
  columns: readonly SqliteTargetColumn[]
  includeMetadata: boolean
  metadataTableName?: '__dct_metadata'
  diagnostics: readonly Diagnostic[]
  canWrite: boolean
}

interface NumericRequirements {
  decimalText: boolean
  unsafeInteger: boolean
}

function numericRequirements(values: readonly CellValue[]): NumericRequirements {
  let decimalText = false
  let unsafeInteger = false
  for (const value of values) {
    if (value === null || value instanceof Uint8Array || typeof value === 'boolean') continue
    if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) {
      decimalText = true
      unsafeInteger = true
    }
    if (typeof value === 'bigint' && (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER))) {
      decimalText = true
    }
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') continue
    try {
      const decimal = new Decimal(value.toString())
      if (!decimal.isFinite()) continue
      if (decimal.precision() > 15 || (decimal.isInteger() && decimal.abs().gt(Number.MAX_SAFE_INTEGER))) {
        decimalText = true
      }
    } catch {
      // Type inference reports non-numeric mixed values; target mapping stays non-destructive.
    }
  }
  return { decimalText, unsafeInteger }
}

function sourcePrecisionRequiresText(source: SourceColumnMetadata | undefined): boolean {
  const type = source?.type?.toUpperCase()
  if (type !== 'N' && type !== 'F') return false
  const decimals = source?.decimalPlaces ?? 0
  const size = source?.size ?? 0
  const significantDigits = Math.max(0, size - (decimals > 0 ? decimals + 1 : 0))
  return significantDigits > 15
}

function genericStorageType(dataType: ColumnDataType): SqliteStorageType {
  switch (dataType) {
    case 'integer':
      return 'INTEGER'
    case 'decimal':
      return 'NUMERIC'
    case 'float':
      return 'REAL'
    case 'boolean':
      return 'INTEGER'
    case 'binary':
      return 'BLOB'
    case 'string':
    case 'date':
    case 'datetime':
    case 'unknown':
    case 'empty':
      return 'TEXT'
  }
}

function mappedStorageType(
  dataType: ColumnDataType,
  source: SourceColumnMetadata | undefined,
  requirements: NumericRequirements,
): { sqliteType: SqliteStorageType; decimalText: boolean } {
  const sourceType = source?.type?.toUpperCase()
  switch (sourceType) {
    case 'C':
    case 'D':
    case 'T':
      return { sqliteType: 'TEXT', decimalText: false }
    case 'Y':
      return { sqliteType: 'TEXT', decimalText: true }
    case 'L':
      return { sqliteType: 'INTEGER', decimalText: false }
    case 'B':
      return { sqliteType: 'REAL', decimalText: false }
    case 'I':
      return requirements.decimalText
        ? { sqliteType: 'TEXT', decimalText: true }
        : { sqliteType: 'INTEGER', decimalText: false }
    case 'N':
    case 'F':
      return requirements.decimalText || sourcePrecisionRequiresText(source)
        ? { sqliteType: 'TEXT', decimalText: true }
        : { sqliteType: 'NUMERIC', decimalText: false }
    default:
      break
  }

  if ((dataType === 'integer' || dataType === 'decimal') && requirements.decimalText) {
    return { sqliteType: 'TEXT', decimalText: true }
  }
  return { sqliteType: genericStorageType(dataType), decimalText: false }
}

/** Infer loss-aware SQLite storage classes while retaining DBF source semantics. */
export function inferSqliteTargetSchema(
  sourceSchema: TableSchema,
  rows: readonly TableRow[] = [],
  options: SqliteTargetOptions = {},
  suppliedMappings?: readonly ColumnMapping[],
): SqliteTargetSchema {
  const resolved = { ...DEFAULT_SQLITE_TARGET_OPTIONS, ...options }
  const mappings = suppliedMappings ?? createColumnMapping(sourceSchema)
  const validation = validateColumnMapping(sourceSchema, mappings, { requireIncludedColumn: true })
  const diagnostics = [...validation.diagnostics]
  const columns: SqliteTargetColumn[] = []

  for (const mapping of mappings) {
    if (!mapping.included) continue
    const sourceColumn = sourceSchema.columns[mapping.sourceIndex]
    if (!sourceColumn) continue
    const values = rows.map((row) => row[mapping.sourceIndex] ?? null)
    const requirements = numericRequirements(values)
    const dataType = mapping.targetType ?? sourceColumn.dataType
    const storage = mappedStorageType(dataType, sourceColumn.source, requirements)
    const name = mapping.targetName.trim()
    if (storage.decimalText) {
      diagnostics.push({
        code: dataType === 'integer' || sourceColumn.source?.type?.toUpperCase() === 'I'
          ? 'SQLITE_INTEGER_AS_TEXT'
          : 'SQLITE_DECIMAL_AS_TEXT',
        severity: 'info',
        message: `Column ${name} uses TEXT to preserve numeric precision`,
        location: { tableName: resolved.tableName, columnIndex: mapping.sourceIndex, columnName: name },
      })
    }
    if (requirements.unsafeInteger) {
      diagnostics.push({
        code: 'SQLITE_UNSAFE_SOURCE_NUMBER',
        severity: 'warning',
        message: `Column ${name} contains an unsafe JavaScript integer; original precision may already be lost`,
        location: { tableName: resolved.tableName, columnIndex: mapping.sourceIndex, columnName: name },
      })
    }
    columns.push({
      sourceIndex: mapping.sourceIndex,
      name,
      dataType,
      sqliteType: storage.sqliteType,
      nullable: sourceColumn.nullable,
      decimalText: storage.decimalText,
      source: sourceColumn.source,
    })
  }

  if (!resolved.tableName.trim()) {
    diagnostics.push({
      code: 'SQLITE_EMPTY_TABLE_NAME',
      severity: 'error',
      message: 'SQLite target table name cannot be empty',
    })
  }

  return {
    tableName: resolved.tableName,
    columns,
    includeMetadata: resolved.includeMetadata,
    metadataTableName: resolved.includeMetadata ? resolved.metadataTableName : undefined,
    diagnostics,
    canWrite: diagnostics.every((diagnostic) => diagnostic.severity !== 'error'),
  }
}

export function createSqliteTableStatement(target: SqliteTargetSchema): string {
  if (!target.canWrite || target.columns.length === 0) {
    throw new Error('Cannot create SQLite table from an invalid or empty target schema')
  }
  const columns = target.columns
    .map((column) => `${quoteSqliteIdentifier(column.name)} ${column.sqliteType}${column.nullable ? '' : ' NOT NULL'}`)
    .join(', ')
  return `CREATE TABLE ${quoteSqliteIdentifier(target.tableName)} (${columns})`
}
