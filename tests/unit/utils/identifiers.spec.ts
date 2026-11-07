import { describe, expect, it } from 'vitest'

import { baseTableNameFromFile, quoteSqliteIdentifier, quoteSqliteString, uniqueName } from '../../../src/core/utils/identifiers'

describe('quoteSqliteIdentifier', () => {
  it('escapes embedded double quotes', () => {
    expect(quoteSqliteIdentifier('a"b')).toBe('"a""b"')
  })
})

describe('quoteSqliteString', () => {
  it('escapes single quotes', () => {
    expect(quoteSqliteString("a'b")).toBe("'a''b'")
  })
})

describe('uniqueName', () => {
  it('adds stable numeric suffixes', () => {
    expect(uniqueName('name', new Set(['name', 'name_2']))).toBe('name_3')
  })

  it('supports starting suffixes at 1 for table names', () => {
    expect(uniqueName('people', new Set(['people']), { startSuffix: 1 })).toBe('people_1')
    expect(uniqueName('people', new Set(['people', 'people_1']), { startSuffix: 1 })).toBe('people_2')
  })

  it('compares case-insensitively when requested', () => {
    // 约定：caseInsensitive 模式下传入的集合需已按小写归一化（见表名调用方）。
    expect(uniqueName('People', new Set(['people']), { startSuffix: 1, caseInsensitive: true })).toBe('People_1')
    expect(uniqueName('People', new Set(['people']), { startSuffix: 1 })).toBe('People')
  })
})

describe('baseTableNameFromFile', () => {
  it('strips the extension and keeps unicode names', () => {
    expect(baseTableNameFromFile('people.csv')).toBe('people')
    expect(baseTableNameFromFile('2024年销售明细.xlsx')).toBe('2024年销售明细')
    expect(baseTableNameFromFile('archive.tar.gz')).toBe('archive.tar')
  })

  it('replaces filesystem-reserved characters and falls back when empty', () => {
    expect(baseTableNameFromFile('a/b<c>.csv')).toBe('a_b_c_')
    expect(baseTableNameFromFile('.csv')).toBe('imported_data')
    expect(baseTableNameFromFile('   ')).toBe('imported_data')
  })
})
