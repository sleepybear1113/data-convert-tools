import iconv from 'iconv-lite'
import Papa from 'papaparse'

import type { Diagnostic } from '../model/diagnostic'
import type { ColumnSchema, TableRow, TableSchema } from '../model/table'
import type { CellValue } from '../model/value'

export type CsvInput = ArrayBuffer | Uint8Array | string
export type CsvLineEnding = '\n' | '\r\n' | '\r'

export interface CsvReadOptions {
  /** Any iconv-lite encoding. UTF-8 and GBK are the formats exposed by the UI. */
  encoding?: string
  /** Leave undefined to let Papa Parse detect the delimiter. */
  delimiter?: string
  hasHeader?: boolean
  /** Optional maximum number of data rows returned for a preview. */
  sampleSize?: number
  quoteChar?: string
  escapeChar?: string
  lineEnding?: CsvLineEnding
  skipEmptyLines?: boolean | 'greedy'
  fileName?: string
  tableName?: string
}

export interface CsvWriteOptions {
  encoding?: 'utf-8' | 'gbk' | string
  /** A BOM is emitted only for UTF-8. Defaults to true for UTF-8. */
  bom?: boolean
  delimiter?: string
  lineEnding?: '\n' | '\r\n'
  includeHeader?: boolean
  quoteChar?: string
  escapeChar?: string
  /** Reject characters that iconv-lite would replace. Defaults to true. */
  strict?: boolean
}

export interface CsvReadMeta {
  encoding: string
  bom: boolean
  delimiter: string
  lineEnding?: string
  truncated: boolean
}

export interface CsvReadResult {
  schema: TableSchema
  rows: readonly TableRow[]
  diagnostics: readonly Diagnostic[]
  meta: CsvReadMeta
}

export const DEFAULT_CSV_WRITE_OPTIONS: Required<
  Pick<CsvWriteOptions, 'encoding' | 'bom' | 'delimiter' | 'lineEnding' | 'includeHeader' | 'quoteChar' | 'strict'>
> = {
  encoding: 'utf-8',
  bom: true,
  delimiter: ',',
  lineEnding: '\r\n',
  includeHeader: true,
  quoteChar: '"',
  strict: true,
}

export class CsvFormatError extends Error {
  readonly code: string
  readonly details?: Readonly<Record<string, unknown>>

  constructor(code: string, message: string, details?: Readonly<Record<string, unknown>>) {
    super(message)
    this.name = 'CsvFormatError'
    this.code = code
    this.details = details
  }
}

function asBytes(input: ArrayBuffer | Uint8Array): Uint8Array {
  return input instanceof Uint8Array ? input : new Uint8Array(input)
}

function hasUtf8Bom(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
}

function validateDelimiter(delimiter: string): void {
  if (!delimiter || /[\r\n"\ufeff]/u.test(delimiter)) {
    throw new CsvFormatError('CSV_INVALID_DELIMITER', 'CSV 分隔符不能为空，且不能包含引号或换行符')
  }
}

function validateQuoteChar(quoteChar: string): void {
  if ([...quoteChar].length !== 1 || /[\r\n]/u.test(quoteChar)) {
    throw new CsvFormatError('CSV_INVALID_QUOTE', 'CSV 引用字符必须为单个字符，且不能是换行符')
  }
}

function validateSampleSize(sampleSize: number | undefined): void {
  if (sampleSize !== undefined && (!Number.isInteger(sampleSize) || sampleSize < 0)) {
    throw new CsvFormatError('CSV_INVALID_SAMPLE_SIZE', 'CSV 抽样行数必须为非负整数')
  }
}

/** Decode bytes without relying on Node's Buffer or browser TextDecoder GBK support. */
export function decodeCsv(input: CsvInput, encoding = 'utf-8'): { text: string; bom: boolean } {
  if (!iconv.encodingExists(encoding)) {
    throw new CsvFormatError('CSV_UNSUPPORTED_ENCODING', `不支持的 CSV 编码：${encoding}`, { encoding })
  }

  if (typeof input === 'string') {
    const bom = input.charCodeAt(0) === 0xfeff
    return { text: bom ? input.slice(1) : input, bom }
  }

  const original = asBytes(input)
  const bom = hasUtf8Bom(original)
  const bytes = bom ? original.subarray(3) : original
  return { text: iconv.decode(bytes, encoding, { stripBOM: true }), bom }
}

function diagnosticFromParseError(error: Papa.ParseError): Diagnostic {
  const location: Diagnostic['location'] = {
    rowIndex: error.row,
  }

  return {
    code: `CSV_PARSE_${error.code.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()}`,
    severity: error.code === 'UndetectableDelimiter' ? 'warning' : 'error',
    message: error.message,
    location: error.row === undefined ? undefined : location,
    details: {
      type: error.type,
      index: error.index,
    },
  }
}

/**
 * Parse CSV into the shared table model. Values stay as strings: Papa's dynamic
 * typing is deliberately disabled so identifiers and precision are not lost.
 */
export function readCsv(input: CsvInput, options: CsvReadOptions = {}): CsvReadResult {
  const encoding = options.encoding ?? 'utf-8'
  const hasHeader = options.hasHeader ?? true
  validateSampleSize(options.sampleSize)
  if (options.delimiter !== undefined) validateDelimiter(options.delimiter)
  if (options.quoteChar !== undefined) validateQuoteChar(options.quoteChar)
  if (options.escapeChar !== undefined) validateQuoteChar(options.escapeChar)

  const decoded = decodeCsv(input, encoding)
  const quoteChar = options.quoteChar ?? '"'
  const parsed = Papa.parse<string[]>(decoded.text, {
    header: false,
    dynamicTyping: false,
    delimiter: options.delimiter ?? '',
    newline: options.lineEnding,
    quoteChar,
    escapeChar: options.escapeChar ?? quoteChar,
    skipEmptyLines: options.skipEmptyLines ?? false,
  })

  const allRows = parsed.data
  const header = hasHeader ? (allRows[0] ?? []) : undefined
  const dataRows = hasHeader ? allRows.slice(1) : allRows
  const width = dataRows.reduce((maximum, row) => Math.max(maximum, row.length), header?.length ?? 0)
  const tableName = options.tableName ?? options.fileName?.replace(/\.[^.]*$/u, '') ?? 'csv'
  const schemaId = `csv:${tableName}`

  const columns: ColumnSchema[] = Array.from({ length: width }, (_, index) => {
    const headerName = header?.[index]
    const name = hasHeader ? (headerName ?? '') : `Column${index + 1}`
    return {
      id: `${schemaId}:${index}`,
      name,
      dataType: 'unknown',
      nullable: true,
      source: {
        name,
        type: 'csv',
      },
    }
  })

  const limitedRows = options.sampleSize === undefined ? dataRows : dataRows.slice(0, options.sampleSize)
  const rows: TableRow[] = limitedRows.map((row) =>
    Array.from({ length: width }, (_, index): CellValue => (index < row.length ? row[index] : null)),
  )

  const diagnostics = parsed.errors.map(diagnosticFromParseError)
  if (options.sampleSize !== undefined && dataRows.length > limitedRows.length) {
    diagnostics.push({
      code: 'CSV_SAMPLE_LIMIT',
      severity: 'info',
      message: `CSV 预览仅读取 ${dataRows.length} 行数据中的前 ${limitedRows.length} 行`,
      details: { sampledRows: limitedRows.length, totalRows: dataRows.length },
    })
  }

  return {
    schema: {
      id: schemaId,
      name: tableName,
      columns,
      source: {
        format: 'csv',
        fileName: options.fileName,
        encoding,
      },
    },
    rows,
    diagnostics,
    meta: {
      encoding,
      bom: decoded.bom,
      delimiter: parsed.meta.delimiter || options.delimiter || ',',
      lineEnding: parsed.meta.linebreak,
      truncated: limitedRows.length < dataRows.length,
    },
  }
}

function csvValue(value: CellValue, rowIndex: number, columnIndex: number): string | number | boolean | null {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new CsvFormatError('CSV_NON_FINITE_NUMBER', 'CSV 不能包含 NaN 或 Infinity', {
        rowIndex,
        columnIndex,
      })
    }
    return value
  }
  throw new CsvFormatError('CSV_UNSUPPORTED_VALUE', '二进制值需要在导出 CSV 前显式指定文本编码', {
    rowIndex,
    columnIndex,
  })
}

function assertEncodable(value: string, encoding: string, rowIndex?: number, columnIndex?: number): void {
  const encoded = iconv.encode(value, encoding)
  if (iconv.decode(encoded, encoding) !== value) {
    throw new CsvFormatError('CSV_ENCODING_ERROR', `该值无法无损地以 ${encoding} 编码表示`, {
      encoding,
      rowIndex,
      columnIndex,
    })
  }
}

/** Serialize a table with Papa Parse and encode it with iconv-lite. */
export function writeCsv(
  schema: TableSchema,
  sourceRows: readonly TableRow[],
  options: CsvWriteOptions = {},
): Uint8Array {
  const encoding = options.encoding ?? DEFAULT_CSV_WRITE_OPTIONS.encoding
  if (!iconv.encodingExists(encoding)) {
    throw new CsvFormatError('CSV_UNSUPPORTED_ENCODING', `不支持的 CSV 编码：${encoding}`, { encoding })
  }

  const delimiter = options.delimiter ?? DEFAULT_CSV_WRITE_OPTIONS.delimiter
  const quoteChar = options.quoteChar ?? DEFAULT_CSV_WRITE_OPTIONS.quoteChar
  const strict = options.strict ?? DEFAULT_CSV_WRITE_OPTIONS.strict
  const includeHeader = options.includeHeader ?? DEFAULT_CSV_WRITE_OPTIONS.includeHeader
  validateDelimiter(delimiter)
  validateQuoteChar(quoteChar)
  if (options.escapeChar !== undefined) validateQuoteChar(options.escapeChar)

  if (schema.columns.length === 0) {
    throw new CsvFormatError('CSV_NO_COLUMNS', '不能导出没有列的表')
  }

  const output: (string | number | boolean | null)[][] = []
  if (includeHeader) output.push(schema.columns.map((column) => column.name))
  sourceRows.forEach((row, rowIndex) => {
    output.push(schema.columns.map((_, columnIndex) => csvValue(row[columnIndex] ?? null, rowIndex, columnIndex)))
  })

  if (strict) {
    output.forEach((row, rowIndex) => {
      row.forEach((value, columnIndex) => {
        if (typeof value === 'string') assertEncodable(value, encoding, rowIndex, columnIndex)
      })
    })
    assertEncodable(delimiter, encoding)
    assertEncodable(quoteChar, encoding)
  }

  const text = Papa.unparse(output, {
    header: false,
    delimiter,
    newline: options.lineEnding ?? DEFAULT_CSV_WRITE_OPTIONS.lineEnding,
    quoteChar,
    escapeChar: options.escapeChar ?? quoteChar,
  })
  const encoded = iconv.encode(text, encoding)
  const bom = (options.bom ?? DEFAULT_CSV_WRITE_OPTIONS.bom) && encoding.toLowerCase().replace(/[_-]/g, '') === 'utf8'

  if (!bom) return new Uint8Array(encoded.buffer, encoded.byteOffset, encoded.byteLength)
  const result = new Uint8Array(encoded.length + 3)
  result.set([0xef, 0xbb, 0xbf])
  result.set(encoded, 3)
  return result
}
