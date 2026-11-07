import { describe, expect, it } from 'vitest'

import { simpleSelectSourceTable } from '../../../src/core/utils/sql-select'

describe('simpleSelectSourceTable', () => {
  it('accepts plain single-table reads with an optional LIMIT', () => {
    expect(simpleSelectSourceTable('SELECT * FROM people')).toBe('people')
    expect(simpleSelectSourceTable('SELECT * FROM people LIMIT 500;')).toBe('people')
    expect(simpleSelectSourceTable('select id, name from "people"')).toBe('people')
    expect(simpleSelectSourceTable('SELECT id, name AS 姓名 FROM people LIMIT 2000')).toBe('people')
    expect(simpleSelectSourceTable('SELECT a.id, a.* FROM people a LIMIT 10')).toBe('people')
    expect(simpleSelectSourceTable('SELECT * FROM people AS p LIMIT 5')).toBe('people')
  })

  it('rejects filtering, sorting, aggregation and multi-table reads', () => {
    expect(simpleSelectSourceTable('SELECT * FROM people WHERE id = 1')).toBeNull()
    expect(simpleSelectSourceTable('SELECT * FROM people ORDER BY id')).toBeNull()
    expect(simpleSelectSourceTable('SELECT * FROM people GROUP BY name')).toBeNull()
    expect(simpleSelectSourceTable('SELECT COUNT(*) FROM people')).toBeNull()
    expect(simpleSelectSourceTable('SELECT DISTINCT name FROM people')).toBeNull()
    expect(simpleSelectSourceTable('SELECT * FROM a JOIN b ON a.id = b.id')).toBeNull()
    expect(simpleSelectSourceTable('SELECT * FROM a, b')).toBeNull()
    expect(simpleSelectSourceTable('SELECT * FROM (SELECT * FROM people)')).toBeNull()
    expect(simpleSelectSourceTable('WITH x AS (SELECT 1) SELECT * FROM x')).toBeNull()
    expect(simpleSelectSourceTable('SELECT * FROM people LIMIT 5 OFFSET 2')).toBeNull()
    expect(simpleSelectSourceTable("SELECT * FROM people WHERE name = 'x'")).toBeNull()
    expect(simpleSelectSourceTable('UPDATE people SET id = 1')).toBeNull()
    expect(simpleSelectSourceTable('SELECT 1')).toBeNull()
    expect(simpleSelectSourceTable('')).toBeNull()
  })
})
