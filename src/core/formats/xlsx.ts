import { read as readSheetJs, utils, write as writeSheetJs } from 'xlsx'
import type { CellObject, WorkBook, WorkSheet } from 'xlsx'

import type { Diagnostic } from '../model/diagnostic'
import type { ColumnSchema, TableRow, TableSchema } from '../model/table'
import type { CellValue } from '../model/value'

export type XlsxColumnSelection = number | string

export interface XlsxReadOptions {
  /** Defaults to the first sheet. */
  sheetName?: string
  /** One-based worksheet row containing headers (or the first data row without headers). */
  headerRow?: number
  /** Convert SheetJS date cells to timezone-free ISO strings. Defaults to true. */
  inferDates?: boolean
  hasHeader?: boolean
  /** Zero-based source column indexes or exact header names, in the desired output order. */
  columns?: readonly XlsxColumnSelection[]
  fileName?: string
  tableName?: string
}

export interface XlsxWriteOptions {
  sheetName?: string
  includeHeader?: boolean
  compression?: boolean
}

/** SheetJS is isolated behind this adapter so conversion code never depends on window.XLSX. */
export interface XlsxAdapter {
  read(input: ArrayBuffer | Uint8Array): WorkBook
  write(workbook: WorkBook): Uint8Array
}

export interface XlsxTableResult {
  schema: TableSchema
  rows: readonly TableRow[]
  diagnostics: readonly Diagnostic[]
  sheetName: string
  sheetNames: readonly string[]
}

export interface XlsxReadResult extends XlsxTableResult {
  workbook: WorkBook
}

export class XlsxFormatError extends Error {
  readonly code: string
  readonly details?: Readonly<Record<string, unknown>>

  constructor(code: string, message: string, details?: Readonly<Record<string, unknown>>) {
    super(message)
    this.name = 'XlsxFormatError'
    this.code = code
    this.details = details
  }
}

function asArrayBuffer(input: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (input instanceof ArrayBuffer) return input
  return input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength) as ArrayBuffer
}

function readWorkbook(input: ArrayBuffer | Uint8Array, inferDates: boolean): WorkBook {
  return readSheetJs(asArrayBuffer(input), {
    type: 'array',
    cellDates: inferDates,
    cellFormula: true,
    cellNF: true,
    cellText: true,
    UTC: true,
  })
}

/** Read a real SheetJS workbook; formula text and cached values are both retained. */
export function readXlsxWorkbook(input: ArrayBuffer | Uint8Array): WorkBook {
  return readWorkbook(input, true)
}

/** Write a SheetJS workbook without evaluating or adding any formulae. */
export function writeXlsxWorkbook(workbook: WorkBook, options: Pick<XlsxWriteOptions, 'compression'> = {}): Uint8Array {
  const output = writeSheetJs(workbook, {
    type: 'array',
    bookType: 'xlsx',
    compression: options.compression ?? true,
    cellDates: true,
  }) as ArrayBuffer
  return new Uint8Array(output)
}

function selectedSheet(workbook: WorkBook, sheetName?: string): { name: string; sheet: WorkSheet } {
  const name = sheetName ?? workbook.SheetNames[0]
  if (!name) {
    throw new XlsxFormatError('XLSX_NO_SHEETS', 'The workbook does not contain any worksheets')
  }
  const sheet = workbook.Sheets[name]
  if (!sheet) {
    throw new XlsxFormatError('XLSX_SHEET_NOT_FOUND', `Worksheet not found: ${name}`, {
      sheetName: name,
      availableSheets: [...workbook.SheetNames],
    })
  }
  return { name, sheet }
}

function pad(number: number, length = 2): string {
  return number.toString().padStart(length, '0')
}

function dateCellIsDateTime(cell: CellObject, value: Date): boolean {
  if (
    value.getUTCHours() !== 0 ||
    value.getUTCMinutes() !== 0 ||
    value.getUTCSeconds() !== 0 ||
    value.getUTCMilliseconds() !== 0
  ) {
    return true
  }
  return typeof cell.z === 'string' && /(?:^|[^\\])[hHsS]/u.test(cell.z.replace(/\[[^\]]*\]/gu, ''))
}

function formatDateCell(cell: CellObject, value: Date): string {
  if (Number.isNaN(value.getTime())) return String(cell.w ?? cell.v ?? '')
  const date = `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`
  if (!dateCellIsDateTime(cell, value)) return date
  const time = `${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}:${pad(value.getUTCSeconds())}`
  const milliseconds = value.getUTCMilliseconds()
  return `${date} ${time}${milliseconds === 0 ? '' : `.${pad(milliseconds, 3)}`}`
}

/** Use cell.v (the cached result) and deliberately never evaluate cell.f. */
function cellValue(cell: CellObject | undefined, inferDates: boolean): CellValue {
  if (!cell || cell.v === undefined || cell.v === null) return null
  const value = cell.v
  if (value instanceof Date) {
    return inferDates ? formatDateCell(cell, value) : (cell.w ?? value.toISOString())
  }
  if (cell.t === 'd' && inferDates) {
    const date = new Date(value as string | number)
    return formatDateCell(cell, date)
  }
  if (cell.t === 'b') return Boolean(value)
  if (cell.t === 'e') return cell.w ?? String(value)
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return value
  if ((value as unknown) instanceof Uint8Array) return value
  return String(value)
}

function sourceColumnIndexes(
  columns: readonly ColumnSchema[],
  selection: readonly XlsxColumnSelection[] | undefined,
): number[] {
  if (!selection) return columns.map((_, index) => index)
  return selection.map((selected) => {
    if (typeof selected === 'number') {
      if (!Number.isInteger(selected) || selected < 0 || selected >= columns.length) {
        throw new XlsxFormatError('XLSX_COLUMN_NOT_FOUND', `Worksheet column index is out of range: ${selected}`, {
          columnIndex: selected,
        })
      }
      return selected
    }
    const index = columns.findIndex((column) => column.name === selected)
    if (index < 0) {
      throw new XlsxFormatError('XLSX_COLUMN_NOT_FOUND', `Worksheet column not found: ${selected}`, {
        columnName: selected,
      })
    }
    return index
  })
}

/** Convert one selected worksheet into the shared table model. */
export function readXlsxTable(workbook: WorkBook, options: XlsxReadOptions = {}): XlsxTableResult {
  const headerRow = options.headerRow ?? 1
  if (!Number.isInteger(headerRow) || headerRow < 1) {
    throw new XlsxFormatError('XLSX_INVALID_HEADER_ROW', 'XLSX headerRow must be a positive one-based integer')
  }

  const { name: sheetName, sheet } = selectedSheet(workbook, options.sheetName)
  const hasHeader = options.hasHeader ?? true
  const inferDates = options.inferDates ?? true
  const tableName = options.tableName ?? sheetName
  const schemaId = `xlsx:${tableName}`
  const diagnostics: Diagnostic[] = []
  const range = sheet['!ref'] ? utils.decode_range(sheet['!ref']) : undefined
  const firstRow = headerRow - 1
  const firstColumn = range?.s.c ?? 0
  const lastColumn = range?.e.c ?? -1
  const lastRow = range?.e.r ?? -1
  const width = Math.max(0, lastColumn - firstColumn + 1)

  const valueAt = (row: number, column: number): CellValue => {
    const cell = sheet[utils.encode_cell({ r: row, c: column })] as CellObject | undefined
    return cellValue(cell, inferDates)
  }

  const headerValues = range && hasHeader
    ? Array.from({ length: width }, (_, index) => valueAt(firstRow, firstColumn + index))
    : []
  const columns: ColumnSchema[] = Array.from({ length: width }, (_, index) => {
    const headerValue = headerValues[index]
    const name = hasHeader ? (headerValue === null ? '' : String(headerValue)) : `Column${index + 1}`
    return {
      id: `${schemaId}:${firstColumn + index}`,
      name,
      dataType: 'unknown',
      nullable: true,
      source: {
        name,
        type: 'xlsx',
      },
    }
  })

  const indexes = sourceColumnIndexes(columns, options.columns)
  const selectedColumns = indexes.map((index) => columns[index])
  const rows: TableRow[] = []
  const dataStart = firstRow + (hasHeader ? 1 : 0)
  for (let rowIndex = dataStart; rowIndex <= lastRow; rowIndex += 1) {
    rows.push(indexes.map((sourceIndex) => valueAt(rowIndex, firstColumn + sourceIndex)))
  }

  if (!range) {
    diagnostics.push({
      code: 'XLSX_EMPTY_SHEET',
      severity: 'info',
      message: `Worksheet ${sheetName} is empty`,
      location: { tableName: sheetName },
    })
  } else if (hasHeader && firstRow > lastRow) {
    diagnostics.push({
      code: 'XLSX_HEADER_OUTSIDE_RANGE',
      severity: 'warning',
      message: `Header row ${headerRow} is outside the used range of worksheet ${sheetName}`,
      location: { tableName: sheetName, rowIndex: firstRow },
    })
  }

  return {
    schema: {
      id: schemaId,
      name: tableName,
      columns: selectedColumns,
      source: {
        format: 'xlsx',
        fileName: options.fileName,
        sheetName,
      },
    },
    rows,
    diagnostics,
    sheetName,
    sheetNames: [...workbook.SheetNames],
  }
}

/** Read and project a worksheet in one call. */
export function readXlsx(input: ArrayBuffer | Uint8Array, options: XlsxReadOptions = {}): XlsxReadResult {
  const workbook = readWorkbook(input, options.inferDates ?? true)
  return { workbook, ...readXlsxTable(workbook, options) }
}

function validateSheetName(sheetName: string): void {
  if (!sheetName || sheetName.length > 31 || /[\\/*?:[\]]/u.test(sheetName)) {
    throw new XlsxFormatError('XLSX_INVALID_SHEET_NAME', `Invalid Excel worksheet name: ${sheetName}`, { sheetName })
  }
}

function outputValue(value: CellValue, rowIndex: number, columnIndex: number): string | number | boolean | null {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new XlsxFormatError('XLSX_NON_FINITE_NUMBER', 'XLSX cannot contain NaN or Infinity as numbers', {
        rowIndex,
        columnIndex,
      })
    }
    return value
  }
  throw new XlsxFormatError('XLSX_UNSUPPORTED_VALUE', 'Binary values require an explicit text encoding before XLSX export', {
    rowIndex,
    columnIndex,
  })
}

/** Create a workbook from table data. Strings beginning with '=' remain plain strings. */
export function createXlsxWorkbook(
  schema: TableSchema,
  rows: readonly TableRow[],
  options: XlsxWriteOptions = {},
): WorkBook {
  const sheetName = options.sheetName ?? schema.name ?? 'Sheet1'
  validateSheetName(sheetName)
  if (schema.columns.length === 0) {
    throw new XlsxFormatError('XLSX_NO_COLUMNS', 'Cannot export a table with zero columns')
  }

  const output: (string | number | boolean | null)[][] = []
  if (options.includeHeader ?? true) output.push(schema.columns.map((column) => column.name))
  rows.forEach((row, rowIndex) => {
    output.push(schema.columns.map((_, columnIndex) => outputValue(row[columnIndex] ?? null, rowIndex, columnIndex)))
  })

  const workbook = utils.book_new()
  const sheet = utils.aoa_to_sheet(output, { UTC: true, cellDates: true })
  utils.book_append_sheet(workbook, sheet, sheetName)
  return workbook
}

export function writeXlsx(
  schema: TableSchema,
  rows: readonly TableRow[],
  options: XlsxWriteOptions = {},
): Uint8Array {
  return writeXlsxWorkbook(createXlsxWorkbook(schema, rows, options), options)
}

export class SheetJsXlsxAdapter implements XlsxAdapter {
  read(input: ArrayBuffer | Uint8Array): WorkBook {
    return readXlsxWorkbook(input)
  }

  write(workbook: WorkBook): Uint8Array {
    return writeXlsxWorkbook(workbook)
  }

  readTable(workbook: WorkBook, options: XlsxReadOptions = {}): XlsxTableResult {
    return readXlsxTable(workbook, options)
  }

  writeTable(schema: TableSchema, rows: readonly TableRow[], options: XlsxWriteOptions = {}): Uint8Array {
    return writeXlsx(schema, rows, options)
  }
}
