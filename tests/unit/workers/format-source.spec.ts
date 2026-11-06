import { afterEach, describe, expect, it } from 'vitest'

import { createNodeSqlJsEngine } from '../../../src/core/database/sqljs-node'
import type { SqlJsEngine } from '../../../src/core/database/sqljs-engine'
import { writeXlsx } from '../../../src/core/formats/xlsx'
import type { ImportMapping } from '../../../src/core/model/conversion'
import type { TableSchema } from '../../../src/core/model/table'
import { importCsvIntoSqlite, importXlsxIntoSqlite, previewCsv, previewXlsx } from '../../../src/workers/format-source'

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

describe('XLSX/CSV worker sources', () => {
  it('previews, infers, maps and imports CSV', async () => {
    const text = 'id,name,amount,active\r\n001,张三,123.450000000000001,true\r\n2,,x,false\r\n'
    const buffer = new TextEncoder().encode(text).buffer as ArrayBuffer
    const preview = await previewCsv(buffer, { encoding: 'utf-8', hasHeader: true }, 'people.csv')
    expect(preview.totalRows).toBe(2)
    expect(preview.sampleRows).toHaveLength(2)
    expect(preview.schema.columns[0].dataType).toBe('string')

    const mapping: ImportMapping = {
      sourceSchema: preview.schema,
      targetTableName: 'people',
      columns: preview.schema.columns.map((column, index) => ({
        sourceIndex: index,
        included: index < 2,
        targetName: index === 0 ? 'ID' : index === 1 ? 'NAME' : column.name,
      })),
    }
    const engine = await createEngine()
    const result = await importCsvIntoSqlite(
      engine,
      buffer,
      { encoding: 'utf-8', hasHeader: true },
      'people',
      mapping,
      'people.csv',
    )
    expect(result.table.columns.map((column) => column.name)).toEqual(['ID', 'NAME'])

    const execution = await engine.execute('SELECT * FROM people ORDER BY rowid')
    const resultId = execution.statements[0].resultId!
    const page = await engine.getResultPage({ resultId, offset: 0, limit: 10 })
    expect(page.rows).toEqual([['001', '张三'], ['2', '']])
    await engine.releaseResult(resultId)
  })

  it('round-trips XLSX through preview and SQLite import', async () => {
    const schema: TableSchema = {
      id: 'book',
      name: 'book',
      columns: [
        { id: 'id', name: 'id', dataType: 'integer', nullable: false },
        { id: 'date', name: 'date', dataType: 'date', nullable: true },
      ],
    }
    const bytes = writeXlsx(schema, [[1, '2026-01-02'], [2, null]])
    const buffer = exactBuffer(bytes)
    const preview = await previewXlsx(buffer, { headerRow: 1, inferDates: true }, 'book.xlsx')
    expect(preview.totalRows).toBe(2)
    expect(preview.sheetNames).toEqual(['book'])

    const engine = await createEngine()
    const result = await importXlsxIntoSqlite(
      engine,
      buffer,
      { headerRow: 1, inferDates: true },
      'book',
      undefined,
      'book.xlsx',
    )
    expect(result.recordCount).toBe(2)
    expect((await engine.getSchema()).tables[0].name).toBe('book')
  })
})
