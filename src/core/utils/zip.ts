/**
 * 极简 ZIP 归档写入器。
 *
 * - 优先使用浏览器/Node 原生 CompressionStream('deflate-raw')（ZIP method 8）；
 *   运行环境不支持时回退为仅存储（method 0）。
 * - 文件名按 UTF-8 写入并置位通用标志 bit 11。
 * - 不支持 ZIP64：单个文件与总大小超过 4 GiB 时会生成损坏的归档，调用方需自行控制规模。
 */

export interface ZipEntry {
  /** 归档内的文件路径；使用 `/` 分隔，不得以 `/` 开头。 */
  name: string
  data: Uint8Array
}

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50
const UTF8_FLAG = 1 << 11
const METHOD_STORE = 0
const METHOD_DEFLATE = 8

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (let index = 0; index < data.length; index += 1) {
    crc = CRC32_TABLE[(crc ^ data[index]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** 写入小端无符号整数。 */
function writeUint32(target: Uint8Array, offset: number, value: number): void {
  target[offset] = value & 0xff
  target[offset + 1] = (value >>> 8) & 0xff
  target[offset + 2] = (value >>> 16) & 0xff
  target[offset + 3] = (value >>> 24) & 0xff
}

function writeUint16(target: Uint8Array, offset: number, value: number): void {
  target[offset] = value & 0xff
  target[offset + 1] = (value >>> 8) & 0xff
}

function dosDateTime(date: Date): { time: number; date: number } {
  const time =
    (date.getHours() << 11) | (date.getMinutes() << 5) | (Math.floor(date.getSeconds() / 2))
  const dateValue =
    ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  return { time, date: dateValue }
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array | undefined> {
  const CompressionStreamCtor = globalThis.CompressionStream
  if (typeof CompressionStreamCtor !== 'function') return undefined
  try {
    const stream = new Blob([data as BlobPart])
      .stream()
      .pipeThrough(new CompressionStreamCtor('deflate-raw'))
    const buffer = await new Response(stream).arrayBuffer()
    return new Uint8Array(buffer)
  } catch {
    return undefined
  }
}

export async function createZip(entries: readonly ZipEntry[], timestamp: Date = new Date()): Promise<Uint8Array> {
  if (!entries.length) throw new Error('Cannot create an empty ZIP archive')

  const { time, date } = dosDateTime(timestamp)
  const encoder = new TextEncoder()
  const chunks: Uint8Array[] = []
  const centralRecords: Uint8Array[] = []
  let offset = 0

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name.replace(/^\/+/, ''))
    const crc = crc32(entry.data)
    const compressed = await deflateRaw(entry.data)
    const method = compressed ? METHOD_DEFLATE : METHOD_STORE
    const payload = compressed ?? entry.data

    const localHeader = new Uint8Array(30 + nameBytes.length)
    writeUint32(localHeader, 0, LOCAL_FILE_HEADER_SIGNATURE)
    writeUint16(localHeader, 4, 20) // version needed
    writeUint16(localHeader, 6, UTF8_FLAG)
    writeUint16(localHeader, 8, method)
    writeUint16(localHeader, 10, time)
    writeUint16(localHeader, 12, date)
    writeUint32(localHeader, 14, crc)
    writeUint32(localHeader, 18, payload.length)
    writeUint32(localHeader, 22, entry.data.length)
    writeUint16(localHeader, 26, nameBytes.length)
    writeUint16(localHeader, 28, 0) // extra length
    localHeader.set(nameBytes, 30)

    chunks.push(localHeader, payload)

    const centralRecord = new Uint8Array(46 + nameBytes.length)
    writeUint32(centralRecord, 0, CENTRAL_DIRECTORY_SIGNATURE)
    writeUint16(centralRecord, 4, 20) // version made by
    writeUint16(centralRecord, 6, 20) // version needed
    writeUint16(centralRecord, 8, UTF8_FLAG)
    writeUint16(centralRecord, 10, method)
    writeUint16(centralRecord, 12, time)
    writeUint16(centralRecord, 14, date)
    writeUint32(centralRecord, 16, crc)
    writeUint32(centralRecord, 20, payload.length)
    writeUint32(centralRecord, 24, entry.data.length)
    writeUint16(centralRecord, 28, nameBytes.length)
    writeUint16(centralRecord, 30, 0) // extra length
    writeUint16(centralRecord, 32, 0) // comment length
    writeUint16(centralRecord, 34, 0) // disk number
    writeUint16(centralRecord, 36, 0) // internal attributes
    writeUint32(centralRecord, 38, 0) // external attributes
    writeUint32(centralRecord, 42, offset)
    centralRecord.set(nameBytes, 46)
    centralRecords.push(centralRecord)

    offset += localHeader.length + payload.length
  }

  const centralDirectorySize = centralRecords.reduce((total, record) => total + record.length, 0)
  const endRecord = new Uint8Array(22)
  writeUint32(endRecord, 0, END_OF_CENTRAL_DIRECTORY_SIGNATURE)
  writeUint16(endRecord, 4, 0) // disk number
  writeUint16(endRecord, 6, 0) // central directory disk
  writeUint16(endRecord, 8, entries.length)
  writeUint16(endRecord, 10, entries.length)
  writeUint32(endRecord, 12, centralDirectorySize)
  writeUint32(endRecord, 16, offset)
  writeUint16(endRecord, 20, 0) // comment length

  const totalLength = offset + centralDirectorySize + endRecord.length
  const archive = new Uint8Array(totalLength)
  let position = 0
  for (const chunk of [...chunks, ...centralRecords, endRecord]) {
    archive.set(chunk, position)
    position += chunk.length
  }
  return archive
}
