import { afterEach, describe, expect, it } from 'vitest'

import { createNodeSqlJsEngine } from '../../../src/core/database/sqljs-node'
import type { SqlJsEngine } from '../../../src/core/database/sqljs-engine'
import { ArrayBufferDbfReader } from '../../../src/core/dbf/reader'
import { decodeCsv } from '../../../src/core/formats/csv'
import { readXlsx } from '../../../src/core/formats/xlsx'
import { importTableIntoSqlite, saveTableMetadata } from '../../../src/workers/sqlite-import'
import type { TableSchema } from '../../../src/core/model/table'
import { exportWorkspace } from '../../../src/workers/export'

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

function exactBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

describe('workspace exporters', () => {
  it('exports CSV and XLSX from the same query result without re-executing SQL', async () => {
    const engine = await createEngine()
    await engine.execute('CREATE TABLE sample(value INTEGER, name TEXT); INSERT INTO sample VALUES (1, \'甲\')')
    const sql = 'UPDATE sample SET value = value + 1 RETURNING value, name'
    const execution = await engine.execute(sql)
    const resultId = execution.statements[0].resultId!

    const csv = await exportWorkspace(engine, createNodeSqlJsEngine, {
      format: 'csv',
      selection: { kind: 'query', sql, resultId },
      fileName: 'result',
      strict: true,
      includeMetadata: true,
      csv: { encoding: 'utf-8', bom: false },
    })
    const text = decodeCsv(csv.bytes).text
    expect(text).toContain('2')
    expect(text).not.toContain('3')
    expect(csv.fileName).toBe('result.csv')

    const xlsx = await exportWorkspace(engine, createNodeSqlJsEngine, {
      format: 'xlsx',
      selection: { kind: 'query', sql, resultId },
      fileName: 'result',
      strict: true,
      includeMetadata: true,
      xlsx: { sheetName: 'Result' },
    })
    const workbook = readXlsx(xlsx.bytes)
    expect(workbook.rows).toEqual([[2, '甲']])
    await engine.releaseResult(resultId)
  })

  it('creates a single-table SQLite file and can strip workspace metadata', async () => {
    const engine = await createEngine()
    await engine.execute('CREATE TABLE sample(id INTEGER); INSERT INTO sample VALUES (1), (2)')
    const schema: TableSchema = {
      id: 'sample',
      name: 'sample',
      columns: [{ id: 'id', name: 'id', dataType: 'integer', nullable: false }],
    }
    await saveTableMetadata(engine, schema)

    const selected = await exportWorkspace(engine, createNodeSqlJsEngine, {
      format: 'sqlite',
      selection: { kind: 'query', sql: 'SELECT * FROM sample' },
      fileName: 'selected',
      strict: true,
      includeMetadata: true,
    })
    const selectedEngine = createNodeSqlJsEngine()
    engines.push(selectedEngine)
    await selectedEngine.open(selected.bytes)
    expect((await selectedEngine.getSchema()).tables[0].name).toBe('query_result')

    const clean = await exportWorkspace(engine, createNodeSqlJsEngine, {
      format: 'sqlite',
      selection: { kind: 'workspace' },
      fileName: 'clean',
      strict: true,
      includeMetadata: false,
    })
    const cleanEngine = createNodeSqlJsEngine()
    engines.push(cleanEngine)
    await cleanEngine.open(clean.bytes)
    const execution = await cleanEngine.execute("SELECT name FROM sqlite_master WHERE name = '__dct_metadata'")
    const resultId = execution.statements[0].resultId!
    const page = await cleanEngine.getResultPage({ resultId, offset: 0, limit: 10 })
    expect(page.rows).toEqual([])
    await cleanEngine.releaseResult(resultId)
  })

  it('exports inferred DBF fields and reads them back', async () => {
    const engine = await createEngine()
    const schema: TableSchema = {
      id: 'sample',
      name: 'sample',
      columns: [
        { id: 'id', name: 'ID', dataType: 'integer', nullable: false, source: { name: 'ID', type: 'I' } },
        { id: 'name', name: 'NAME', dataType: 'string', nullable: true, source: { name: 'NAME', type: 'C', size: 20 } },
        { id: 'amount', name: 'AMOUNT', dataType: 'decimal', nullable: true, source: { name: 'AMOUNT', type: 'N', size: 20, decimalPlaces: 4 } },
        { id: 'date', name: 'DATE', dataType: 'date', nullable: true, source: { name: 'DATE', type: 'D' } },
        { id: 'active', name: 'ACTIVE', dataType: 'boolean', nullable: true, source: { name: 'ACTIVE', type: 'L' } },
      ],
    }
    await importTableIntoSqlite(engine, schema, {
      recordCount: 1,
      rows: (async function* () {
        yield [1, '张三', '12.3400', '2026-01-02', true]
      })(),
    })

    const result = await exportWorkspace(engine, createNodeSqlJsEngine, {
      format: 'dbf',
      selection: { kind: 'table', tableName: 'sample' },
      fileName: 'sample',
      strict: true,
      includeMetadata: true,
      encoding: 'gbk',
    })
    const restored = await new ArrayBufferDbfReader().read(exactBuffer(result.bytes), { strict: true })
    expect(restored.fields.slice(0, 5).map((field) => field.type)).toEqual(['I', 'C', 'N', 'D', 'L'])
    expect(restored.header.recordCount).toBe(1)
  })
})
