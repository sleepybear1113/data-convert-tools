import { describe, expect, it } from 'vitest'

import { createSqliteTableStatement, inferSqliteTargetSchema } from '../../../src/core/conversion/sqlite-target'
import type { ColumnDataType, TableRow, TableSchema } from '../../../src/core/model/table'

function schema(entries: readonly [string, ColumnDataType, string?][]): TableSchema {
  return {
    id: 'source',
    name: 'source',
    columns: entries.map(([name, dataType, sourceType], index) => ({
      id: `c${index}`,
      name,
      dataType,
      nullable: index !== 0,
      source: sourceType ? { name, type: sourceType, size: 20, decimalPlaces: 0 } : undefined,
    })),
  }
}

describe('SQLite target schema inference', () => {
  it('maps common types and quotes generated SQLite identifiers', () => {
    const source = schema([
      ['id', 'integer'],
      ['amount', 'decimal'],
      ['ratio', 'float'],
      ['active', 'boolean'],
      ['day', 'date'],
      ['payload', 'binary'],
      ['text', 'string'],
    ])
    const target = inferSqliteTargetSchema(source, [], { tableName: 'odd"table' })
    expect(target.columns.map((column) => column.sqliteType)).toEqual([
      'INTEGER', 'NUMERIC', 'REAL', 'INTEGER', 'TEXT', 'BLOB', 'TEXT',
    ])
    expect(target.canWrite).toBe(true)
    expect(createSqliteTableStatement(target)).toBe(
      'CREATE TABLE "odd""table" ("id" INTEGER NOT NULL, "amount" NUMERIC, "ratio" REAL, "active" INTEGER, "day" TEXT, "payload" BLOB, "text" TEXT)',
    )
  })

  it('uses decimal text for unsafe integer and high-precision values', () => {
    const source = schema([
      ['id', 'integer'],
      ['big', 'integer'],
      ['exact', 'decimal'],
    ])
    const rows: readonly TableRow[] = [[1, 9007199254740993n, '1.234567890123456789']]
    const target = inferSqliteTargetSchema(source, rows)
    expect(target.columns.map((column) => column.sqliteType)).toEqual(['INTEGER', 'TEXT', 'TEXT'])
    expect(target.columns[1].decimalText).toBe(true)
    expect(target.diagnostics.map((item) => item.code)).toContain('SQLITE_INTEGER_AS_TEXT')
    expect(target.diagnostics.map((item) => item.code)).toContain('SQLITE_DECIMAL_AS_TEXT')

    const exponent = inferSqliteTargetSchema(schema([['exact', 'decimal']]), [['1e20']])
    expect(exponent.columns[0]).toMatchObject({ sqliteType: 'TEXT', decimalText: true })
  })

  it('retains DBF Y/N/F/L/D/T/B semantics and marks high-precision N/F as text', () => {
    const source = schema([
      ['currency', 'decimal', 'Y'],
      ['normal', 'decimal', 'N'],
      ['wide', 'decimal', 'F'],
      ['logic', 'boolean', 'L'],
      ['day', 'date', 'D'],
      ['stamp', 'datetime', 'T'],
      ['double', 'float', 'B'],
    ])
    source.columns[1].source!.size = 12
    source.columns[2].source!.size = 25
    const target = inferSqliteTargetSchema(source)
    expect(target.columns.map((column) => column.sqliteType)).toEqual([
      'TEXT', 'NUMERIC', 'TEXT', 'INTEGER', 'TEXT', 'TEXT', 'REAL',
    ])
    expect(target.columns[0].decimalText).toBe(true)
    expect(target.columns[2].decimalText).toBe(true)
  })

  it('honors included mappings and rejects an empty target', () => {
    const source = schema([['a', 'string'], ['b', 'integer']])
    const target = inferSqliteTargetSchema(source, [], {}, [
      { sourceIndex: 0, included: false, targetName: 'a' },
      { sourceIndex: 1, included: true, targetName: 'renamed', targetType: 'string' },
    ])
    expect(target.columns).toHaveLength(1)
    expect(target.columns[0]).toMatchObject({ name: 'renamed', sqliteType: 'TEXT', sourceIndex: 1 })

    const empty = inferSqliteTargetSchema(schema([]), [])
    expect(empty.canWrite).toBe(false)
    expect(empty.diagnostics).toContainEqual(expect.objectContaining({ code: 'MAPPING_NO_COLUMNS' }))
    expect(() => createSqliteTableStatement(empty)).toThrow()
  })
})
