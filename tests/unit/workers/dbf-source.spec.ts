import { readFile } from 'node:fs/promises'

import { afterEach, describe, expect, it } from 'vitest'

import { createNodeSqlJsEngine } from '../../../src/core/database/sqljs-node'
import type { SqlJsEngine } from '../../../src/core/database/sqljs-engine'
import { ArrayBufferDbfWriter } from '../../../src/core/dbf/writer'
import { importDbfIntoSqlite, openDbfSource, previewDbf } from '../../../src/workers/dbf-source'

const engines: SqlJsEngine[] = []

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.close()))
})

function exactBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

describe('DBF worker source', () => {
  it('previews only business columns and tracks visible records', async () => {
    const file = await readFile('tests/fixtures/dbf/vfp-0x30-c-nulls.dbf')
    const preview = await previewDbf(exactBuffer(file), { strict: true }, 'sample.dbf')

    expect(preview.schema.columns).toHaveLength(44)
    expect(preview.schema.columns.every((column) => column.dataType === 'string')).toBe(true)
    expect(preview.sampleRows).toHaveLength(1)
    expect(preview.totalRows).toBe(1)
    expect(preview.schema.source?.format).toBe('dbf')
  })

  it('imports DBF into SQLite without exposing _NullFlags as a business column', async () => {
    const file = await readFile('tests/fixtures/dbf/vfp-0x30-c-nulls.dbf')
    const engine = createNodeSqlJsEngine()
    engines.push(engine)
    await engine.open()

    const result = await importDbfIntoSqlite(
      engine,
      exactBuffer(file),
      { strict: true },
      'sample',
      'sample.dbf',
    )
    expect(result.recordCount).toBe(1)
    expect(result.table.columns).toHaveLength(44)
    expect((await engine.getSchema()).tables[0].name).toBe('sample')
  })

  it('uses exact decimal text for high-precision numeric fields', async () => {
    const bytes = await new ArrayBufferDbfWriter().write([
      { name: 'N', type: 'N', length: 24, decimalPlaces: 4, nullable: false },
    ], {
      recordCount: 1,
      records: (async function* () {
        yield { values: ['9007199254740993.1250'], deleted: false }
      })(),
    }, { strict: true })

    const source = await openDbfSource(exactBuffer(bytes), { strict: true }, 'numbers')
    expect(source.schema.columns[0].dataType).toBe('decimal')
  })
})
