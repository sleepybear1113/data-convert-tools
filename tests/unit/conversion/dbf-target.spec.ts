import { describe, expect, it } from 'vitest'

import { inferDbfTargetSchema, toDbfFieldDescriptors } from '../../../src/core/conversion/dbf-target'
import type { ColumnDataType, TableRow, TableSchema } from '../../../src/core/model/table'

interface TestColumn {
  name: string
  dataType: ColumnDataType
  dbfType?: 'C' | 'N' | 'F' | 'Y' | 'D' | 'L' | 'I' | 'T' | 'B'
  size?: number
  decimalPlaces?: number
  nullable?: boolean
}

function schema(columns: readonly TestColumn[]): TableSchema {
  return {
    id: 'source',
    name: 'source',
    columns: columns.map((column, index) => ({
      id: `c${index}`,
      name: column.name,
      dataType: column.dataType,
      nullable: column.nullable ?? true,
      source: column.dbfType ? {
        name: column.name,
        type: column.dbfType,
        size: column.size,
        decimalPlaces: column.decimalPlaces,
      } : undefined,
    })),
  }
}

describe('DBF target schema inference', () => {
  it('preserves all supported source DBF types and dimensions', () => {
    const source = schema([
      { name: 'C', dataType: 'string', dbfType: 'C', size: 12 },
      { name: 'N', dataType: 'decimal', dbfType: 'N', size: 10, decimalPlaces: 2 },
      { name: 'F', dataType: 'float', dbfType: 'F', size: 8, decimalPlaces: 1 },
      { name: 'Y', dataType: 'decimal', dbfType: 'Y', size: 8, decimalPlaces: 4 },
      { name: 'D', dataType: 'date', dbfType: 'D', size: 8 },
      { name: 'L', dataType: 'boolean', dbfType: 'L', size: 1 },
      { name: 'I', dataType: 'integer', dbfType: 'I', size: 4 },
      { name: 'T', dataType: 'datetime', dbfType: 'T', size: 8 },
      { name: 'B', dataType: 'float', dbfType: 'B', size: 8 },
    ])
    const rows: readonly TableRow[] = [[
      'abc', '123.45', 1.5, '12.3456', '2024-02-29', true, 42,
      '2024-02-29 12:34:56.123', 1.25,
    ]]
    const target = inferDbfTargetSchema(source, rows)

    expect(target.canWrite).toBe(true)
    expect(target.columns.map((column) => column.type)).toEqual(['C', 'N', 'F', 'Y', 'D', 'L', 'I', 'T', 'B'])
    expect(target.columns.map((column) => column.length)).toEqual([12, 10, 8, 8, 8, 1, 4, 8, 8])
    expect(target.columns.map((column) => column.decimalPlaces)).toEqual([0, 2, 1, 4, 0, 0, 0, 0, 0])
    expect(toDbfFieldDescriptors(target.columns)[0]).toMatchObject({ name: 'C', type: 'C', flags: 2, system: false })
  })

  it('infers useful types and numeric dimensions from values', () => {
    const small = inferDbfTargetSchema(schema([{ name: 'n', dataType: 'integer' }]), [[-123], [456]])
    expect(small.columns[0]).toMatchObject({ type: 'I', length: 4, decimalPlaces: 0 })
    expect(small.canWrite).toBe(true)

    const large = inferDbfTargetSchema(schema([{ name: 'n', dataType: 'integer' }]), [[2147483648]])
    expect(large.columns[0]).toMatchObject({ type: 'N', length: 10, decimalPlaces: 0 })
    expect(large.canWrite).toBe(true)

    const decimal = inferDbfTargetSchema(schema([{ name: 'n', dataType: 'decimal' }]), [['-12.30'], ['1.2']])
    expect(decimal.columns[0]).toMatchObject({ type: 'N', length: 6, decimalPlaces: 2 })
    expect(decimal.canWrite).toBe(true)

    const others = inferDbfTargetSchema(schema([
      { name: 'f', dataType: 'float' },
      { name: 'l', dataType: 'boolean' },
      { name: 'd', dataType: 'date' },
      { name: 't', dataType: 'datetime' },
    ]), [[1.25, 'yes', '2024/02/29', '2024-02-29T01:02:03']])
    expect(others.columns.map((column) => column.type)).toEqual(['F', 'L', 'D', 'T'])
    expect(others.canWrite).toBe(true)
  })

  it('validates character byte width and encoding instead of JavaScript string length', () => {
    const source = schema([{ name: 'c', dataType: 'string', dbfType: 'C', size: 2 }])
    expect(inferDbfTargetSchema(source, [['中']]).canWrite).toBe(true)

    const overflow = inferDbfTargetSchema(source, [['中中']])
    expect(overflow.canWrite).toBe(false)
    expect(overflow.diagnostics).toContainEqual(expect.objectContaining({ code: 'DBF_TEXT_OVERFLOW', location: expect.objectContaining({ rowIndex: 0, columnIndex: 0 }) }))

    const encoding = inferDbfTargetSchema(source, [['😀']])
    expect(encoding.canWrite).toBe(false)
    expect(encoding.diagnostics).toContainEqual(expect.objectContaining({ code: 'DBF_ENCODING_ERROR' }))
  })

  it('strictly rejects numeric overflow, precision loss and invalid logical/calendar values', () => {
    const numeric = inferDbfTargetSchema(schema([
      { name: 'n', dataType: 'decimal', dbfType: 'N', size: 4, decimalPlaces: 2 },
      { name: 'i', dataType: 'integer', dbfType: 'I', size: 4 },
      { name: 'y', dataType: 'decimal', dbfType: 'Y', size: 8, decimalPlaces: 4 },
    ]), [['123.45', 2147483648, '1.23456']])
    expect(numeric.canWrite).toBe(false)
    expect(numeric.diagnostics.map((item) => item.code)).toEqual(expect.arrayContaining([
      'DBF_NUMERIC_OVERFLOW', 'DBF_INTEGER_OVERFLOW', 'DBF_DECIMAL_OVERFLOW',
    ]))

    const values = inferDbfTargetSchema(schema([
      { name: 'd', dataType: 'date', dbfType: 'D', size: 8 },
      { name: 't', dataType: 'datetime', dbfType: 'T', size: 8 },
      { name: 'l', dataType: 'boolean', dbfType: 'L', size: 1 },
    ]), [['2023-02-29', '2024-01-01T00:00:00Z', 'maybe']])
    expect(values.canWrite).toBe(false)
    expect(values.diagnostics.map((item) => item.code)).toEqual(expect.arrayContaining([
      'DBF_INVALID_DATE', 'DBF_INVALID_DATETIME', 'DBF_INVALID_BOOLEAN',
    ]))
  })

  it('renames deterministically only in explicit compatibility mode', () => {
    const source = schema([
      { name: 'duplicate', dataType: 'string' },
      { name: 'DUPLICATE', dataType: 'string' },
      { name: '', dataType: 'string' },
    ])
    const strict = inferDbfTargetSchema(source, [['a', 'b', 'c']])
    expect(strict.canWrite).toBe(false)

    const compatible = inferDbfTargetSchema(source, [['a', 'b', 'c']], {
      strict: false,
      allowRename: true,
    })
    expect(compatible.canWrite).toBe(true)
    expect(compatible.columns.map((column) => column.name)).toEqual(['duplicate', 'DUPLICAT_2', 'column'])
    expect(compatible.diagnostics.filter((item) => item.code === 'DBF_COLUMN_RENAMED')).toHaveLength(2)
  })

  it('requires explicit truncation or type widening and emits diagnostics', () => {
    const longText = inferDbfTargetSchema(schema([{ name: 'c', dataType: 'string' }]), [['x'.repeat(300)]])
    expect(longText.canWrite).toBe(false)
    expect(longText.diagnostics).toContainEqual(expect.objectContaining({ code: 'DBF_INVALID_LENGTH' }))

    const truncated = inferDbfTargetSchema(schema([{ name: 'c', dataType: 'string' }]), [['x'.repeat(300)]], {
      strict: false,
      allowTruncate: true,
    })
    expect(truncated.columns[0].length).toBe(254)
    expect(truncated.canWrite).toBe(true)
    expect(truncated.diagnostics).toContainEqual(expect.objectContaining({ code: 'DBF_TRUNCATION_REQUIRED' }))

    const wideNumber = inferDbfTargetSchema(schema([{ name: 'n', dataType: 'decimal' }]), [['123456789012345678901.23']])
    expect(wideNumber.canWrite).toBe(false)
    const widened = inferDbfTargetSchema(schema([{ name: 'n', dataType: 'decimal' }]), [['123456789012345678901.23']], {
      strict: false,
      allowTypeWidening: true,
    })
    expect(widened.columns[0]).toMatchObject({ type: 'C', length: 24 })
    expect(widened.canWrite).toBe(true)
    expect(widened.diagnostics).toContainEqual(expect.objectContaining({ code: 'DBF_TYPE_WIDENED' }))
  })

  it('widens existing field lengths only when compatibility mode allows it', () => {
    const text = inferDbfTargetSchema(schema([
      { name: 'c', dataType: 'string', dbfType: 'C', size: 1 },
    ]), [['abcd']], { strict: false, allowTypeWidening: true })
    expect(text.columns[0].length).toBe(4)
    expect(text.canWrite).toBe(true)

    const numeric = inferDbfTargetSchema(schema([
      { name: 'n', dataType: 'integer', dbfType: 'N', size: 2 },
    ]), [[12345]], { strict: false, allowTypeWidening: true })
    expect(numeric.columns[0]).toMatchObject({ type: 'N', length: 5 })
    expect(numeric.canWrite).toBe(true)
    expect(numeric.diagnostics).toContainEqual(expect.objectContaining({ code: 'DBF_FIELD_WIDENED' }))
  })

  it('rejects Double precision loss and unsupported encodings without throwing', () => {
    const double = inferDbfTargetSchema(schema([
      { name: 'b', dataType: 'float', dbfType: 'B', size: 8 },
    ]), [['1.234567890123456789']])
    expect(double.canWrite).toBe(false)
    expect(double.diagnostics).toContainEqual(expect.objectContaining({ code: 'DBF_DOUBLE_PRECISION' }))

    const encoding = inferDbfTargetSchema(schema([{ name: 'c', dataType: 'string' }]), [['abc']], {
      encoding: 'definitely-not-an-encoding',
    })
    expect(encoding.canWrite).toBe(false)
    expect(encoding.diagnostics).toContainEqual(expect.objectContaining({ code: 'DBF_UNSUPPORTED_ENCODING' }))
  })

  it('rejects unsupported binary fields, unexpected NULL and zero-column exports', () => {
    const binary = inferDbfTargetSchema(schema([{ name: 'b', dataType: 'binary' }]), [[new Uint8Array([1])]])
    expect(binary.canWrite).toBe(false)
    expect(binary.diagnostics).toContainEqual(expect.objectContaining({ code: 'DBF_UNSUPPORTED_TYPE' }))

    const nulls = inferDbfTargetSchema(schema([{ name: 's', dataType: 'string', nullable: false }]), [[null]])
    expect(nulls.diagnostics).toContainEqual(expect.objectContaining({ code: 'DBF_UNEXPECTED_NULL' }))

    const empty = inferDbfTargetSchema(schema([]))
    expect(empty.canWrite).toBe(false)
    expect(empty.diagnostics).toContainEqual(expect.objectContaining({ code: 'MAPPING_NO_COLUMNS' }))
  })
})
