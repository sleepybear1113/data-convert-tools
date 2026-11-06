import { describe, expect, it } from 'vitest'

import {
  ColumnMappingError,
  applyColumnMapping,
  buildColumnMapping,
  resolveColumnNames,
  validateColumnMapping,
} from '../../../src/core/conversion/mapping'
import type { TableSchema } from '../../../src/core/model/table'

function schema(names: readonly string[]): TableSchema {
  return {
    id: 'source',
    name: 'source',
    columns: names.map((name, index) => ({
      id: `source-${index}`,
      name,
      dataType: index === 0 ? 'integer' : 'string',
      nullable: false,
    })),
  }
}

describe('column mapping', () => {
  it('uses stable duplicate suffixes and handles empty and case-insensitive names', () => {
    const first = resolveColumnNames(['name', 'name', 'name_2', '', 'NAME'])
    const second = resolveColumnNames(['name', 'name', 'name_2', '', 'NAME'])
    expect(first.names).toEqual(['name', 'name_2', 'name_2_2', 'column', 'NAME_3'])
    expect(first).toEqual(second)
    expect(first.collisions.map((collision) => collision.reason)).toEqual([
      'duplicate',
      'duplicate',
      'empty',
      'duplicate',
    ])
  })

  it('keeps generated suffixes within a length limit', () => {
    expect(resolveColumnNames(['abcdef', 'abcdef'], { maxLength: 5 }).names).toEqual(['abcde', 'abc_2'])
    expect(resolveColumnNames(['a', 'a'], { maxLength: 1 }).names).toEqual(['a', '2'])
  })

  it('applies selection, ordering, renaming and type suggestions without coercing values', () => {
    const source = schema(['id', 'name', 'note'])
    const built = buildColumnMapping(source, {
      includedColumns: [2, 0],
      targetNames: { 0: 'identifier', 2: 'comment' },
      targetTypes: { 0: 'string' },
    })
    const mappings = [built.columns[2], built.columns[0], built.columns[1]]
    const result = applyColumnMapping(source, [['001', 'Alice', 'first']], mappings, 'mapped')

    expect(result.schema.name).toBe('mapped')
    expect(result.schema.columns.map((column) => column.name)).toEqual(['comment', 'identifier'])
    expect(result.schema.columns.map((column) => column.dataType)).toEqual(['string', 'string'])
    expect(result.schema.columns.map((column) => column.id)).toEqual(['source-2', 'source-0'])
    expect(result.rows).toEqual([['first', '001']])
  })

  it('validates duplicate target names, duplicate source indexes and empty selections', () => {
    const source = schema(['a', 'b'])
    const duplicate = buildColumnMapping(source, { targetNames: { 0: 'x', 1: 'X' } }).columns
    // Building resolves duplicates; a manual edit must be rejected by validation.
    const invalid = duplicate.map((column) => ({ ...column, targetName: 'x' }))
    expect(validateColumnMapping(source, invalid).valid).toBe(false)

    const duplicateSource = [invalid[0], { ...invalid[0], targetName: 'other' }]
    expect(validateColumnMapping(source, duplicateSource).diagnostics)
      .toContainEqual(expect.objectContaining({ code: 'MAPPING_DUPLICATE_SOURCE' }))

    const empty = invalid.map((column) => ({ ...column, included: false }))
    expect(() => applyColumnMapping(source, [], empty)).toThrowError(ColumnMappingError)
  })
})
