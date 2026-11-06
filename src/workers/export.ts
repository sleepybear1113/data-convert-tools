import type { DatabaseEngine } from '../core/database/engine'
import { inferDbfTargetSchema, toDbfFieldDescriptors } from '../core/conversion/dbf-target'
import { inferTable } from '../core/conversion/infer-table'
import { applyColumnMapping } from '../core/conversion/mapping'
import { resolveColumnNames } from '../core/conversion/mapping'
import { ArrayBufferDbfWriter } from '../core/dbf/writer'
import type { DbfFieldDescriptor, DbfFieldType } from '../core/dbf/types'
import { languageDriverForEncoding } from '../core/dbf/encoding'
import { writeCsv } from '../core/formats/csv'
import type { CsvWriteOptions } from '../core/formats/csv'
import { writeXlsx } from '../core/formats/xlsx'
import type { XlsxWriteOptions } from '../core/formats/xlsx'
import type { ExportOptions } from '../core/model/conversion'
import type { Diagnostic } from '../core/model/diagnostic'
import type { TableRow, TableSchema } from '../core/model/table'
import type { CellValue } from '../core/model/value'
import type { ExportFileResult } from '../core/model/work'
import { quoteSqliteIdentifier } from '../core/utils/identifiers'
import { METADATA_TABLE_NAME } from '../core/model/metadata-store'
import { writeOriginalDbfIfPossible } from './dbf-export'
import { readSelection } from './selection'
import type { SelectionReader } from './selection'
import { importTableIntoSqlite, readTableMetadata } from './sqlite-import'

export interface RuntimeExportOptions extends ExportOptions {
  csv?: CsvWriteOptions
  xlsx?: XlsxWriteOptions
}

export class ExportValidationError extends Error {
  readonly code = 'EXPORT_VALIDATION_FAILED'
  readonly details: Readonly<Record<string, unknown>>

  constructor(readonly diagnostics: readonly Diagnostic[]) {
    super(diagnostics.find((diagnostic) => diagnostic.severity === 'error')?.message
      ?? 'Export validation failed')
    this.name = 'ExportValidationError'
    this.details = { diagnostics }
  }
}

export async function exportWorkspace(
  engine: DatabaseEngine,
  createEngine: () => DatabaseEngine,
  options: RuntimeExportOptions,
): Promise<ExportFileResult> {
  if (options.selection.kind === 'workspace') {
    if (options.format !== 'sqlite') {
      throw new Error('The whole workspace can only be exported as SQLite')
    }
    return {
      fileName: withExtension(options.fileName, 'sqlite'),
      mimeType: 'application/vnd.sqlite3',
      bytes: await exportWholeDatabase(engine, createEngine, options.includeMetadata),
      diagnostics: [],
    }
  }

  const selection = await readSelection(engine, options.selection)
  const sourceSchema = options.selection.kind === 'table'
    ? await readTableMetadata(engine, options.selection.tableName)
    : undefined

  try {
    if (options.format === 'dbf' && sourceSchema && !options.columns?.length) {
      const original = await writeOriginalDbfIfPossible(selection, sourceSchema, options)
      if (original) {
        return {
          fileName: withExtension(options.fileName, 'dbf'),
          mimeType: 'application/x-dbf',
          bytes: original,
          recordCount: selection.recordCount,
          columnCount: selection.columns.length,
          diagnostics: [],
        }
      }
    }

    const rows = await collectRows(selection)
    const prepared = prepareSchema(selection, sourceSchema, rows, options)
    const projected = options.columns?.length
      ? applyColumnMapping(prepared.schema, rows, options.columns, prepared.schema.name)
      : { schema: prepared.schema, rows }

    switch (options.format) {
      case 'csv':
        return exportCsv(projected.schema, projected.rows, options, prepared.diagnostics)
      case 'xlsx':
        return exportXlsx(projected.schema, projected.rows, options, prepared.diagnostics)
      case 'dbf':
        return exportDbf(projected.schema, projected.rows, options, prepared.diagnostics)
      case 'sqlite':
        return exportSqliteSelection(createEngine, projected.schema, projected.rows, options, prepared.diagnostics)
    }
  } catch (error) {
    await selection.release()
    throw error
  }
}

async function exportWholeDatabase(
  engine: DatabaseEngine,
  createEngine: () => DatabaseEngine,
  includeMetadata: boolean,
): Promise<Uint8Array> {
  const bytes = await engine.exportDatabase()
  if (includeMetadata) return bytes

  const clone = createEngine()
  try {
    await clone.open(bytes)
    await clone.execute(`DROP TABLE IF EXISTS ${quoteSqliteIdentifier(METADATA_TABLE_NAME)}`)
    return await clone.exportDatabase()
  } finally {
    await clone.close()
  }
}

async function collectRows(selection: SelectionReader): Promise<TableRow[]> {
  const rows: TableRow[] = []
  for await (const row of selection.rows) rows.push(row)
  return rows
}

function prepareSchema(
  selection: SelectionReader,
  sourceSchema: TableSchema | undefined,
  rows: readonly TableRow[],
  options: RuntimeExportOptions,
): { schema: TableSchema; diagnostics: Diagnostic[] } {
  if (sourceSchema && sameColumnNames(sourceSchema.columns.map((column) => column.name), selection.columns)) {
    return { schema: sourceSchema, diagnostics: [] }
  }

  const selectionKind = options.selection.kind
  const source = selectionKind === 'query'
    ? { format: 'sql' as const, sql: selectionKind === 'query' ? options.selection.sql : '' }
    : { format: 'sqlite' as const }
  const tableName = options.tableName
    ?? (options.selection.kind === 'table' ? options.selection.tableName : 'query_result')
  const names = resolveColumnNames(selection.columns)
  const inferred = inferTable({
    id: tableName,
    name: tableName,
    columns: names.names.map((name, index) => ({
      id: `column_${index}`,
      name,
      dataType: 'unknown',
      nullable: true,
      source: { name: selection.columns[index], type: 'sql' },
    })),
    source,
  }, rows)
  const collisions: Diagnostic[] = names.collisions.map((collision) => ({
    code: 'EXPORT_COLUMN_RENAMED',
    severity: 'warning',
    message: `Column ${collision.sourceName || '(empty)'} was renamed to ${collision.resolvedName}`,
    location: { columnIndex: collision.sourceIndex },
  }))
  return {
    schema: inferred.schema,
    diagnostics: [...collisions, ...inferred.diagnostics],
  }
}

function exportCsv(
  schema: TableSchema,
  rows: readonly TableRow[],
  options: RuntimeExportOptions,
  diagnostics: readonly Diagnostic[],
): ExportFileResult {
  const encoding = options.csv?.encoding ?? options.encoding ?? 'utf-8'
  const bytes = writeCsv(schema, rows, {
    ...options.csv,
    encoding,
    strict: options.strict,
  })
  return {
    fileName: withExtension(options.fileName, 'csv'),
    mimeType: `text/csv;charset=${encoding}`,
    bytes,
    recordCount: rows.length,
    columnCount: schema.columns.length,
    diagnostics,
  }
}

function exportXlsx(
  schema: TableSchema,
  rows: readonly TableRow[],
  options: RuntimeExportOptions,
  diagnostics: readonly Diagnostic[],
): ExportFileResult {
  return {
    fileName: withExtension(options.fileName, 'xlsx'),
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    bytes: writeXlsx(schema, rows, {
      ...options.xlsx,
      sheetName: options.xlsx?.sheetName ?? options.sheetName ?? 'Sheet1',
    }),
    recordCount: rows.length,
    columnCount: schema.columns.length,
    diagnostics,
  }
}

async function exportDbf(
  schema: TableSchema,
  rows: readonly TableRow[],
  options: RuntimeExportOptions,
  diagnostics: readonly Diagnostic[],
): Promise<ExportFileResult> {
  const encoding = options.encoding ?? 'gbk'
  const targetMappings = options.columns
    ?.filter((column) => column.included)
    .map((column, sourceIndex) => ({ ...column, sourceIndex }))
  const target = inferDbfTargetSchema(schema, rows, {
    strict: options.strict,
    encoding,
    allowRename: !options.strict,
    allowTruncate: !options.strict,
    allowTypeWidening: !options.strict,
  }, targetMappings)
  const allDiagnostics = [...diagnostics, ...target.diagnostics]
  if (!target.canWrite) throw new ExportValidationError(allDiagnostics)

  const fields = normalizeWriterNames(toDbfFieldDescriptors(target.columns), options.strict)
  const bytes = await new ArrayBufferDbfWriter().write(fields, {
    recordCount: rows.length,
    records: {
      async *[Symbol.asyncIterator]() {
        for (const row of rows) {
          yield {
            values: target.columns.map((column) =>
              normalizeDbfValue(row[column.sourceIndex] ?? null, column.type)
            ),
            deleted: false,
          }
        }
      },
    },
  }, {
    fileVersion: schema.source?.format === 'dbf' ? schema.source.fileVersion : 0x30,
    encoding,
    languageDriver: schema.source?.format === 'dbf' && encoding === schema.source.encoding
      ? schema.source.languageDriver
      : languageDriverForEncoding(encoding) ?? 0,
    strict: options.strict,
    trailingHeader: schema.source?.format === 'dbf' ? schema.source.trailingHeader : undefined,
  })

  return {
    fileName: withExtension(options.fileName, 'dbf'),
    mimeType: 'application/x-dbf',
    bytes,
    recordCount: rows.length,
    columnCount: fields.length,
    diagnostics: allDiagnostics,
  }
}

async function exportSqliteSelection(
  createEngine: () => DatabaseEngine,
  schema: TableSchema,
  rows: readonly TableRow[],
  options: RuntimeExportOptions,
  diagnostics: readonly Diagnostic[],
): Promise<ExportFileResult> {
  const target = createEngine()
  try {
    await target.open()
    await importTableIntoSqlite(target, schema, {
      recordCount: rows.length,
      rows: {
        async *[Symbol.asyncIterator]() {
          yield* rows
        },
      },
    }, { includeMetadata: options.includeMetadata })
    return {
      fileName: withExtension(options.fileName, 'sqlite'),
      mimeType: 'application/vnd.sqlite3',
      bytes: await target.exportDatabase(),
      recordCount: rows.length,
      columnCount: schema.columns.length,
      diagnostics,
    }
  } finally {
    await target.close()
  }
}

function normalizeWriterNames(fields: readonly DbfFieldDescriptor[], strict: boolean): DbfFieldDescriptor[] {
  const used = new Set<string>()
  return fields.map((field, index) => {
    let name = field.name
    if (!/^[\x20-\x7e]+$/.test(name) || name.length > 10) {
      if (strict) throw new Error(`DBF field name must contain at most 10 printable ASCII bytes: ${name}`)
      name = `COL${index + 1}`
    }
    while (used.has(name.toLowerCase())) name = `${name}_2`
    if (name.length > 10) {
      if (strict) throw new Error(`DBF field name exceeds ten bytes: ${name}`)
      name = `COL${index + 1}`
    }
    used.add(name.toLowerCase())
    return { ...field, name }
  })
}

function normalizeDbfValue(value: CellValue, type: DbfFieldType): CellValue {
  if (value === null) return null
  if (type === 'C') {
    if (value instanceof Uint8Array) throw new Error('Binary values require an explicit text mapping')
    return String(value)
  }
  if (type === 'L') {
    if (typeof value === 'boolean') return value
    if (value === 0 || value === 0n) return false
    if (value === 1 || value === 1n) return true
    if (typeof value === 'string') {
      if (['true', 'yes', 'y', 't'].includes(value.trim().toLowerCase())) return true
      if (['false', 'no', 'n', 'f'].includes(value.trim().toLowerCase())) return false
      if (['?', ' '].includes(value)) return value
    }
  }
  return value
}

function sameColumnNames(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((name, index) => name === right[index])
}

function withExtension(fileName: string, extension: 'dbf' | 'sqlite' | 'xlsx' | 'csv'): string {
  return fileName.toLowerCase().endsWith(`.${extension}`) ? fileName : `${fileName}.${extension}`
}
