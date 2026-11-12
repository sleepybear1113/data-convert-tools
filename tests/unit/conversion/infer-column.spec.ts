import { describe, expect, it } from 'vitest'

import { hasPreservableLeadingZero, inferColumn, isValidDateOnly } from '../../../src/core/conversion/infer-column'
import { DEFAULT_INFERENCE_OPTIONS, inferTable } from '../../../src/core/conversion/infer-table'
import type { TableRow, TableSchema } from '../../../src/core/model/table'

describe('column inference - leading zeros, nulls, mixed types and dates', () => {
  it('samples 1000 rows by default and supports a loss-aware full scan', () => {
    const values = [...Array.from({ length: 1000 }, () => '1'), 'not numeric']
    const sampled = inferColumn(values)
    expect(sampled.dataType).toBe('integer')
    expect(sampled.confidence).toBe('medium')
    expect(sampled.stats).toMatchObject({ totalRows: 1001, sampledRows: 1000, distinctValues: 1 })
    expect(sampled.diagnostics.some((item) => item.code === 'INFERENCE_SAMPLE_LIMIT')).toBe(true)

    const full = inferColumn(values, { mode: 'full' })
    expect(full.dataType).toBe('string')
    expect(full.confidence).toBe('low')
    expect(full.stats.sampledRows).toBe(1001)
    expect(full.diagnostics.some((item) => item.code === 'INFERENCE_MIXED_TYPES')).toBe(true)
    expect(DEFAULT_INFERENCE_OPTIONS.sampleSize).toBe(1000)
  })

  it('preserves leading-zero numeric text, including signed and decimal identifiers', () => {
    const inferred = inferColumn(['0001', '-0012', '00.50'])
    expect(inferred.dataType).toBe('string')
    expect(inferred.confidence).toBe('high')
    expect(inferred.diagnostics).toContainEqual(expect.objectContaining({ code: 'INFERENCE_LEADING_ZEROS' }))
    expect(hasPreservableLeadingZero('0.50')).toBe(false)
    expect(hasPreservableLeadingZero('.50')).toBe(false)
    expect(inferColumn(['0.50', '1.25']).dataType).toBe('decimal')
  })

  it('does not treat empty strings as NULL unless explicitly configured', () => {
    const inferred = inferColumn(['1', '', null])
    expect(inferred.dataType).toBe('string')
    expect(inferred.confidence).toBe('low')
    expect(inferred.stats).toMatchObject({
      totalRows: 3,
      emptyRows: 2,
      nullRows: 1,
      emptyStringRows: 1,
      observedRows: 2,
    })
    expect(inferred.diagnostics.some((item) => item.code === 'INFERENCE_MIXED_TYPES')).toBe(true)

    const nullEmpty = inferColumn(['1', '', null], { emptyStringIsNull: true })
    expect(nullEmpty.dataType).toBe('integer')
    expect(nullEmpty.stats.observedRows).toBe(1)
    expect(inferColumn(['', null]).dataType).toBe('string')
    expect(inferColumn([null, null]).dataType).toBe('empty')
  })

  it('uses configurable, case-insensitive boolean tokens without guessing 0/1', () => {
    expect(inferColumn(['TRUE', ' yes ', 'Y', 'false', 'No', 'n']).dataType).toBe('boolean')
    expect(inferColumn(['on', 'OFF'], {
      trueValues: ['on'],
      falseValues: ['off'],
    }).dataType).toBe('boolean')
    expect(inferColumn(['0', '1']).dataType).toBe('integer')
    expect(inferColumn(['true', '1']).dataType).toBe('string')
  })

  it('accepts only strict ISO/slashed calendar dates by default', () => {
    expect(inferColumn(['2024-02-29', '2024/02/29']).dataType).toBe('date')
    expect(isValidDateOnly('2023-02-29')).toBe(false)
    expect(isValidDateOnly('2024-13-01')).toBe(false)
    expect(isValidDateOnly('2024-1-01')).toBe(false)
    expect(inferColumn(['2024-02-29', '02/29/2024']).dataType).toBe('string')
    expect(inferColumn(['2024-02-29', 'not a date']).confidence).toBe('low')
    expect(inferColumn(['2024/01/01'], { dateFormats: ['YYYY-MM-DD'] }).dataType).toBe('string')
  })

  it('widens compatible numeric types and records decimal precision statistics', () => {
    const decimal = inferColumn(['1', '2.25', '3e2'])
    expect(decimal.dataType).toBe('decimal')
    expect(decimal.confidence).toBe('medium')
    expect(decimal.maxDecimalPlaces).toBe(2)
    expect(decimal.diagnostics).toContainEqual(expect.objectContaining({ code: 'INFERENCE_NUMERIC_WIDENING' }))

    const exact = inferColumn(['99999999999999999999', '1.234567890123456789'])
    expect(exact.dataType).toBe('decimal')
    expect(exact.requiresDecimalText).toBe(true)
    expect(exact.maxNumericPrecision).toBeGreaterThan(15)
    expect(inferColumn([1, 2.5]).dataType).toBe('float')
    expect(inferColumn([1, 9007199254740992]).requiresDecimalText).toBe(true)
  })

  it('handles very large exponents without expanding them into giant strings', () => {
    const result = inferColumn(['1e1000000'])
    expect(result.dataType).toBe('decimal')
    expect(result.maxIntegerDigits).toBe(1000001)
    expect(result.requiresDecimalText).toBe(true)
  })

  it('never classifies unsafe numeric values as integer', () => {
    // 1e31 无小数部分，但远超安全整数范围：必须判为 float 而不是 integer。
    expect(inferColumn([1e31]).dataType).toBe('float')
    // 2^53 之上的整数数值不再保证精确：按 float 处理。
    expect(inferColumn([1e16]).dataType).toBe('float')
    // 安全范围内的整数仍为 integer。
    expect(inferColumn([1e15]).dataType).toBe('integer')
    expect(inferColumn([42]).dataType).toBe('integer')
    // 字符串形式的科学计数法保持 decimal（TEXT 存储、精度无损）。
    expect(inferColumn(['1e31']).dataType).toBe('decimal')
  })

  it('falls back to TEXT with a locatable warning for incompatible mixed values', () => {
    const result = inferColumn(['2024-01-01', '2024-01-02', 42])
    expect(result.dataType).toBe('string')
    expect(result.confidence).toBe('low')
    const warning = result.diagnostics.find((item) => item.code === 'INFERENCE_MIXED_TYPES')
    expect(warning?.severity).toBe('warning')
    expect(warning?.location?.rowIndex).toBe(2)
    expect(result.stats.typeCounts).toMatchObject({ date: 2, integer: 1 })
  })
})

describe('table inference', () => {
  it('validates options even for a zero-column table', () => {
    expect(() => inferTable({ id: 'empty', name: 'empty', columns: [] }, [], { sampleSize: 0 })).toThrow(/正整数/u)
  })

  it('preserves model metadata and annotates column-level diagnostics and nullability', () => {
    const schema: TableSchema = {
      id: 'source',
      name: 'source',
      columns: [
        { id: 'id', name: 'id', dataType: 'unknown', nullable: false, source: { name: 'id', type: 'csv' } },
        { id: 'mixed', name: 'mixed', dataType: 'unknown', nullable: false },
      ],
    }
    const rows: readonly TableRow[] = [['001', '2024-01-01'], [null, 2]]
    const result = inferTable(schema, rows, { mode: 'full' })

    expect(result.schema.columns[0]).toMatchObject({ id: 'id', dataType: 'string', nullable: true })
    expect(result.schema.columns[0].source).toEqual(schema.columns[0].source)
    expect(result.schema.columns[1].dataType).toBe('string')
    expect(result.columns[1].diagnostics[0].location).toMatchObject({ columnIndex: 1, columnName: 'mixed' })
  })
})
