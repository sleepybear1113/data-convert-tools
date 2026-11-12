import Decimal from 'decimal.js'
import iconv from 'iconv-lite'

import type { DbfFieldDescriptor, DbfFieldType } from '../dbf/types'
import type { Diagnostic } from '../model/diagnostic'
import type { ColumnMapping } from '../model/conversion'
import type { TableRow, TableSchema } from '../model/table'
import type { CellValue } from '../model/value'
import { isValidDateOnly } from './infer-column'
import { validateColumnMapping } from './mapping'

export interface DbfTargetColumn {
  sourceIndex: number
  name: string
  type: DbfFieldType
  length: number
  decimalPlaces: number
  nullable: boolean
  flags?: number
  system?: boolean
}

export interface DbfTargetOptions {
  strict?: boolean
  encoding?: string
  allowRename?: boolean
  allowTruncate?: boolean
  allowTypeWidening?: boolean
}

export const DEFAULT_DBF_TARGET_OPTIONS: Required<DbfTargetOptions> = {
  strict: true,
  encoding: 'gbk',
  allowRename: false,
  allowTruncate: false,
  allowTypeWidening: false,
}

export interface DbfTargetSchema {
  columns: readonly DbfTargetColumn[]
  diagnostics: readonly Diagnostic[]
  canWrite: boolean
}

const SUPPORTED_TYPES = new Set(['C', 'N', 'F', 'Y', 'D', 'L', 'I', 'T', 'B'])
const FIXED_FIELDS: Readonly<Record<string, { length: number; decimalPlaces: number }>> = {
  Y: { length: 8, decimalPlaces: 4 },
  D: { length: 8, decimalPlaces: 0 },
  L: { length: 1, decimalPlaces: 0 },
  I: { length: 4, decimalPlaces: 0 },
  T: { length: 8, decimalPlaces: 0 },
  B: { length: 8, decimalPlaces: 0 },
}
const MAX_SAFE_CURRENCY = new Decimal('922337203685477.5807')
const MIN_SAFE_CURRENCY = new Decimal('-922337203685477.5808')

function diagnostic(
  diagnostics: Diagnostic[],
  severity: Diagnostic['severity'],
  code: string,
  message: string,
  sourceIndex?: number,
  rowIndex?: number,
  columnName?: string,
): void {
  diagnostics.push({
    code,
    severity,
    message,
    location: sourceIndex === undefined && rowIndex === undefined
      ? undefined
      : { columnIndex: sourceIndex, rowIndex, columnName },
  })
}

function valuesFor(rows: readonly TableRow[], sourceIndex: number): CellValue[] {
  return rows.map((row) => row[sourceIndex] ?? null)
}

function decimalValue(value: CellValue): Decimal | undefined {
  if (value === null || typeof value === 'boolean' || value instanceof Uint8Array) return undefined
  try {
    const result = new Decimal(value.toString().trim())
    return result.isFinite() ? result : undefined
  } catch {
    return undefined
  }
}

function integerDigits(value: Decimal): number {
  return value.isZero() ? 1 : Math.max(1, value.e + 1)
}

function fitsInteger(value: CellValue): boolean {
  const decimal = decimalValue(value)
  return decimal !== undefined && decimal.isInteger() && decimal.gte(-2147483648) && decimal.lte(2147483647)
}

function inferredType(dataType: TableSchema['columns'][number]['dataType'], values: readonly CellValue[]): DbfFieldType {
  switch (dataType) {
    case 'integer':
      return values.every((value) => value === null || fitsInteger(value)) ? 'I' : 'N'
    case 'decimal':
      return 'N'
    case 'float':
      return 'F'
    case 'boolean':
      return 'L'
    case 'date':
      return 'D'
    case 'datetime':
      return 'T'
    case 'string':
    case 'unknown':
    case 'empty':
      return 'C'
    case 'binary':
      return 'unknown'
  }
}

function textValue(value: CellValue): string | undefined {
  if (value === null) return ''
  if (value instanceof Uint8Array) return undefined
  return typeof value === 'string' ? value : value.toString()
}

export function encodedLength(value: string, encoding: string): number {
  return iconv.encode(value, encoding).length
}

export function isEncodable(value: string, encoding: string): boolean {
  return iconv.decode(iconv.encode(value, encoding), encoding) === value
}

export function truncateEncoded(value: string, maxBytes: number, encoding: string): string {
  let result = ''
  let bytes = 0
  for (const character of value) {
    const length = encodedLength(character, encoding)
    if (bytes + length > maxBytes) break
    result += character
    bytes += length
  }
  return result
}

function inferredTextLength(values: readonly CellValue[], encoding: string): number {
  let length = 1
  for (const value of values) {
    const text = textValue(value)
    if (text !== undefined) length = Math.max(length, encodedLength(text, encoding))
  }
  return length
}

function sourceDecimalPlaces(value: CellValue): number {
  if (typeof value !== 'string') return 0
  const match = value.trim().match(/^[+-]?(?:\d+(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/u)
  if (!match) return 0
  const fractionDigits = (match[1] ?? match[2])?.length ?? 0
  const exponent = match[3] ? Number(match[3]) : 0
  return Math.max(0, fractionDigits - exponent)
}

function numericDimensions(values: readonly CellValue[]): {
  length: number
  decimalPlaces: number
  valid: boolean
} {
  const decimals: Decimal[] = []
  let valid = true
  for (const value of values) {
    if (value === null) continue
    const decimal = decimalValue(value)
    if (!decimal) valid = false
    else decimals.push(decimal)
  }
  const decimalPlaces = values.reduce<number>((maximum, value) => {
    const decimal = value === null ? undefined : decimalValue(value)
    return Math.max(maximum, decimal?.decimalPlaces() ?? 0, sourceDecimalPlaces(value))
  }, 0)
  const digits = decimals.reduce((maximum, value) => Math.max(maximum, integerDigits(value)), 1)
  const signed = decimals.some((value) => value.s < 0)
  return {
    length: Math.max(1, digits + (signed ? 1 : 0) + (decimalPlaces > 0 ? decimalPlaces + 1 : 0)),
    decimalPlaces,
    valid,
  }
}

function requiredNumericLength(values: readonly CellValue[], decimalPlaces: number): number {
  return values.reduce<number>((maximum, value) => {
    if (value === null) return maximum
    const decimal = decimalValue(value)
    if (!decimal) return maximum
    const length = integerDigits(decimal) + (decimal.s < 0 ? 1 : 0) +
      (decimalPlaces > 0 ? decimalPlaces + 1 : 0)
    return Math.max(maximum, length)
  }, 1)
}

function validDateTime(value: string): boolean {
  const match = value.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/u)
  if (!match || !isValidDateOnly(match[1], ['YYYY-MM-DD'])) return false
  return Number(match[2]) <= 23 && Number(match[3]) <= 59 && Number(match[4]) <= 59
}

function resolveNames(
  columns: readonly DbfTargetColumn[],
  rawNames: readonly string[],
  options: Required<DbfTargetOptions>,
  encodingValid: boolean,
  diagnostics: Diagnostic[],
): DbfTargetColumn[] {
  const used = new Set<string>()
  return columns.map((column, index) => {
    const rawName = rawNames[index]
    let name = rawName.trim()
    const mayRename = !options.strict && options.allowRename && encodingValid
    if (mayRename) {
      name = name.replace(/[\u0000-\u001f\u007f]/gu, '_') || 'column'
      name = truncateEncoded(name, 10, options.encoding)
      const base = name
      let suffix = 2
      while (used.has(name.toLowerCase())) {
        const suffixText = `_${suffix}`
        name = `${truncateEncoded(base, 10 - encodedLength(suffixText, options.encoding), options.encoding)}${suffixText}`
        suffix += 1
      }
    }
    const duplicate = used.has(name.toLowerCase())
    used.add(name.toLowerCase())
    if (duplicate && !mayRename) {
      diagnostic(diagnostics, 'error', 'DBF_DUPLICATE_COLUMN_NAME', `DBF 列名重复：${name}`, column.sourceIndex, undefined, name)
    }
    if (!mayRename && /[\u0000-\u001f\u007f]/u.test(name)) {
      diagnostic(diagnostics, 'error', 'DBF_INVALID_COLUMN_NAME', `DBF 列名包含控制字符：${name}`, column.sourceIndex, undefined, name)
    }

    if (name !== rawName) {
      diagnostic(
        diagnostics,
        mayRename ? 'warning' : 'error',
        mayRename ? 'DBF_COLUMN_RENAMED' : 'DBF_INVALID_COLUMN_NAME',
        mayRename
          ? `DBF 列 ${rawName || '（空）'} 已自动重命名为 ${name}`
          : `DBF 列名为空、过长、重复或包含控制字符：${rawName}`,
        column.sourceIndex,
        undefined,
        rawName,
      )
    }
    if (!name) {
      diagnostic(diagnostics, 'error', 'DBF_EMPTY_COLUMN_NAME', 'DBF 列名不能为空', column.sourceIndex)
    } else if (encodingValid && encodedLength(name, options.encoding) > 10) {
      diagnostic(diagnostics, 'error', 'DBF_COLUMN_NAME_TOO_LONG', `DBF 列名超过 10 个编码字节：${name}`, column.sourceIndex, undefined, name)
    }
    return { ...column, name }
  })
}

function validateAndCoerceValue(
  column: DbfTargetColumn,
  value: CellValue,
  options: Required<DbfTargetOptions>,
  diagnostics: Diagnostic[],
  rowIndex: number,
): void {
  const location = (severity: Diagnostic['severity'], code: string, message: string): void => {
    diagnostic(diagnostics, severity, code, message, column.sourceIndex, rowIndex, column.name)
  }
  if (value === null) {
    if (!column.nullable) location('error', 'DBF_UNEXPECTED_NULL', `不可空的 DBF 列 ${column.name} 包含 NULL`)
    return
  }

  if (column.type === 'C') {
    const text = textValue(value)
    if (text === undefined) {
      location('error', 'DBF_BINARY_AS_TEXT', `列 ${column.name} 的二进制值需要显式指定文本编码`)
      return
    }
    if (!isEncodable(text, options.encoding)) {
      location('error', 'DBF_ENCODING_ERROR', `列 ${column.name} 包含无法以 ${options.encoding} 编码的文本`)
      return
    }
    if (encodedLength(text, options.encoding) > column.length) {
      const compatible = !options.strict && options.allowTruncate
      location(
        compatible ? 'warning' : 'error',
        compatible ? 'DBF_TRUNCATION_REQUIRED' : 'DBF_TEXT_OVERFLOW',
        `列 ${column.name} 的文本超过 ${column.length} 个编码字节${compatible ? '；需要显式截断' : ''}`,
      )
    }
    return
  }

  if (column.type === 'D') {
    if (typeof value !== 'string' || !isValidDateOnly(value, ['YYYY-MM-DD', 'YYYY/MM/DD'])) {
      location('error', 'DBF_INVALID_DATE', `列 ${column.name} 需要有效的 YYYY-MM-DD 或 YYYY/MM/DD 日期`)
    }
    return
  }
  if (column.type === 'T') {
    if (typeof value !== 'string' || !validDateTime(value)) {
      location('error', 'DBF_INVALID_DATETIME', `列 ${column.name} 需要不含时区的 YYYY-MM-DD HH:MM:SS[.SSS] 日期时间`)
    }
    return
  }
  if (column.type === 'L') {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : value
    const valid = typeof normalized === 'boolean' || normalized === 0 || normalized === 1 || normalized === 0n || normalized === 1n ||
      (typeof normalized === 'string' && ['true', 'yes', 'y', 'false', 'no', 'n'].includes(normalized))
    if (!valid) location('error', 'DBF_INVALID_BOOLEAN', `列 ${column.name} 包含无效的逻辑值`)
    return
  }

  const decimal = decimalValue(value)
  if (!decimal) {
    location('error', 'DBF_INVALID_NUMBER', `列 ${column.name} 包含非数值或非有限值`)
    return
  }
  if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) {
    location('warning', 'DBF_UNSAFE_SOURCE_NUMBER', `列 ${column.name} 包含可能已损失精度的 JavaScript 整数`)
  }
  if (column.type === 'I') {
    if (!decimal.isInteger() || !decimal.gte(-2147483648) || !decimal.lte(2147483647)) {
      location('error', 'DBF_INTEGER_OVERFLOW', `列 ${column.name} 需要 32 位有符号整数`)
    }
    return
  }
  if (column.type === 'B') {
    const double = Number(decimal.toString())
    if (!Number.isFinite(double)) {
      location('error', 'DBF_DOUBLE_OVERFLOW', `列 ${column.name} 超出有限的 Double 范围`)
    } else if (!new Decimal(double.toString()).eq(decimal)) {
      const compatible = !options.strict && options.allowTruncate
      location(
        compatible ? 'warning' : 'error',
        compatible ? 'DBF_ROUNDING_REQUIRED' : 'DBF_DOUBLE_PRECISION',
        `列 ${column.name} 转换为 Double 会丢失小数精度`,
      )
    }
    return
  }
  if (column.type === 'Y') {
    if (!decimal.gte(MIN_SAFE_CURRENCY) || !decimal.lte(MAX_SAFE_CURRENCY)) {
      location('error', 'DBF_CURRENCY_OVERFLOW', `列 ${column.name} 超出 64 位有符号货币范围`)
    }
    if (!decimal.toDecimalPlaces(4).eq(decimal)) {
      const compatible = !options.strict && options.allowTruncate
      location(compatible ? 'warning' : 'error', compatible ? 'DBF_ROUNDING_REQUIRED' : 'DBF_DECIMAL_OVERFLOW', `列 ${column.name} 的货币值超过 4 位有效小数`)
    }
    return
  }
  if (column.type !== 'N' && column.type !== 'F') return

  if (!decimal.toDecimalPlaces(column.decimalPlaces).eq(decimal)) {
    const compatible = !options.strict && options.allowTruncate
    location(compatible ? 'warning' : 'error', compatible ? 'DBF_ROUNDING_REQUIRED' : 'DBF_DECIMAL_OVERFLOW', `列 ${column.name} 的数值超过 ${column.decimalPlaces} 位小数`)
  }
  // 按舍入后数值的实际小数位数计算所需宽度：整数（如 110 写入 N(4,1)）不需要
  // 小数点与小数位，不应被元数据里的 decimalPlaces 误判为溢出。
  const rounded = decimal.toDecimalPlaces(column.decimalPlaces)
  const fractionDigits = rounded.dp()
  const requiredLength = integerDigits(rounded) + (rounded.s < 0 ? 1 : 0) +
    (fractionDigits > 0 ? fractionDigits + 1 : 0)
  if (requiredLength > column.length) {
    location('error', 'DBF_NUMERIC_OVERFLOW', `列 ${column.name} 的数值需要 ${requiredLength} 个字符，字段宽度为 ${column.length}`)
  }
}

/** Infer DBF C/N/F/Y/D/L/I/T/B fields and strictly validate every supplied value. */
export function inferDbfTargetSchema(
  sourceSchema: TableSchema,
  rows: readonly TableRow[] = [],
  options: DbfTargetOptions = {},
  suppliedMappings?: readonly ColumnMapping[],
): DbfTargetSchema {
  const resolved = { ...DEFAULT_DBF_TARGET_OPTIONS, ...options }
  const diagnostics: Diagnostic[] = []
  const encodingValid = iconv.encodingExists(resolved.encoding)
  if (!encodingValid) {
    diagnostic(diagnostics, 'error', 'DBF_UNSUPPORTED_ENCODING', `不支持的 DBF 编码：${resolved.encoding}`)
  }

  const mappings = suppliedMappings ?? sourceSchema.columns.map((column, sourceIndex): ColumnMapping => ({
    sourceIndex,
    included: true,
    targetName: column.name,
    targetType: column.dataType,
  }))
  const mappingDiagnostics = validateColumnMapping(sourceSchema, mappings, { requireIncludedColumn: true }).diagnostics
  diagnostics.push(...mappingDiagnostics.filter((item) => {
    const renameable = item.code === 'MAPPING_DUPLICATE_NAME' || item.code === 'MAPPING_EMPTY_NAME'
    return !(renameable && !resolved.strict && resolved.allowRename && encodingValid)
  }))
  const included = mappings.filter((mapping) => mapping.included && sourceSchema.columns[mapping.sourceIndex])
  const rawNames: string[] = []
  const columns: DbfTargetColumn[] = []

  for (const mapping of included) {
    const source = sourceSchema.columns[mapping.sourceIndex]
    const values = valuesFor(rows, mapping.sourceIndex)
    const sourceType = source.source?.type?.toUpperCase()
    const requestedType = mapping.dbfType?.toUpperCase()
    let type: DbfFieldType
    if (requestedType) {
      type = (SUPPORTED_TYPES.has(requestedType) ? requestedType : 'unknown') as DbfFieldType
      if (!SUPPORTED_TYPES.has(requestedType)) {
        diagnostic(diagnostics, 'error', 'DBF_UNSUPPORTED_TYPE', `列 ${mapping.targetName} 请求的 DBF 类型 ${requestedType} 不受支持`, mapping.sourceIndex)
      }
    } else if (sourceType && SUPPORTED_TYPES.has(sourceType)) {
      type = sourceType as DbfFieldType
    } else {
      type = inferredType(mapping.targetType ?? source.dataType, values)
      if (type === 'unknown') {
        diagnostic(diagnostics, 'error', 'DBF_UNSUPPORTED_TYPE', `二进制/未知列 ${mapping.targetName} 需要显式指定支持的 DBF 类型`, mapping.sourceIndex)
      }
    }

    const dimensions = type === 'N' || type === 'F' ? numericDimensions(values) : undefined
    const fixed = FIXED_FIELDS[type]
    let length = mapping.dbfSize ?? source.source?.size ?? fixed?.length ??
      (type === 'C'
        ? encodingValid ? inferredTextLength(values, resolved.encoding) : 1
        : dimensions?.length ?? 1)
    let decimalPlaces = mapping.dbfDecimalPlaces ?? source.source?.decimalPlaces ?? fixed?.decimalPlaces ??
      (type === 'N' || type === 'F' ? dimensions?.decimalPlaces ?? 0 : 0)

    if (type === 'C') {
      decimalPlaces = 0
      if (encodingValid && !resolved.strict && resolved.allowTypeWidening) {
        const requiredLength = inferredTextLength(values, resolved.encoding)
        if (requiredLength > length && requiredLength <= 254) {
          diagnostic(diagnostics, 'warning', 'DBF_FIELD_WIDENED', `字符字段 ${mapping.targetName} 已放宽为 ${requiredLength} 字节`, mapping.sourceIndex)
          length = requiredLength
        } else if (requiredLength > 254 && resolved.allowTruncate) {
          diagnostic(diagnostics, 'warning', 'DBF_FIELD_LENGTH_REDUCED', `字符字段 ${mapping.targetName} 已限制为 254 字节`, mapping.sourceIndex)
          length = 254
        }
      }
      if (length > 254 && !resolved.strict && resolved.allowTruncate) {
        diagnostic(diagnostics, 'warning', 'DBF_FIELD_LENGTH_REDUCED', `字符字段 ${mapping.targetName} 已限制为 254 字节`, mapping.sourceIndex)
        length = 254
      }
    }

    if ((type === 'N' || type === 'F') && !resolved.strict && resolved.allowTypeWidening && encodingValid) {
      const requiredLength = requiredNumericLength(values, decimalPlaces)
      if (length > 20 || requiredLength > 20) {
        const widenedLength = inferredTextLength(values, resolved.encoding)
        diagnostic(diagnostics, 'warning', 'DBF_TYPE_WIDENED', `数值字段 ${mapping.targetName} 已放宽为 C 类型以保留精度`, mapping.sourceIndex)
        type = 'C'
        length = Math.min(254, widenedLength)
        decimalPlaces = 0
      } else if (requiredLength > length) {
        diagnostic(diagnostics, 'warning', 'DBF_FIELD_WIDENED', `数值字段 ${mapping.targetName} 已放宽为 ${requiredLength} 字符`, mapping.sourceIndex)
        length = requiredLength
      }
    }

    rawNames.push(mapping.targetName)
    columns.push({
      sourceIndex: mapping.sourceIndex,
      name: mapping.targetName,
      type,
      length,
      decimalPlaces,
      nullable: source.source?.nullable ?? source.nullable,
      flags: source.source?.flags,
      system: source.source?.system ?? false,
    })
  }

  const namedColumns = resolveNames(columns, rawNames, resolved, encodingValid, diagnostics)
  for (let index = 0; index < namedColumns.length; index += 1) {
    const column = namedColumns[index]
    const values = valuesFor(rows, column.sourceIndex)
    const fixed = FIXED_FIELDS[column.type]

    if (!SUPPORTED_TYPES.has(column.type)) continue
    if (!Number.isInteger(column.length) || column.length < 1) {
      diagnostic(diagnostics, 'error', 'DBF_INVALID_LENGTH', `DBF 字段 ${column.name} 的长度无效`, column.sourceIndex)
    } else if (column.type === 'C' && column.length > 254) {
      diagnostic(diagnostics, 'error', 'DBF_INVALID_LENGTH', `字符字段 ${column.name} 超过 VFP 的 254 字节限制`, column.sourceIndex)
    } else if ((column.type === 'N' || column.type === 'F') && column.length > 20) {
      diagnostic(diagnostics, 'error', 'DBF_NUMERIC_FIELD_TOO_WIDE', `数值字段 ${column.name} 超过 VFP 的 20 字符限制`, column.sourceIndex)
    }
    if (fixed && (column.length !== fixed.length || column.decimalPlaces !== fixed.decimalPlaces)) {
      diagnostic(diagnostics, 'error', 'DBF_INVALID_FIXED_FIELD', `${column.type} 类型字段 ${column.name} 必须使用长度 ${fixed.length} 和 ${fixed.decimalPlaces} 位小数`, column.sourceIndex)
    }
    if (!Number.isInteger(column.decimalPlaces) || column.decimalPlaces < 0 ||
      ((column.type === 'N' || column.type === 'F') && (column.decimalPlaces > 19 || column.decimalPlaces >= column.length)) ||
      (column.type !== 'N' && column.type !== 'F' && column.type !== 'Y' && column.decimalPlaces !== 0)) {
      diagnostic(diagnostics, 'error', 'DBF_INVALID_DECIMALS', `DBF 字段 ${column.name} 的小数位无效`, column.sourceIndex)
    }
    if (encodingValid && !isEncodable(column.name, resolved.encoding)) {
      diagnostic(diagnostics, 'error', 'DBF_ENCODING_ERROR', `列名 ${column.name} 无法以 ${resolved.encoding} 编码`, column.sourceIndex)
    }

    // Invalid field dimensions are reported above; skip expensive numeric formatting.
    const dimensionsValid = column.length >= 1 && column.length <= (column.type === 'C' ? 254 : 20) &&
      column.decimalPlaces >= 0 && column.decimalPlaces <= 20
    if (dimensionsValid || !['N', 'F'].includes(column.type)) {
      values.forEach((value, rowIndex) => {
        if (encodingValid || column.type !== 'C') validateAndCoerceValue(column, value, resolved, diagnostics, rowIndex)
      })
    }
  }

  return {
    columns: namedColumns,
    diagnostics,
    canWrite: diagnostics.every((item) => item.severity !== 'error'),
  }
}

export function toDbfFieldDescriptors(columns: readonly DbfTargetColumn[]): DbfFieldDescriptor[] {
  return columns.map((column) => ({
    name: column.name,
    type: column.type,
    length: column.length,
    decimalPlaces: column.decimalPlaces,
    flags: column.flags ?? (column.nullable ? 0x02 : 0),
    nullable: column.nullable,
    system: column.system ?? false,
  }))
}
