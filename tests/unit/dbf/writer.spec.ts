import { describe, expect, it } from 'vitest'

import type { CellValue } from '../../../src/core/model/value'
import { ArrayBufferDbfReader } from '../../../src/core/dbf/reader'
import { ArrayBufferDbfWriter } from '../../../src/core/dbf/writer'
import type { DbfFieldDescriptor } from '../../../src/core/dbf/types'
import {
  collectRecords,
  dbfField,
  dbfRecord,
  exactArrayBuffer,
  recordSource,
} from './test-utils'

function binaryFields(nullable = false): DbfFieldDescriptor[] {
  return [
    dbfField('C', 'C', 6),
    dbfField('N', 'N', 24, 4),
    dbfField('F', 'F', 20, 15),
    dbfField('Y', 'Y', 8, 4),
    dbfField('D', 'D', 8),
    dbfField('L', 'L', 1),
    dbfField('I', 'I', 4),
    dbfField('T', 'T', 8),
    dbfField('B', 'B', 8, 15),
  ].map((field) => nullable
    ? { ...field, nullable: true, flags: (field.flags ?? 0) | 0x02 }
    : field)
}

const binaryValues: CellValue[] = [
  '中文',
  '9007199254740993.1250',
  '1.234567890123456',
  '922337203685477.5807',
  '2024-02-29',
  true,
  -0x8000_0000,
  '2000-01-01T01:02:03.004',
  Math.PI,
]

describe('ArrayBufferDbfWriter independent binary encoding', () => {
  it('writes C/N/F/Y/D/L/I/T/B as exact VFP bytes and reads them back', async () => {
    const trailingHeader = Uint8Array.from([0xde, 0xad, 0xbe, 0xef])
    const bytes = await new ArrayBufferDbfWriter().write(
      binaryFields(),
      recordSource([dbfRecord(binaryValues)]),
      { strict: true, trailingHeader },
    )
    const view = new DataView(bytes.buffer)
    expect(bytes[0]).toBe(0x30)
    expect(view.getUint32(4, true)).toBe(1)
    expect(view.getUint16(8, true)).toBe(325)
    expect(view.getUint16(10, true)).toBe(88)
    expect(bytes[29]).toBe(0x7a)
    expect(bytes.subarray(321, 325)).toEqual(trailingHeader)
    expect(bytes[325]).toBe(0x20)
    expect(Array.from(bytes.subarray(326, 332))).toEqual([0xd6, 0xd0, 0xce, 0xc4, 0x20, 0x20])
    expect(new TextDecoder().decode(bytes.subarray(332, 356)).trim()).toBe('9007199254740993.1250')
    expect(new TextDecoder().decode(bytes.subarray(356, 376)).trim()).toBe('1.234567890123456')
    expect(view.getBigInt64(376, true)).toBe(0x7fff_ffff_ffff_ffffn)
    expect(new TextDecoder().decode(bytes.subarray(384, 392))).toBe('20240229')
    expect(bytes[392]).toBe(0x54)
    expect(view.getInt32(393, true)).toBe(-0x8000_0000)
    expect(view.getInt32(397, true)).toBe(2_451_545)
    expect(view.getInt32(401, true)).toBe(3_723_004)
    expect(view.getFloat64(405, true)).toBe(Math.PI)
    expect(bytes[bytes.length - 1]).toBe(0x1a)

    const read = await new ArrayBufferDbfReader().read(exactArrayBuffer(bytes), { strict: true })
    expect(read.header.trailingHeader).toEqual(trailingHeader)
    expect((await collectRecords(read.records))[0].values).toEqual(binaryValues)
  })

  it('writes and reads back GBK Chinese field names as exact bytes', async () => {
    const fields: DbfFieldDescriptor[] = [
      dbfField('学院确认', 'C', 14),
      dbfField('学院有误说', 'C', 20),
      dbfField('DS_H', 'N', 19, 4),
    ].map((field) => ({ ...field, nullable: true, flags: (field.flags ?? 0) | 0x02 }))
    const values: CellValue[] = ['是', '否', '1']

    const bytes = await new ArrayBufferDbfWriter().write(
      fields,
      recordSource([dbfRecord(values)]),
      { strict: true },
    )
    // 描述符里的字段名按 GBK 写出（"学" = 0xD1 0xA7），并以 null 结尾
    expect(bytes[32]).toBe(0xd1)
    expect(bytes[33]).toBe(0xa7)
    expect(bytes[32 + 10]).toBe(0x00)
    expect(bytes[32 + 32]).toBe(0xd1)

    const read = await new ArrayBufferDbfReader().read(exactArrayBuffer(bytes), { strict: true })
    expect(read.fields.map((field) => field.name)).toEqual(['学院确认', '学院有误说', 'DS_H', '_NullFlags'])
    const records = await collectRecords(read.records)
    // N 字段读回为数值；_NullFlags 系统字段的原样字节也会出现在原始值里（应用层会过滤 system 列）。
    expect(records[0].values.slice(0, 3)).toEqual(['是', '否', 1])
  })

  it('creates _NullFlags across byte boundaries for every supported nullable type', async () => {
    const fields = binaryFields(true)
    const allNull = Array<CellValue>(fields.length).fill(null)
    const bytes = await new ArrayBufferDbfWriter().write(
      fields,
      recordSource([dbfRecord(allNull), dbfRecord(binaryValues, true)]),
      { strict: true },
    )
    const view = new DataView(bytes.buffer)
    const headerLength = view.getUint16(8, true)
    const recordLength = view.getUint16(10, true)
    expect(recordLength).toBe(90)
    expect(view.getUint32(4, true)).toBe(2)
    expect(bytes[headerLength + 88]).toBe(0xff)
    expect(bytes[headerLength + 89]).toBe(0x01)
    expect(bytes[headerLength + recordLength]).toBe(0x2a)
    expect(bytes[headerLength + recordLength + 88]).toBe(0)
    expect(bytes[headerLength + recordLength + 89]).toBe(0)

    const read = await new ArrayBufferDbfReader().read(exactArrayBuffer(bytes), {
      strict: true,
      includeDeleted: true,
    })
    expect(read.fields.at(-1)).toMatchObject({
      name: '_NullFlags', type: '0', length: 2, flags: 0x05, system: true,
    })
    const records = await collectRecords(read.records)
    expect(records[0].values.slice(0, 9)).toEqual(allNull)
    expect(records[1].values.slice(0, 9)).toEqual(binaryValues)
  })

  it('preserves scaled int64 and int32 boundary values exactly', async () => {
    const fields = [
      dbfField('YMIN', 'Y', 8, 4),
      dbfField('IMIN', 'I', 4),
      dbfField('YMAX', 'Y', 8, 4),
      dbfField('IMAX', 'I', 4),
    ]
    const values: CellValue[] = [
      '-922337203685477.5808',
      -0x8000_0000,
      '922337203685477.5807',
      0x7fff_ffff,
    ]
    const bytes = await new ArrayBufferDbfWriter().write(
      fields,
      recordSource([dbfRecord(values)]),
      { strict: true },
    )
    const view = new DataView(bytes.buffer)
    const record = view.getUint16(8, true) + 1
    expect(view.getBigInt64(record, true)).toBe(-(1n << 63n))
    expect(view.getInt32(record + 8, true)).toBe(-0x8000_0000)
    expect(view.getBigInt64(record + 12, true)).toBe(0x7fff_ffff_ffff_ffffn)
    expect(view.getInt32(record + 20, true)).toBe(0x7fff_ffff)
    const read = await new ArrayBufferDbfReader().read(exactArrayBuffer(bytes), { strict: true })
    expect((await collectRecords(read.records))[0].values).toEqual(values)
  })
})

describe('DBF writer strictness and GBK boundaries', () => {
  it('never silently splits GBK characters and rejects loss in strict mode', async () => {
    const writer = new ArrayBufferDbfWriter()
    const fields = [dbfField('C', 'C', 3)]
    await expect(writer.write(fields, recordSource([dbfRecord(['中文'])]), { strict: true }))
      .rejects.toThrow(/needs 4 bytes/)
    await expect(writer.write(fields, recordSource([dbfRecord(['😀'])]), { strict: true }))
      .rejects.toThrow(/losslessly/)

    const bytes = await writer.write(fields, recordSource([dbfRecord(['中文'])]), { strict: false })
    const read = await new ArrayBufferDbfReader().read(exactArrayBuffer(bytes), { strict: true })
    expect((await collectRecords(read.records))[0].values).toEqual(['中'])
  })

  it('rejects numeric truncation, precision loss and overflow in strict mode', async () => {
    const writer = new ArrayBufferDbfWriter()
    const cases: Array<[DbfFieldDescriptor, CellValue, RegExp]> = [
      [dbfField('N', 'N', 5, 2), '1234.56', /width/],
      [dbfField('N', 'N', 8, 2), '1.234', /decimal places/],
      [dbfField('N', 'N', 20), 9_007_199_254_740_992, /unsafe/],
      [dbfField('Y', 'Y', 8, 4), '1.00001', /four decimal/],
      [dbfField('Y', 'Y', 8, 4), '1.0000000000000000000000001', /four decimal/],
      [dbfField('Y', 'Y', 8, 4), '922337203685477.5808', /int64/],
      [dbfField('I', 'I', 4), '2147483648', /int32/],
      [dbfField('B', 'B', 8), '1.234567890123456789', /precision/],
    ]
    for (const [field, value, message] of cases) {
      await expect(writer.write([field], recordSource([dbfRecord([value])]), { strict: true }))
        .rejects.toThrow(message)
    }
  })

  it('uses explicit half-up rounding only outside strict mode', async () => {
    const fields = [dbfField('N', 'N', 5, 2), dbfField('Y', 'Y', 8, 4)]
    const bytes = await new ArrayBufferDbfWriter().write(
      fields,
      recordSource([dbfRecord(['1.235', '1.00001'])]),
      { strict: false },
    )
    const read = await new ArrayBufferDbfReader().read(exactArrayBuffer(bytes), { strict: true })
    expect((await collectRecords(read.records))[0].values).toEqual([1.24, 1])
  })

  it('writes integer values into decimal N fields without padding overflow', async () => {
    // 回归：N(4,1) 写整数 110 曾被格式化为 "110.0"（5 字节）而溢出。
    // 自然表示 "110" 才与源文件（" 110"）一致。
    const fields = [dbfField('NK_XYSSY', 'N', 4, 1)]
    const bytes = await new ArrayBufferDbfWriter().write(
      fields,
      recordSource([dbfRecord([110])]),
      { strict: true },
    )
    const view = new DataView(bytes.buffer)
    const recordOffset = view.getUint16(8, true) + 1
    // 右对齐 " 110"，与原始 DBF 的存储字节一致
    expect(new TextDecoder().decode(bytes.subarray(recordOffset, recordOffset + 4))).toBe(' 110')

    // 小数值仍按实际小数位数写出
    const withFraction = await new ArrayBufferDbfWriter().write(
      fields,
      recordSource([dbfRecord([11.5])]),
      { strict: true },
    )
    const fractionView = new DataView(withFraction.buffer)
    const fractionOffset = fractionView.getUint16(8, true) + 1
    expect(new TextDecoder().decode(withFraction.subarray(fractionOffset, fractionOffset + 4))).toBe('11.5')
  })

  it('rejects non-nullable NULL, invalid dates and inconsistent strict source metadata', async () => {
    const writer = new ArrayBufferDbfWriter()
    await expect(writer.write(
      [dbfField('C', 'C', 2)],
      recordSource([dbfRecord([null])]),
      { strict: true },
    )).rejects.toThrow(/not nullable/)
    await expect(writer.write(
      [dbfField('D', 'D', 8)],
      recordSource([dbfRecord(['2023-02-29'])]),
      { strict: true },
    )).rejects.toThrow(/Invalid DBF calendar date/)
    const source = recordSource([dbfRecord([1])])
    source.recordCount = 2
    await expect(writer.write([dbfField('N', 'N', 2)], source, { strict: true }))
      .rejects.toThrow(/declared 2 records/)
  })

  it('can write a hand-checked GBK descriptor without relying on reader field offsets', async () => {
    const bytes = await new ArrayBufferDbfWriter().write(
      [dbfField('A', 'C', 2)],
      recordSource([dbfRecord(['中'])]),
      { strict: true },
    )
    expect(bytes[32]).toBe(0x41)
    expect(bytes[43]).toBe(0x43)
    expect(new DataView(bytes.buffer).getUint32(44, true)).toBe(1)
    expect(bytes[bytes.length - 1]).toBe(0x1a)
  })
})
