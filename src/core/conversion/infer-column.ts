import Decimal from 'decimal.js'

import type { Diagnostic } from '../model/diagnostic'
import type { ColumnDataType } from '../model/table'
import { resolveInferenceOptions } from './options'
import type { TableInferenceOptions } from './options'

export interface ColumnInferenceStats {
  /** Total input rows, including rows outside the sample. */
  totalRows: number
  /** Rows actually inspected. */
  sampledRows: number
  /** Null and empty-string rows, irrespective of emptyStringIsNull. */
  emptyRows: number
  distinctValues?: number
  nullRows?: number
  emptyStringRows?: number
  observedRows?: number
  typeCounts?: Readonly<Partial<Record<ColumnDataType, number>>>
}

export interface ColumnInference {
  dataType: ColumnDataType
  confidence: 'high' | 'medium' | 'low'
  stats: ColumnInferenceStats
  diagnostics: readonly Diagnostic[]
  /** Maximum significant decimal digits observed in numeric input. */
  maxNumericPrecision?: number
  maxIntegerDigits?: number
  maxDecimalPlaces?: number
  requiresDecimalText?: boolean
}

type ObservedType = Exclude<ColumnDataType, 'unknown' | 'empty'>

interface Observation {
  type: ObservedType
  rowIndex: number
  decimal?: Decimal
  leadingZero?: boolean
  nonEmptyString?: boolean
}

function distinctKey(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'number') return `number:${Object.is(value, -0) ? '-0' : String(value)}`
  if (typeof value === 'bigint') return `bigint:${value.toString()}`
  if (typeof value === 'string') return `string:${value}`
  if (typeof value === 'boolean') return `boolean:${String(value)}`
  if (value instanceof Uint8Array) return `binary:${Array.from(value).join(',')}`
  return `other:${String(value)}`
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
    return leap ? 29 : 28
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31
}

/** Strict calendar validation; ambiguous/local date formats are never guessed. */
export function isValidDateOnly(value: string, formats: readonly string[] = ['YYYY-MM-DD', 'YYYY/MM/DD']): boolean {
  for (const format of formats) {
    const separator = format === 'YYYY-MM-DD' ? '-' : format === 'YYYY/MM/DD' ? '/' : undefined
    if (!separator) continue
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/u) ?? value.match(/^(\d{4})\/(\d{2})\/(\d{2})$/u)
    if (!match) continue
    if ((separator === '-' && !value.includes('-')) || (separator === '/' && !value.includes('/'))) continue
    const year = Number(match[1])
    const month = Number(match[2])
    const day = Number(match[3])
    if (month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month)) return true
  }
  return false
}

export function hasPreservableLeadingZero(value: string): boolean {
  const trimmed = value.trim()
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u.test(trimmed)) return false
  const mantissa = trimmed.replace(/^[+-]/u, '').split(/[eE]/u, 1)[0]
  const integerPart = mantissa.split('.', 1)[0]
  return integerPart.length > 1 && integerPart.startsWith('0')
}

function numericObservation(value: string | number | bigint, rowIndex: number): Observation | undefined {
  let decimal: Decimal
  try {
    decimal = new Decimal(value.toString().trim())
  } catch {
    return undefined
  }
  if (!decimal.isFinite()) return undefined

  if (typeof value === 'bigint') return { type: 'integer', rowIndex, decimal }
  if (typeof value === 'number') {
    return { type: Number.isInteger(value) ? 'integer' : 'float', rowIndex, decimal }
  }

  const trimmed = value.trim()
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u.test(trimmed)) return undefined
  const type: ObservedType = /^[+-]?\d+$/u.test(trimmed) ? 'integer' : 'decimal'
  return { type, rowIndex, decimal, leadingZero: hasPreservableLeadingZero(trimmed), nonEmptyString: true }
}

function observe(value: unknown, rowIndex: number, options: TableInferenceOptions): Observation {
  if (typeof value === 'boolean') return { type: 'boolean', rowIndex }
  if (value instanceof Uint8Array) return { type: 'binary', rowIndex }

  if (typeof value === 'string') {
    const trimmed = value.trim()
    const normalized = trimmed.toLowerCase()
    if (
      options.trueValues.some((candidate) => candidate.trim().toLowerCase() === normalized) ||
      options.falseValues.some((candidate) => candidate.trim().toLowerCase() === normalized)
    ) {
      return { type: 'boolean', rowIndex, nonEmptyString: true }
    }
    if (isValidDateOnly(trimmed, options.dateFormats)) {
      return { type: 'date', rowIndex, nonEmptyString: true }
    }
    return numericObservation(trimmed, rowIndex) ?? { type: 'string', rowIndex, nonEmptyString: trimmed.length > 0 }
  }

  if (typeof value === 'number' || typeof value === 'bigint') {
    return numericObservation(value, rowIndex) ?? { type: 'string', rowIndex, nonEmptyString: true }
  }
  return { type: 'string', rowIndex, nonEmptyString: true }
}

function numericResult(observations: readonly Observation[]): ObservedType | undefined {
  const types = new Set(observations.map((observation) => observation.type))
  const numericTypes = new Set<ObservedType>(['integer', 'decimal', 'float'])
  if (![...types].every((type) => numericTypes.has(type))) return undefined
  if (types.has('float')) return 'float'
  if (types.has('decimal')) return 'decimal'
  return 'integer'
}

function decimalPlaces(decimal: Decimal): number {
  return Math.max(0, decimal.decimalPlaces())
}

function integerDigits(decimal: Decimal): number {
  return decimal.isZero() ? 1 : Math.max(1, decimal.e + 1)
}

/**
 * Infer one column without changing its values. Numeric text is parsed with
 * Decimal.js only for classification/statistics and is never returned as Number.
 */
export function inferColumn(
  values: readonly unknown[],
  options: Partial<TableInferenceOptions> = {},
): ColumnInference {
  const resolved = resolveInferenceOptions(options)
  const sampledRows = resolved.mode === 'full' ? values.length : Math.min(values.length, resolved.sampleSize)
  const diagnostics: Diagnostic[] = []
  const observations: Observation[] = []
  const distinct = new Set<string>()
  const typeCounts: Partial<Record<ColumnDataType, number>> = {}
  let nullRows = 0
  let emptyStringRows = 0
  let maxNumericPrecision = 0
  let maxIntegerDigits = 0
  let maxDecimalPlaces = 0
  let requiresDecimalText = false
  let leadingZeroRows = 0

  for (let rowIndex = 0; rowIndex < sampledRows; rowIndex += 1) {
    const value = values[rowIndex]
    distinct.add(distinctKey(value))
    if (value === null || value === undefined) {
      nullRows += 1
      continue
    }
    if (value === '' && resolved.emptyStringIsNull) {
      emptyStringRows += 1
      continue
    }
    if (value === '') emptyStringRows += 1

    const observation = observe(value, rowIndex, resolved)
    observations.push(observation)
    typeCounts[observation.type] = (typeCounts[observation.type] ?? 0) + 1
    if (observation.leadingZero) leadingZeroRows += 1
    if (observation.decimal) {
      const precision = observation.decimal.precision()
      maxNumericPrecision = Math.max(maxNumericPrecision, precision)
      maxIntegerDigits = Math.max(maxIntegerDigits, integerDigits(observation.decimal))
      maxDecimalPlaces = Math.max(maxDecimalPlaces, decimalPlaces(observation.decimal))
      requiresDecimalText ||= precision > 15 ||
        (observation.decimal.isInteger() && observation.decimal.abs().gt(Number.MAX_SAFE_INTEGER))
    }
    if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) {
      requiresDecimalText = true
      diagnostics.push({
        code: 'INFERENCE_UNSAFE_NUMBER',
        severity: 'warning',
        message: 'An integer Number is outside JavaScript safe precision; use decimal text for lossless conversion',
        location: { rowIndex },
      })
    }
    if (typeof value === 'bigint' && (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER))) {
      requiresDecimalText = true
    }
  }

  const emptyRows = nullRows + emptyStringRows
  const stats: ColumnInferenceStats = {
    totalRows: values.length,
    sampledRows,
    emptyRows,
    distinctValues: distinct.size,
    nullRows,
    emptyStringRows,
    observedRows: observations.length,
    typeCounts,
  }
  const base = {
    stats,
    maxNumericPrecision: maxNumericPrecision || undefined,
    maxIntegerDigits: maxIntegerDigits || undefined,
    maxDecimalPlaces: maxDecimalPlaces || undefined,
    requiresDecimalText,
  }

  if (observations.length === 0) {
    return { dataType: 'empty', confidence: 'low', diagnostics, ...base }
  }

  if (resolved.mode === 'sample' && sampledRows < values.length) {
    diagnostics.push({
      code: 'INFERENCE_SAMPLE_LIMIT',
      severity: 'info',
      message: `Type inference inspected ${sampledRows} of ${values.length} rows`,
      details: { sampledRows, totalRows: values.length },
    })
  }

  const observedTypes = [...new Set(observations.map((observation) => observation.type))]
  const numeric = numericResult(observations)
  const leadingZerosPreserveText = resolved.preserveLeadingZeros && leadingZeroRows > 0 && numeric !== undefined
  if (leadingZeroRows > 0 && resolved.preserveLeadingZeros) {
    diagnostics.push({
      code: 'INFERENCE_LEADING_ZEROS',
      severity: 'info',
      message: 'Leading-zero numeric text is preserved as TEXT',
      details: { rows: leadingZeroRows },
    })
  }

  if (leadingZerosPreserveText) {
    return {
      dataType: 'string',
      confidence: sampledRows < values.length ? 'medium' : 'high',
      diagnostics,
      ...base,
    }
  }

  if (numeric) {
    if (observedTypes.length > 1) {
      diagnostics.push({
        code: 'INFERENCE_NUMERIC_WIDENING',
        severity: 'info',
        message: `Compatible numeric types were widened to ${numeric}`,
        details: { sourceTypes: observedTypes },
      })
    }
    return {
      dataType: numeric,
      confidence: sampledRows < values.length || observedTypes.length > 1 ? 'medium' : 'high',
      diagnostics,
      ...base,
    }
  }

  if (observedTypes.length === 1) {
    const onlyType = observedTypes[0]
    const onlyEmptyStrings = onlyType === 'string' && observations.every((observation) => !observation.nonEmptyString)
    return {
      dataType: onlyType,
      confidence: onlyEmptyStrings || sampledRows < values.length ? 'medium' : 'high',
      diagnostics,
      ...base,
    }
  }

  diagnostics.push({
    code: 'INFERENCE_MIXED_TYPES',
    severity: 'warning',
    message: `Mixed incompatible types (${observedTypes.join(', ')}) fall back to TEXT`,
    details: { sourceTypes: observedTypes, typeCounts },
    location: { rowIndex: observations.find((observation) => observation.type !== observations[0].type)?.rowIndex },
  })
  return { dataType: 'string', confidence: 'low', diagnostics, ...base }
}
