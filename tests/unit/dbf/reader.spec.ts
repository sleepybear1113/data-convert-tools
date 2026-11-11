import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

import { ArrayBufferDbfReader } from '../../../src/core/dbf/reader'
import { encodeDbfText } from '../../../src/core/dbf/encoding'
import type { DbfFieldDescriptor } from '../../../src/core/dbf/types'
import { collectRecords, dbfField, exactArrayBuffer } from './test-utils'

function putAscii(bytes: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) bytes[offset + index] = value.charCodeAt(index)
}

function putDescriptor(
  bytes: Uint8Array,
  index: number,
  field: DbfFieldDescriptor,
  offset: number,
): void {
  const start = 32 + index * 32
  putAscii(bytes, start, field.name)
  bytes[start + 11] = field.type.charCodeAt(0)
  new DataView(bytes.buffer).setUint32(start + 12, offset, true)
  bytes[start + 16] = field.length
  bytes[start + 17] = field.decimalPlaces
  bytes[start + 18] = field.flags ?? 0
}

function rawDbf(fields: readonly DbfFieldDescriptor[], recordCount: number, trailing: Uint8Array): {
  bytes: Uint8Array
  view: DataView
  headerLength: number
  recordLength: number
} {
  const headerLength = 33 + fields.length * 32 + trailing.length
  const recordLength = 1 + fields.reduce((sum, field) => sum + field.length, 0)
  const bytes = new Uint8Array(headerLength + recordCount * recordLength + 1)
  const view = new DataView(bytes.buffer)
  bytes[0] = 0x30
  view.setUint32(4, recordCount, true)
  view.setUint16(8, headerLength, true)
  view.setUint16(10, recordLength, true)
  bytes[29] = 0x7a
  let offset = 1
  fields.forEach((field, index) => {
    putDescriptor(bytes, index, field, offset)
    offset += field.length
  })
  bytes[32 + fields.length * 32] = 0x0d
  bytes.set(trailing, 33 + fields.length * 32)
  bytes[bytes.length - 1] = 0x1a
  return { bytes, view, headerLength, recordLength }
}

describe('ArrayBufferDbfReader independent binary decoding', () => {
  it('decodes C/N/F/Y/D/L/I/T/B directly from VFP little-endian bytes', async () => {
    const fields = [
      dbfField('C', 'C', 6),
      dbfField('N', 'N', 24, 4),
      dbfField('F', 'F', 20, 15),
      dbfField('Y', 'Y', 8, 4),
      dbfField('D', 'D', 8),
      dbfField('L', 'L', 1),
      dbfField('I', 'I', 4),
      dbfField('T', 'T', 8),
      dbfField('B', 'B', 8, 15),
    ]
    const { bytes, view, headerLength } = rawDbf(fields, 1, new Uint8Array())
    const record = headerLength
    bytes[record] = 0x20
    bytes.set([0xd6, 0xd0, 0xce, 0xc4, 0x20, 0x20], record + 1) // GBK "中文"
    putAscii(bytes, record + 7, '9007199254740993.1250'.padStart(24))
    putAscii(bytes, record + 31, '1.234567890123456'.padStart(20))
    view.setBigInt64(record + 51, 0x7fff_ffff_ffff_ffffn, true)
    putAscii(bytes, record + 59, '20240229')
    bytes[record + 67] = 0x54
    view.setInt32(record + 68, -0x8000_0000, true)
    view.setInt32(record + 72, 2_451_545, true)
    view.setInt32(record + 76, 3_723_004, true)
    view.setFloat64(record + 80, Math.PI, true)

    const result = await new ArrayBufferDbfReader().read(exactArrayBuffer(bytes), { strict: true })
    const records = await collectRecords(result.records)
    expect(records).toHaveLength(1)
    expect(records[0].values).toEqual([
      '中文',
      '9007199254740993.1250',
      '1.234567890123456',
      '922337203685477.5807',
      '2024-02-29',
      true,
      -0x8000_0000,
      '2000-01-01T01:02:03.004',
      Math.PI,
    ])
    expect(records[0].raw).toHaveLength(result.header.recordLength)
  })

  it('decodes GBK Chinese field names via the language driver (LDID 0x7A)', async () => {
    // 模拟真实场景：字段描述符里是 GBK 中文字段名（如"学院确认"），数据也是 GBK。
    const fields: DbfFieldDescriptor[] = [
      dbfField('学院确认', 'C', 8),
      dbfField('BMXH', 'C', 5),
    ]
    const headerLength = 33 + fields.length * 32
    const recordLength = 1 + fields.reduce((sum, field) => sum + field.length, 0)
    const bytes = new Uint8Array(headerLength + recordLength + 1)
    const view = new DataView(bytes.buffer)
    bytes[0] = 0x30
    view.setUint32(4, 1, true)
    view.setUint16(8, headerLength, true)
    view.setUint16(10, recordLength, true)
    bytes[29] = 0x7a
    fields.forEach((field, index) => {
      const start = 32 + index * 32
      bytes.set(encodeDbfText(field.name, 'gbk'), start)
      bytes[start + 11] = field.type.charCodeAt(0)
      bytes[start + 16] = field.length
      bytes[start + 17] = field.decimalPlaces
    })
    bytes[32 + fields.length * 32] = 0x0d
    const record = headerLength
    bytes[record] = 0x20
    bytes.set(encodeDbfText('是', 'gbk'), record + 1)
    bytes.set(encodeDbfText('BM001', 'gbk'), record + 9)
    bytes[bytes.length - 1] = 0x1a

    const result = await new ArrayBufferDbfReader().read(exactArrayBuffer(bytes), { strict: true })
    expect(result.fields.map((field) => field.name)).toEqual(['学院确认', 'BMXH'])
    expect((await collectRecords(result.records))[0].values).toEqual(['是', 'BM001'])
  })

  it('treats blank numeric fields as NULL and upgrades the column to nullable', async () => {
    // 真实场景：描述符未标记 nullable（flags=0），但数据以全空格表示"未填写"。
    const fields: DbfFieldDescriptor[] = [
      dbfField('NK_G', 'N', 1),
      dbfField('XM', 'C', 4),
    ]
    const headerLength = 33 + fields.length * 32
    const recordLength = 1 + fields.reduce((sum, field) => sum + field.length, 0)
    const bytes = new Uint8Array(headerLength + recordLength + 1)
    const view = new DataView(bytes.buffer)
    bytes[0] = 0x30
    view.setUint32(4, 1, true)
    view.setUint16(8, headerLength, true)
    view.setUint16(10, recordLength, true)
    bytes[29] = 0x7a
    fields.forEach((field, index) => {
      const start = 32 + index * 32
      bytes.set(encodeDbfText(field.name, 'gbk'), start)
      bytes[start + 11] = field.type.charCodeAt(0)
      bytes[start + 16] = field.length
      bytes[start + 18] = 0 // flags=0：描述符标记为不可空
    })
    bytes[32 + fields.length * 32] = 0x0d
    const record = headerLength
    bytes[record] = 0x20
    bytes[record + 1] = 0x20 // NK_G 全空格 = 未填写
    bytes.set(encodeDbfText('姚尧', 'gbk'), record + 2)
    bytes[bytes.length - 1] = 0x1a

    const result = await new ArrayBufferDbfReader().read(exactArrayBuffer(bytes), { strict: true })
    expect((await collectRecords(result.records))[0].values).toEqual([null, '姚尧'])
    // 空值被干净地识别为 NULL，且字段升级为可空，不再产生无效值警告
    expect(result.fields[0].nullable).toBe(true)
    expect(result.fields[1].nullable).toBe(false)
    expect(result.diagnostics.some((item) => item.code === 'DBF_EMPTY_VALUES_NULLABLE')).toBe(true)
    expect(result.diagnostics.some((item) => item.code === 'DBF_INVALID_FIELD_VALUE')).toBe(false)
  })

  it('uses _NullFlags bits, honors headerLength/trailingHeader, and filters deleted records', async () => {
    const fields = [
      dbfField('A', 'C', 3, 0, { nullable: true, flags: 0x02 }),
      dbfField('B', 'I', 4, 0, { nullable: true, flags: 0x02 }),
      dbfField('C', 'C', 2),
      dbfField('_NullFlags', '0', 1, 0, { system: true, flags: 0x05 }),
    ]
    const trailing = Uint8Array.from([7, 6, 5, 4, 3, 2, 1])
    const { bytes, view, headerLength, recordLength } = rawDbf(fields, 2, trailing)
    bytes.fill(0x20, headerLength, headerLength + 2 * recordLength)
    bytes[headerLength] = 0x20
    putAscii(bytes, headerLength + 1, 'abc')
    view.setInt32(headerLength + 4, 123, true)
    putAscii(bytes, headerLength + 8, 'ok')
    bytes[headerLength + 10] = 0b10
    bytes[headerLength + recordLength] = 0x2a
    view.setInt32(headerLength + recordLength + 4, -7, true)
    bytes[headerLength + recordLength + 10] = 0b01

    const reader = new ArrayBufferDbfReader()
    const buffer = exactArrayBuffer(bytes)
    const visible = await reader.read(buffer, { strict: true })
    expect((await collectRecords(visible.records)).map((record) => record.values.slice(0, 3)))
      .toEqual([['abc', null, 'ok']])
    expect(visible.header.trailingHeader).toEqual(trailing)

    const all = await reader.read(buffer, { strict: true, includeDeleted: true })
    const records = await collectRecords(all.records)
    expect(records).toHaveLength(2)
    expect(records[1].deleted).toBe(true)
    expect(records[1].values.slice(0, 3)).toEqual([null, -7, ''])
    expect(records[1].values[3]).toEqual(Uint8Array.from([1]))
    expect(records[1].raw?.[0]).toBe(0x2a)
  })

  it('rejects truncated records in strict mode instead of fabricating data', async () => {
    const { bytes } = rawDbf([dbfField('I', 'I', 4)], 2, new Uint8Array())
    const truncated = bytes.slice(0, bytes.length - 6)
    await expect(new ArrayBufferDbfReader().read(exactArrayBuffer(truncated), { strict: true }))
      .rejects.toThrow(/truncated/)
  })
})

describe('VFP 0x30 desensitized fixture', () => {
  it('reads the real header, system metadata and records without exposing field data', async () => {
    const fixtureUrl = new URL('../../fixtures/dbf/vfp-0x30-c-nulls.dbf', import.meta.url)
    const expectedUrl = new URL('../../fixtures/dbf/vfp-0x30-c-nulls.header.json', import.meta.url)
    const [file, expectedText] = await Promise.all([
      readFile(fixtureUrl),
      readFile(expectedUrl, 'utf8'),
    ])
    const expected = JSON.parse(expectedText) as Record<string, number | string>
    const result = await new ArrayBufferDbfReader().read(exactArrayBuffer(file), {
      includeDeleted: true,
    })
    expect(result.header.fileVersion).toBe(0x30)
    expect(result.header.recordCount).toBeGreaterThan(0)
    expect(result.header.headerLength).toBe(expected.headerLength)
    expect(result.header.recordLength).toBe(expected.recordLength)
    expect(result.header.languageDriver).toBe(0x7a)
    expect(result.header.trailingHeader).toHaveLength(expected.trailingHeaderLength as number)
    expect(result.header.trailingHeader.every((byte) => byte === 0)).toBe(true)
    expect(result.fields).toHaveLength(expected.descriptorCount as number)
    expect(result.fields.filter((field) => !field.system)).toHaveLength(44)
    expect(result.fields.filter((field) => !field.system).every((field) => field.type === 'C')).toBe(true)
    expect(result.fields.at(-1)).toMatchObject({
      name: '_NullFlags', type: '0', length: 5, system: true, flags: 0x05,
    })
    const records = await collectRecords(result.records)
    expect(records).toHaveLength(result.header.recordCount)
    expect(records.every((record) => record.raw?.length === result.header.recordLength)).toBe(true)
    expect(records.some((record) => record.values.some(
      (value) => typeof value === 'string' && value.length > 0,
    ))).toBe(true)
  })
})
