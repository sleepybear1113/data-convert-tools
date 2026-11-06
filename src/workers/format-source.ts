import type { DatabaseEngine } from '../core/database/engine'
import { inferTable } from '../core/conversion/infer-table'
import { readCsv } from '../core/formats/csv'
import type { CsvReadOptions } from '../core/formats/csv'
import { readXlsx } from '../core/formats/xlsx'
import type { XlsxReadOptions } from '../core/formats/xlsx'
import type { ImportMapping } from '../core/model/conversion'
import type { Diagnostic } from '../core/model/diagnostic'
import type { TableRow, TableSchema } from '../core/model/table'
import type { TablePreview, WorkspaceImportResult } from '../core/model/work'
import { applyImportMapping } from './apply-mapping'
import type { MappableTableSource } from './apply-mapping'
import { importTableIntoSqlite } from './sqlite-import'

const PREVIEW_ROWS = 20

export function previewArraySource(source: MappableTableSource): TablePreview {
  return {
    schema: source.schema,
    sampleRows: [],
    totalRows: source.recordCount,
    diagnostics: source.diagnostics,
  }
}

export async function previewXlsx(
  buffer: ArrayBuffer,
  options: XlsxReadOptions,
  fileName?: string,
): Promise<TablePreview> {
  const source = openXlsxSource(buffer, options, 'xlsx_preview', fileName)
  const preview = previewArraySource(source)
  const rows: TableRow[] = []
  for await (const row of source.rows) {
    rows.push(row)
    if (rows.length >= PREVIEW_ROWS) break
  }
  return {
    ...preview,
    sampleRows: rows,
    sheetNames: source.sheetNames,
  }
}

export async function previewCsv(
  buffer: ArrayBuffer,
  options: CsvReadOptions,
  fileName?: string,
): Promise<TablePreview> {
  const source = openCsvSource(buffer, options, 'csv_preview', fileName)
  const preview = previewArraySource(source)
  const rows: TableRow[] = []
  for await (const row of source.rows) {
    rows.push(row)
    if (rows.length >= PREVIEW_ROWS) break
  }
  return { ...preview, sampleRows: rows }
}

export async function importXlsxIntoSqlite(
  engine: DatabaseEngine,
  buffer: ArrayBuffer,
  options: XlsxReadOptions,
  tableName: string,
  mapping: ImportMapping | undefined,
  fileName?: string,
): Promise<WorkspaceImportResult> {
  const source = openXlsxSource(buffer, options, tableName, fileName)
  return importSource(engine, source, mapping)
}

export async function importCsvIntoSqlite(
  engine: DatabaseEngine,
  buffer: ArrayBuffer,
  options: CsvReadOptions,
  tableName: string,
  mapping: ImportMapping | undefined,
  fileName?: string,
): Promise<WorkspaceImportResult> {
  const source = openCsvSource(buffer, options, tableName, fileName)
  return importSource(engine, source, mapping)
}

interface ArraySource extends MappableTableSource {
  sheetNames?: readonly string[]
}

function openXlsxSource(
  buffer: ArrayBuffer,
  options: XlsxReadOptions,
  tableName: string,
  fileName?: string,
): ArraySource {
  const result = readXlsx(buffer, { ...options, fileName, tableName })
  return {
    ...arraySource({ ...result.schema, id: tableName, name: tableName }, result.rows, result.diagnostics),
    sheetNames: result.sheetNames,
  }
}

function openCsvSource(
  buffer: ArrayBuffer,
  options: CsvReadOptions,
  tableName: string,
  fileName?: string,
): ArraySource {
  // Always obtain the full row count; sampleSize is a presentation concern only.
  const result = readCsv(buffer, {
    ...options,
    sampleSize: undefined,
    skipEmptyLines: options.skipEmptyLines ?? 'greedy',
    fileName,
    tableName,
  })
  return arraySource({ ...result.schema, id: tableName, name: tableName }, result.rows, result.diagnostics)
}

function arraySource(
  schema: TableSchema,
  rows: readonly TableRow[],
  diagnostics: readonly Diagnostic[],
): ArraySource {
  const inferred = inferTable(schema, rows)
  return {
    schema: inferred.schema,
    recordCount: rows.length,
    rows: {
      async *[Symbol.asyncIterator]() {
        yield* rows
      },
    },
    diagnostics: [...diagnostics, ...inferred.diagnostics],
  }
}

async function importSource(
  engine: DatabaseEngine,
  source: MappableTableSource,
  mapping: ImportMapping | undefined,
): Promise<WorkspaceImportResult> {
  const parseError = source.diagnostics.find((diagnostic) => diagnostic.severity === 'error')
  if (parseError) throw new Error(parseError.message)

  const mapped = mapping ? applyImportMapping(source, mapping) : source
  await importTableIntoSqlite(engine, mapped.schema, mapped)
  return {
    table: mapped.schema,
    recordCount: mapped.recordCount,
    diagnostics: mapped.diagnostics,
  }
}
