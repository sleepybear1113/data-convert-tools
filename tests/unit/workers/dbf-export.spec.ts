import { readFile } from 'node:fs/promises'

import { afterEach, describe, expect, it } from 'vitest'

import { createNodeSqlJsEngine } from '../../../src/core/database/sqljs-node'
import type { SqlJsEngine } from '../../../src/core/database/sqljs-engine'
import { ArrayBufferDbfReader } from '../../../src/core/dbf/reader'
import type { ExportOptions } from '../../../src/core/model/conversion'
import { quoteSqliteIdentifier } from '../../../src/core/utils/identifiers'
import { importDbfIntoSqlite } from '../../../src/workers/dbf-source'
import { writeOriginalDbfIfPossible } from '../../../src/workers/dbf-export'
import { readSelection } from '../../../src/workers/selection'

const engines: SqlJsEngine[] = []

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.close()))
})

function exactBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function exportOptions(sql: string): ExportOptions {
  return {
    format: 'dbf',
    selection: { kind: 'query', sql },
    fileName: 'output.dbf',
    strict: true,
    includeMetadata: true,
    encoding: 'gbk',
  }
}

describe('original DBF export', () => {
  it('preserves original descriptors and header on a full-table round trip', async () => {
    const file = await readFile('tests/fixtures/dbf/vfp-0x30-c-nulls.dbf')
    const engine = createNodeSqlJsEngine()
    engines.push(engine)
    await engine.open()
    const imported = await importDbfIntoSqlite(engine, exactBuffer(file), { strict: true }, 'sample')
    const selection = await readSelection(engine, { kind: 'table', tableName: 'sample' })

    const bytes = await writeOriginalDbfIfPossible(
      selection,
      imported.table,
      exportOptions('SELECT * FROM sample'),
    )
    expect(bytes).toBeDefined()
    const restored = await new ArrayBufferDbfReader().read(exactBuffer(bytes!), { strict: true })

    expect(restored.header.headerLength).toBe(1736)
    expect(restored.header.recordLength).toBe(1313)
    expect(restored.header.trailingHeader).toHaveLength(263)
    expect(restored.fields).toHaveLength(45)
    expect(restored.header.recordCount).toBe(1)
    expect(bytes![bytes!.length - 1]).toBe(0x1a)
  })

  it('falls back to inference when original columns are missing', async () => {
    const file = await readFile('tests/fixtures/dbf/vfp-0x30-c-nulls.dbf')
    const engine = createNodeSqlJsEngine()
    engines.push(engine)
    await engine.open()
    const imported = await importDbfIntoSqlite(engine, exactBuffer(file), { strict: true }, 'sample')
    const firstName = imported.table.columns[0].name
    const sql = `SELECT ${quoteSqliteIdentifier(firstName)} FROM sample`
    const selection = await readSelection(engine, { kind: 'query', sql })

    await expect(writeOriginalDbfIfPossible(selection, imported.table, exportOptions(sql)))
      .resolves.toBeUndefined()
  })
})
