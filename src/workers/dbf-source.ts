import type { DatabaseEngine } from '../core/database/engine'
import { ArrayBufferDbfReader } from '../core/dbf/reader'
import { DEFAULT_DBF_ENCODING, encodingForLanguageDriver } from '../core/dbf/encoding'
import type { DbfFieldDescriptor, DbfReadOptions } from '../core/dbf/types'
import type { ImportMapping } from '../core/model/conversion'
import type { Diagnostic } from '../core/model/diagnostic'
import type { ColumnDataType, ColumnSchema, TableRow, TableSchema } from '../core/model/table'
import type { TablePreview, WorkspaceImportResult } from '../core/model/work'
import { uniqueName } from '../core/utils/identifiers'
import { importTableIntoSqlite } from './sqlite-import'
import { applyImportMapping } from './apply-mapping'

const PREVIEW_ROWS = 20

export interface DbfTableSource {
  schema: TableSchema
  recordCount: number
  rows: AsyncIterable<TableRow>
  diagnostics: readonly Diagnostic[]
}

export async function openDbfSource(
  buffer: ArrayBuffer,
  options: DbfReadOptions,
  tableName: string,
  fileName?: string,
): Promise<DbfTableSource> {
  const reader = new ArrayBufferDbfReader()
  const result = await reader.read(buffer, options)
  const businessColumns = result.fields
    .map((field, sourceIndex) => ({ field, sourceIndex }))
    .filter(({ field }) => !field.system)
  const exactDecimalIndexes = new Set<number>()
  let recordCount = 0

  for await (const record of result.records) {
    recordCount += 1
    for (const { field, sourceIndex } of businessColumns) {
      if (['N', 'F'].includes(field.type) && typeof record.values[sourceIndex] === 'string') {
        exactDecimalIndexes.add(sourceIndex)
      }
    }
  }

  const includeDeleted = options.includeDeleted ?? false
  const usedNames = new Set(businessColumns.map(({ field }) => field.name.toLowerCase()))
  const deletedColumnName = includeDeleted
    ? uniqueName('__deleted', usedNames)
    : undefined
  const encoding = options.encoding
    ?? encodingForLanguageDriver(result.header.languageDriver)
    ?? DEFAULT_DBF_ENCODING
  const columns: ColumnSchema[] = businessColumns.map(({ field, sourceIndex }) => ({
    id: `column_${sourceIndex}`,
    name: field.name,
    dataType: columnDataType(field, exactDecimalIndexes.has(sourceIndex)),
    nullable: field.nullable,
    source: {
      name: field.name,
      type: field.type,
      size: field.length,
      decimalPlaces: field.decimalPlaces,
      flags: field.flags,
      nullable: field.nullable,
      system: field.system,
    },
  }))

  if (deletedColumnName) {
    columns.push({
      id: 'column___deleted',
      name: deletedColumnName,
      dataType: 'boolean',
      nullable: false,
      source: { name: deletedColumnName, type: 'L', system: true },
    })
  }

  const schema: TableSchema = {
    id: tableName,
    name: tableName,
    columns,
    source: {
      format: 'dbf',
      fileName,
      fileVersion: result.header.fileVersion,
      languageDriver: result.header.languageDriver,
      encoding,
      headerLength: result.header.headerLength,
      recordLength: result.header.recordLength,
      trailingHeader: result.header.trailingHeader.slice(),
      sourceRecordCount: result.header.recordCount,
      fieldDescriptors: result.fields.map((field) => ({ ...field })),
      includeDeleted,
      deletedColumnName,
    },
  }
  const diagnostics = [...result.diagnostics]
  for (const { field, sourceIndex } of businessColumns) {
    if (exactDecimalIndexes.has(sourceIndex)) {
      diagnostics.push({
        code: 'DBF_EXACT_DECIMAL_TEXT',
        severity: 'info',
        message: `Field ${field.name} contains exact decimal text and will be imported as TEXT`,
        location: { tableName, columnName: field.name, columnIndex: sourceIndex },
      })
    }
  }

  return {
    schema,
    recordCount,
    rows: rowsFromDbf(reader, buffer, options, businessColumns.map(({ sourceIndex }) => sourceIndex), deletedColumnName !== undefined),
    diagnostics,
  }
}

export async function previewDbf(
  buffer: ArrayBuffer,
  options: DbfReadOptions,
  fileName?: string,
): Promise<TablePreview> {
  const source = await openDbfSource(buffer, options, 'dbf_preview', fileName)
  const sampleRows: TableRow[] = []
  for await (const row of source.rows) {
    sampleRows.push(row)
    if (sampleRows.length >= PREVIEW_ROWS) break
  }

  return {
    schema: source.schema,
    sampleRows,
    totalRows: source.recordCount,
    diagnostics: source.diagnostics,
  }
}

export async function importDbfIntoSqlite(
  engine: DatabaseEngine,
  buffer: ArrayBuffer,
  options: DbfReadOptions,
  tableName: string,
  fileName?: string,
  mapping?: ImportMapping,
): Promise<WorkspaceImportResult> {
  const source = await openDbfSource(buffer, options, tableName, fileName)
  const mapped = mapping ? applyImportMapping(source, mapping) : source
  await importTableIntoSqlite(engine, mapped.schema, mapped)
  return {
    table: mapped.schema,
    recordCount: mapped.recordCount,
    diagnostics: mapped.diagnostics,
  }
}

function rowsFromDbf(
  reader: ArrayBufferDbfReader,
  buffer: ArrayBuffer,
  options: DbfReadOptions,
  sourceIndexes: readonly number[],
  includeDeleted: boolean,
): AsyncIterable<TableRow> {
  return {
    async *[Symbol.asyncIterator]() {
      const result = await reader.read(buffer, options)
      for await (const record of result.records) {
        const values = sourceIndexes.map((index) => record.values[index])
        if (includeDeleted) values.push(record.deleted)
        yield values
      }
    },
  }
}

function columnDataType(field: DbfFieldDescriptor, exactDecimal: boolean): ColumnDataType {
  if (['N', 'F'].includes(field.type)) {
    if (exactDecimal) return 'decimal'
    return field.decimalPlaces === 0 ? 'integer' : 'float'
  }

  switch (field.type) {
    case 'C': return 'string'
    case 'Y': return 'decimal'
    case 'I': return 'integer'
    case 'L': return 'boolean'
    case 'D': return 'date'
    case 'T': return 'datetime'
    case 'B': return 'float'
    default: return 'binary'
  }
}
