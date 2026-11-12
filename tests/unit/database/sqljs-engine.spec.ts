import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createNodeSqlJsEngine } from '../../../src/core/database/sqljs-node'
import {
  SqlJsExecutionError,
  type SqlJsEngine,
} from '../../../src/core/database/sqljs-engine'

describe('SqlJsEngine', () => {
  let engine: SqlJsEngine

  beforeEach(async () => {
    engine = createNodeSqlJsEngine()
    await engine.open()
  })

  afterEach(async () => {
    await engine.close()
  })

  it('executes multiple statements and reads bounded result pages', async () => {
    const execution = await engine.execute(`
      CREATE TABLE numbers (value INTEGER, label TEXT);
      WITH RECURSIVE seq(n) AS (
        SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 125
      )
      INSERT INTO numbers
      SELECT n, printf('row-%03d', n) FROM seq;
      SELECT value, label FROM numbers ORDER BY value;
    `)

    expect(execution.diagnostics).toEqual([])
    expect(execution.durationMs).toBeGreaterThanOrEqual(0)
    expect(execution.statements).toHaveLength(3)
    expect(execution.statements[0]).toEqual({ columns: [], rowsAffected: 0 })
    expect(execution.statements[1]).toEqual({ columns: [], rowsAffected: 125 })

    const query = execution.statements[2]
    expect(query.columns).toEqual(['value', 'label'])
    expect(query.totalRows).toBe(125)
    expect(query.resultId).toBeTypeOf('string')

    const firstPage = await engine.getResultPage({
      resultId: query.resultId!,
      offset: 0,
      limit: 20,
    })
    expect(firstPage.rows).toHaveLength(20)
    expect(firstPage.rows[0]).toEqual([1, 'row-001'])
    expect(firstPage.rows[19]).toEqual([20, 'row-020'])
    expect(firstPage.totalRows).toBe(125)

    const lastPage = await engine.getResultPage({
      resultId: query.resultId!,
      offset: 120,
      limit: 20,
    })
    expect(lastPage.rows).toEqual([
      [121, 'row-121'],
      [122, 'row-122'],
      [123, 'row-123'],
      [124, 'row-124'],
      [125, 'row-125'],
    ])

    const beyondEnd = await engine.getResultPage({
      resultId: query.resultId!,
      offset: 500,
      limit: 20,
    })
    expect(beyondEnd.rows).toEqual([])
    expect(beyondEnd.totalRows).toBe(125)
  })

  it('retains empty query columns, duplicate names, and RETURNING counts', async () => {
    const execution = await engine.execute(`
      CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT);
      INSERT INTO items(name) VALUES ('one'), ('two') RETURNING id, name;
      SELECT id AS same, name AS same FROM items WHERE 0;
    `)

    const returning = execution.statements[1]
    expect(returning.totalRows).toBe(2)
    expect(returning.rowsAffected).toBe(2)
    const returnedRows = await engine.getResultPage({
      resultId: returning.resultId!,
      offset: 0,
      limit: 10,
    })
    expect(returnedRows.rows).toEqual([[1, 'one'], [2, 'two']])

    const empty = execution.statements[2]
    expect(empty.totalRows).toBe(0)
    expect(empty.columns).toEqual(['same', 'same'])
    const emptyPage = await engine.getResultPage({
      resultId: empty.resultId!,
      offset: 0,
      limit: 10,
    })
    expect(emptyPage.rows).toEqual([])
    expect(emptyPage.columns).toEqual(['same', 'same'])
  })

  it('supports committed and rolled-back transactions', async () => {
    await engine.execute('CREATE TABLE events (name TEXT)')
    const execution = await engine.execute(`
      BEGIN;
      INSERT INTO events VALUES ('committed');
      COMMIT;
      BEGIN;
      INSERT INTO events VALUES ('rolled back');
      ROLLBACK;
      SELECT name FROM events;
    `)

    const query = execution.statements.at(-1)!
    const page = await engine.getResultPage({
      resultId: query.resultId!,
      offset: 0,
      limit: 10,
    })
    expect(page.rows).toEqual([['committed']])
  })

  it('preserves 64-bit integers, safe numbers, NULL, and BLOB values', async () => {
    const execution = await engine.execute(`
      SELECT
        9007199254740993 AS too_large,
        -9007199254740993 AS too_small,
        42 AS safe_integer,
        x'0001ff' AS payload,
        NULL AS missing;
    `)
    const page = await engine.getResultPage({
      resultId: execution.statements[0]!.resultId!,
      offset: 0,
      limit: 1,
    })

    expect(page.rows).toHaveLength(1)
    const row = page.rows[0]!
    expect(row[0]).toBe(9007199254740993n)
    expect(row[1]).toBe(-9007199254740993n)
    expect(row[2]).toBe(42)
    expect(row[3]).toBeInstanceOf(Uint8Array)
    expect(Array.from(row[3] as Uint8Array)).toEqual([0, 1, 255])
    expect(row[4]).toBeNull()
  })

  it('reports tables, views, and PRAGMA column metadata while hiding internals', async () => {
    await engine.execute(`
      CREATE TABLE "odd""table" (
        id INTEGER PRIMARY KEY,
        name VARCHAR(40) NOT NULL,
        score REAL
      );
      CREATE TABLE __dct_private (value TEXT);
      CREATE VIEW visible_view AS SELECT id, name FROM "odd""table";
    `)

    const schema = await engine.getSchema()
    expect(schema.tables.map((table) => table.name)).toEqual([
      'odd"table',
      'visible_view',
    ])
    expect(schema.tables[0]?.columns).toEqual([
      { name: 'id', declaredType: 'INTEGER', nullable: true, primaryKey: true },
      { name: 'name', declaredType: 'VARCHAR(40)', nullable: false, primaryKey: false },
      { name: 'score', declaredType: 'REAL', nullable: true, primaryKey: false },
    ])
    expect(schema.tables[1]?.columns.map((column) => column.name)).toEqual(['id', 'name'])
  })

  it('exports a real SQLite file without internal result tables', async () => {
    const execution = await engine.execute(`
      CREATE TABLE saved (id INTEGER, payload BLOB);
      INSERT INTO saved VALUES (7, x'0102');
      SELECT * FROM saved;
    `)
    expect(execution.statements[2]?.resultId).toBeDefined()

    const bytes = await engine.exportDatabase()
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(Array.from(bytes.subarray(0, 16))).toEqual(Array.from(
      new TextEncoder().encode('SQLite format 3\0'),
    ))

    const reopened = createNodeSqlJsEngine()
    try {
      await reopened.open(bytes)
      const schema = await reopened.getSchema()
      expect(schema.tables.map((table) => table.name)).toEqual(['saved'])
      const query = await reopened.execute('SELECT * FROM saved')
      const page = await reopened.getResultPage({
        resultId: query.statements[0]!.resultId!,
        offset: 0,
        limit: 10,
      })
      expect(page.rows[0]?.[0]).toBe(7)
      expect(Array.from(page.rows[0]?.[1] as Uint8Array)).toEqual([1, 2])
    } finally {
      await reopened.close()
    }
  })

  it('attaches statement details and diagnostics to SQL failures', async () => {
    let failure: unknown
    try {
      await engine.execute(`
        CREATE TABLE partial (id INTEGER);
        INSERT INTO partial VALUES (1);
        SELECT * FROM table_that_does_not_exist;
      `)
    } catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(SqlJsExecutionError)
    const error = failure as SqlJsExecutionError
    expect(error.message).toContain('SQLite 语句 3 执行失败')
    expect(error.message).toContain('table_that_does_not_exist')
    expect(error.statementIndex).toBe(2)
    expect(error.result.statements).toHaveLength(2)
    expect(error.result.durationMs).toBeGreaterThanOrEqual(0)
    expect(error.diagnostics).toHaveLength(1)
    expect(error.diagnostics[0]).toMatchObject({
      code: 'SQLITE_STATEMENT_ERROR',
      severity: 'error',
      details: { statementIndex: 2 },
    })
  })

  it('releases results, validates pages, and can reopen after close', async () => {
    const execution = await engine.execute('SELECT 1 AS value')
    const resultId = execution.statements[0]!.resultId!

    await expect(engine.getResultPage({ resultId, offset: -1, limit: 10 }))
      .rejects.toThrow('offset')
    await expect(engine.getResultPage({ resultId, offset: 0, limit: 1.5 }))
      .rejects.toThrow('limit')

    await engine.releaseResult(resultId)
    await expect(engine.releaseResult(resultId)).resolves.toBeUndefined()
    await expect(engine.getResultPage({ resultId, offset: 0, limit: 10 }))
      .rejects.toThrow('Unknown or released')

    await engine.close()
    await expect(engine.execute('SELECT 1')).rejects.toThrow('not open')
    await engine.open()
    const reopened = await engine.execute('SELECT 2 AS value')
    const page = await engine.getResultPage({
      resultId: reopened.statements[0]!.resultId!,
      offset: 0,
      limit: 10,
    })
    expect(page.rows).toEqual([[2]])
  })
})
