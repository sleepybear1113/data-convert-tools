import { afterEach, describe, expect, it } from 'vitest'

import { createNodeSqlJsEngine } from '../../../src/core/database/sqljs-node'
import type { SqlJsEngine } from '../../../src/core/database/sqljs-engine'
import type { TableRow, TableSchema } from '../../../src/core/model/table'
import { importTableIntoSqlite, readTableMetadata } from '../../../src/workers/sqlite-import'

const engines: SqlJsEngine[] = []

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.close()))
})

async function createEngine() {
  const engine = createNodeSqlJsEngine()
  engines.push(engine)
  await engine.open()
  return engine
}

describe('importTableIntoSqlite', () => {
  it('imports values in batches and preserves exact values and metadata', async () => {
    const engine = await createEngine()
    expect(await readTableMetadata(engine, 'my table')).toBeUndefined()
    const schema: TableSchema = {
      id: 'table-1',
      name: 'my table',
      columns: [
        { id: 'id', name: 'id', dataType: 'integer', nullable: false },
        { id: 'name', name: 'name', dataType: 'string', nullable: true },
        { id: 'amount', name: 'amount', dataType: 'decimal', nullable: true },
        { id: 'raw', name: 'raw', dataType: 'binary', nullable: true },
        { id: 'flag', name: 'flag', dataType: 'boolean', nullable: true },
      ],
      source: {
        format: 'dbf',
        fileVersion: 0x30,
        languageDriver: 0x7a,
        encoding: 'gbk',
        headerLength: 100,
        recordLength: 20,
        trailingHeader: new Uint8Array([0, 1, 255]),
      },
    }
    const expectedRows: TableRow[] = [
      [9007199254740993n, '张三', '123.4500000000000001', new Uint8Array([0, 255]), true],
      [2, null, null, null, null],
      [3, "O'Reilly", '0.1', new Uint8Array(), false],
    ]

    const count = await importTableIntoSqlite(engine, schema, {
      recordCount: expectedRows.length,
      rows: (async function* () {
        yield* expectedRows
      })(),
    }, { batchSize: 2 })

    expect(count).toBe(3)
    const execution = await engine.execute('SELECT * FROM "my table" ORDER BY rowid')
    const resultId = execution.statements[0].resultId!
    const page = await engine.getResultPage({ resultId, offset: 0, limit: 10 })

    expect(page.rows[0][0]).toBe(9007199254740993n)
    expect(page.rows[0][1]).toBe('张三')
    expect(page.rows[0][2]).toBe('123.4500000000000001')
    expect(page.rows[0][3]).toEqual(new Uint8Array([0, 255]))
    expect(page.rows[0][4]).toBe(1)
    expect(page.rows[1][1]).toBeNull()
    expect(page.rows[2][1]).toBe("O'Reilly")
    await engine.releaseResult(resultId)

    const metadata = await readTableMetadata(engine, 'my table')
    expect(metadata).toEqual(schema)
    expect((await engine.getSchema()).tables.map((table) => table.name)).toEqual(['my table'])
    expect(await readTableMetadata(engine, 'missing')).toBeUndefined()
  })
})
