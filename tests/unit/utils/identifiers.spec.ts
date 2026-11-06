import { describe, expect, it } from 'vitest'

import { quoteSqliteIdentifier, quoteSqliteString, uniqueName } from '../../../src/core/utils/identifiers'

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
})
