import type { DatabaseEngine } from '../core/database/engine'
import {
  encodedLength,
  inferDbfTargetSchema,
  isEncodable,
  toDbfFieldDescriptors,
  truncateEncoded,
} from '../core/conversion/dbf-target'
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
import { uniqueName } from '../core/utils/identifiers'
import { createZip, type ZipEntry } from '../core/utils/zip'
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

  if (options.groupBy?.length) {
    return exportGrouped(engine, createEngine, options)
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

/**
 * 按勾选列分组导出：数据按选中列的值拆分为多份，每份生成独立文件并打包为 ZIP。
 * 组的列结构统一按全部行推断一次，保证各分组的列类型一致。
 */
async function exportGrouped(
  engine: DatabaseEngine,
  createEngine: () => DatabaseEngine,
  options: RuntimeExportOptions,
): Promise<ExportFileResult> {
  if (options.selection.kind === 'workspace') {
    throw new Error('整个工作区不支持分组导出，请选择数据表或查询来源。')
  }
  const selection = options.selection
  const reader = await readSelection(engine, selection)
  try {
    const groupIndexes = options.groupBy!.map((name) => {
      const index = reader.columns.indexOf(name)
      if (index < 0) throw new Error(`结果中没有可供分组的列：${name}`)
      return index
    })

    const rows = await collectRows(reader)
    if (!rows.length) throw new Error('当前结果没有数据行，无法分组导出。')

    const groups = new Map<string, { displayKey: string; rows: TableRow[] }>()
    for (const row of rows) {
      // Map key 用单元分隔符连接，避免值本身含下划线时不同组合碰撞。
      const key = groupIndexes.map((index) => groupKeyPart(row[index])).join('\u001f')
      let group = groups.get(key)
      if (!group) {
        group = {
          displayKey: groupIndexes.map((index) => groupDisplayPart(row[index])).join('_'),
          rows: [],
        }
        groups.set(key, group)
      }
      group.rows.push(row)
    }

    const sourceSchema = selection.kind === 'table'
      ? await readTableMetadata(engine, selection.tableName)
      : undefined
    const prepared = prepareSchema(reader, sourceSchema, rows, options)

    const baseName = await resolveExportBaseName(engine, options)
    const usedNames = new Set<string>()
    const files: ZipEntry[] = []
    const diagnostics: Diagnostic[] = []
    let recordCount = 0

    for (const group of groups.values()) {
      const entryName = uniqueName(
        `${baseName}_${sanitizeFileNamePart(group.displayKey)}.${extensionFor(options.format)}`,
        usedNames,
        { startSuffix: 1, caseInsensitive: true },
      )
      usedNames.add(entryName.toLowerCase())

      const projected = options.columns?.length
        ? applyColumnMapping(prepared.schema, group.rows, options.columns, prepared.schema.name)
        : { schema: prepared.schema, rows: group.rows }
      const result = await exportByFormat(createEngine, projected.schema, projected.rows, options, prepared.diagnostics)
      files.push({ name: entryName, data: result.bytes })
      diagnostics.push(...result.diagnostics)
      recordCount += result.recordCount ?? group.rows.length
    }

    return {
      fileName: withExtension(options.fileName, 'zip'),
      mimeType: 'application/zip',
      bytes: await createZip(files),
      recordCount,
      columnCount: prepared.schema.columns.length,
      diagnostics,
    }
  } finally {
    await reader.release()
  }
}

function groupKeyPart(value: CellValue): string {
  if (value === null || value === undefined) return 'NULL'
  if (value instanceof Uint8Array) {
    const hex = Array.from(value.subarray(0, 32), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('')
    return `BLOB:${hex}${value.length > 32 ? '…' : ''}`
  }
  return String(value)
}

function groupDisplayPart(value: CellValue): string {
  if (value === null || value === undefined) return 'NULL'
  if (value instanceof Uint8Array) return `BLOB(${value.length}B)`
  return String(value)
}

function sanitizeFileNamePart(text: string): string {
  const sanitized = text
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 60)
  return sanitized || '空'
}

function extensionFor(format: RuntimeExportOptions['format']): string {
  return format === 'xlsx' ? 'xlsx' : format
}

/** 解析导出文件名中的「原文件名」：优先导入源文件名，SQL 建表回退为表名。 */
async function resolveExportBaseName(
  engine: DatabaseEngine,
  options: RuntimeExportOptions,
): Promise<string> {
  const schema = await engine.getSchema()
  const selection = options.selection
  if (selection.kind === 'table') {
    const info = schema.tables.find((table) => table.name === selection.tableName)
    return stripExtension(info?.sourceFileName) ?? selection.tableName
  }
  if (schema.tables.length === 1) {
    const only = schema.tables[0]
    return stripExtension(only.sourceFileName) ?? only.name
  }
  return 'query_result'
}

function stripExtension(fileName: string | undefined): string | undefined {
  if (!fileName) return undefined
  const base = fileName.replace(/\.[^.]+$/, '').trim()
  return base || undefined
}

async function exportByFormat(
  createEngine: () => DatabaseEngine,
  schema: TableSchema,
  rows: readonly TableRow[],
  options: RuntimeExportOptions,
  diagnostics: readonly Diagnostic[],
): Promise<ExportFileResult> {
  switch (options.format) {
    case 'csv':
      return exportCsv(schema, rows, options, diagnostics)
    case 'xlsx':
      return exportXlsx(schema, rows, options, diagnostics)
    case 'dbf':
      return exportDbf(schema, rows, options, diagnostics)
    case 'sqlite':
      return exportSqliteSelection(createEngine, schema, rows, options, diagnostics)
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

  const fields = normalizeWriterNames(toDbfFieldDescriptors(target.columns), options.strict, encoding)
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

function normalizeWriterNames(
  fields: readonly DbfFieldDescriptor[],
  strict: boolean,
  encoding: string,
): DbfFieldDescriptor[] {
  const used = new Set<string>()
  return fields.map((field, index) => {
    let name = field.name
    // 列名按目标编码的字节数校验（GBK 下允许中文名）；无法编码或超长时按原行为降级。
    if (!name || !isEncodable(name, encoding) || encodedLength(name, encoding) > 10) {
      if (strict) throw new Error(`DBF field name must contain at most 10 ${encoding} bytes: ${name}`)
      name = `COL${index + 1}`
    }
    while (used.has(name.toLowerCase())) {
      const suffix = '_2'
      name = `${truncateEncoded(name, 10 - encodedLength(suffix, encoding), encoding)}${suffix}`
    }
    if (encodedLength(name, encoding) > 10) {
      if (strict) throw new Error(`DBF field name exceeds ten encoded bytes: ${name}`)
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

function withExtension(
  fileName: string,
  extension: 'dbf' | 'sqlite' | 'xlsx' | 'csv' | 'zip',
): string {
  return fileName.toLowerCase().endsWith(`.${extension}`) ? fileName : `${fileName}.${extension}`
}
