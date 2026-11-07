import { describe, expect, it } from 'vitest'

import { crc32, createZip } from '../../../src/core/utils/zip'

const textBytes = (text: string): Uint8Array => new TextEncoder().encode(text)

describe('crc32', () => {
  it('matches the standard check vector', () => {
    expect(crc32(textBytes('123456789'))).toBe(0xcbf43926)
  })

  it('returns zero for empty input', () => {
    expect(crc32(new Uint8Array(0))).toBe(0)
  })
})

describe('createZip', () => {
  it('rejects empty archives', async () => {
    await expect(createZip([])).rejects.toThrow(/empty/i)
  })

  it('writes a readable archive with local headers, central directory and EOCD', async () => {
    const fileOne = textBytes('id,name\n1,张三\n')
    const fileTwo = textBytes('id,name\n2,李四\n')
    const archive = await createZip([
      { name: '分组一.csv', data: fileOne },
      { name: '分组二.csv', data: fileTwo },
    ])
    const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength)

    // 本地文件头签名 PK\x03\x04
    expect(archive[0]).toBe(0x50)
    expect(archive[1]).toBe(0x4b)
    expect(archive[2]).toBe(0x03)
    expect(archive[3]).toBe(0x04)

    // EOCD 固定位于末尾 22 字节（无注释）
    const eocdOffset = archive.length - 22
    expect(view.getUint32(eocdOffset, true)).toBe(0x06054b50)
    expect(view.getUint16(eocdOffset + 8, true)).toBe(2) // 总条目数
    expect(view.getUint16(eocdOffset + 10, true)).toBe(2)
    const centralSize = view.getUint32(eocdOffset + 12, true)
    const centralOffset = view.getUint32(eocdOffset + 16, true)
    expect(centralOffset + centralSize).toBe(eocdOffset)

    // 中央目录首条目：CRC 位于 +16，压缩/原始大小位于 +20/+24
    expect(view.getUint32(centralOffset, true)).toBe(0x02014b50)
    expect(view.getUint32(centralOffset + 16, true)).toBe(crc32(fileOne))
    expect(view.getUint32(centralOffset + 20, true)).toBeGreaterThan(0)
    expect(view.getUint32(centralOffset + 24, true)).toBe(fileOne.length)
  })

  it('round-trips entries through DecompressionStream when available', async () => {
    if (typeof DecompressionStream !== 'function') return
    const content = textBytes('a,b\n1,2\n'.repeat(64))
    const archive = await createZip([
      { name: 'nested/组.csv', data: content },
    ])

    const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength)
    const method = view.getUint16(8, true)
    const nameLength = view.getUint16(26, true)
    const compressedSize = view.getUint32(18, true)
    const uncompressedSize = view.getUint32(22, true)
    expect(uncompressedSize).toBe(content.length)
    expect(method).toBe(8) // 原生 deflate-raw 可用时使用压缩

    const dataStart = 30 + nameLength
    const stream = new Blob([archive.subarray(dataStart, dataStart + compressedSize) as BlobPart])
      .stream()
      .pipeThrough(new DecompressionStream('deflate-raw'))
    const restored = new Uint8Array(await new Response(stream).arrayBuffer())
    expect([...restored]).toEqual([...content])
  })
})
