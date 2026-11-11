import { readFile } from 'node:fs/promises'

import { afterEach, describe, expect, it } from 'vitest'

import { createNodeSqlJsEngine } from '../../../src/core/database/sqljs-node'
import type { SqlJsEngine } from '../../../src/core/database/sqljs-engine'
import { ArrayBufferDbfReader } from '../../../src/core/dbf/reader'
import { ArrayBufferDbfWriter } from '../../../src/core/dbf/writer'
import type { ExportOptions } from '../../../src/core/model/conversion'
import { quoteSqliteIdentifier } from '../../../src/core/utils/identifiers'
import { importDbfIntoSqlite } from '../../../src/workers/dbf-source'
import { writeOriginalDbfIfPossible } from '../../../src/workers/dbf-export'
import { readSelection } from '../../../src/workers/selection'
import type { DbfFieldDescriptor } from '../../../src/core/dbf/types'
import { collectRecords, dbfRecord, recordSource } from '../dbf/test-utils'

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

  it('round-trips blank numeric values in non-nullable columns under strict export', async () => {
    // 真实场景：描述符未标记 nullable，但数值字段以全空格表示"未填写"。
    // 读取时字段应升级为可空，strict 导出不再抛 "is NULL but is not nullable"。
    const fields: DbfFieldDescriptor[] = [
      { name: 'NK_G', type: 'N', length: 1, decimalPlaces: 0, flags: 0, nullable: false, system: false },
      { name: 'XM', type: 'C', length: 4, decimalPlaces: 0, flags: 0, nullable: false, system: false },
    ]
    const blank = await new ArrayBufferDbfWriter().write(
      fields,
      recordSource([dbfRecord([null, '张三'])]),
      { strict: false },
    )
    const engine = createNodeSqlJsEngine()
    engines.push(engine)
    await engine.open()
    // strict 导入：空数值按 NULL 干净处理，不再抛无效值错误
    const imported = await importDbfIntoSqlite(engine, exactBuffer(blank), { strict: true }, 'sample')
    expect(imported.table.columns.find((column) => column.name === 'NK_G')?.nullable).toBe(true)
    const selection = await readSelection(engine, { kind: 'table', tableName: 'sample' })

    const bytes = await writeOriginalDbfIfPossible(
      selection,
      imported.table,
      exportOptions('SELECT * FROM sample'),
    )
    expect(bytes).toBeDefined()
    const restored = await new ArrayBufferDbfReader().read(exactBuffer(bytes!), { strict: true })
    // 忠实源文件：输出文件里 NK_G 的描述符 flags 保持 0（非可空）+ 全空格内容，
    // 而不是显式 .NULL.（读取器内存中的 nullable 升级是预期的展示行为，不影响字节）
    expect(bytes![32 + 18]).toBe(0)
    const nkGBytes = bytes!.subarray(
      restored.header.headerLength + 1,
      restored.header.headerLength + 2,
    )
    expect(nkGBytes[0]).toBe(0x20)
    // 空白内容按 DBF 文本语义读回为 NULL
    expect((await collectRecords(restored.records))[0].values[0]).toBeNull()
  })
})
