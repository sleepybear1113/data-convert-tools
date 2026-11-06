import { describe, expect, it } from 'vitest'

import type { DatabaseEngine } from '../../../src/core/database/engine'
import type { QueryResultPage, ResultPageRequest } from '../../../src/core/database/query'
import type { TableRow } from '../../../src/core/model/table'
import { readSelection } from '../../../src/workers/selection'

function createEngine(rows: TableRow[]) {
  let released = false
  let executedSql = ''
  const engine = {
    execute: async (sql: string) => {
      executedSql = sql
      return {
        statements: [{ resultId: 'result-1', columns: ['id'], totalRows: rows.length }],
        durationMs: 0,
        diagnostics: [],
      }
    },
    getResultPage: async ({ resultId, offset, limit }: ResultPageRequest): Promise<QueryResultPage> => ({
      resultId,
      columns: ['id'],
      rows: rows.slice(offset, offset + limit),
      offset,
      totalRows: rows.length,
    }),
    releaseResult: async () => {
      released = true
    },
  } as unknown as DatabaseEngine

  return {
    engine,
    released: () => released,
    executedSql: () => executedSql,
  }
}

describe('readSelection', () => {
  it('pages through a materialized query and releases it', async () => {
    const rows = Array.from({ length: 2500 }, (_, id) => [id] as TableRow)
    const { engine, released } = createEngine(rows)
    const selection = await readSelection(engine, { kind: 'query', sql: 'SELECT id FROM source' })

    let count = 0
    for await (const row of selection.rows) {
      expect(row).toEqual(rows[count])
      count += 1
    }

    expect(count).toBe(2500)
    expect(selection.recordCount).toBe(2500)
    expect(released()).toBe(true)
  })

  it('reuses an existing query result without executing or releasing it', async () => {
    const { engine, executedSql, released } = createEngine([[1]])
    const selection = await readSelection(engine, {
      kind: 'query',
      sql: 'SELECT id FROM source',
      resultId: 'result-1',
    })
    for await (const row of selection.rows) void row

    expect(executedSql()).toBe('')
    expect(released()).toBe(false)
  })

  it('quotes table names', async () => {
    const { engine, executedSql } = createEngine([])
    const selection = await readSelection(engine, { kind: 'table', tableName: 'a"b' })
    for await (const row of selection.rows) void row
    expect(executedSql()).toBe('SELECT * FROM "a""b"')
  })
})
