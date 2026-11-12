import iconv from 'iconv-lite'

import { bytesEqual } from './binary'

const LANGUAGE_DRIVER_ENCODINGS: Readonly<Record<number, string>> = {
  // Visual FoxPro simplified Chinese, code page 936.
  0x7a: 'gbk',
}

export const DEFAULT_DBF_ENCODING = 'gbk'

export function encodingForLanguageDriver(languageDriver: number): string | undefined {
  return LANGUAGE_DRIVER_ENCODINGS[languageDriver]
}

export function languageDriverForEncoding(encoding: string): number | undefined {
  const normalized = encoding.toLowerCase().replaceAll('_', '-')
  if (['gbk', 'gb2312', 'cp936', 'windows-936', '936'].includes(normalized)) {
    return 0x7a
  }
  return undefined
}

export function assertDbfEncoding(encoding: string): void {
  if (!iconv.encodingExists(encoding)) {
    throw new Error(`不支持的 DBF 字符编码：${encoding}`)
  }
}

export function encodeDbfText(value: string, encoding: string): Uint8Array {
  return Uint8Array.from(iconv.encode(value, encoding))
}

export function isLosslessEncoding(value: string, encoded: Uint8Array, encoding: string): boolean {
  return iconv.decode(encoded, encoding) === value
}

export function isLosslessDecoding(bytes: Uint8Array, decoded: string, encoding: string): boolean {
  return bytesEqual(encodeDbfText(decoded, encoding), bytes)
}

/** Encode complete characters until the next character would exceed the byte width. */
export function encodeDbfTextTruncated(
  value: string,
  encoding: string,
  maxLength: number,
): Uint8Array {
  let prefix = ''
  let encoded: Uint8Array = new Uint8Array()
  for (const character of value) {
    const candidate = prefix + character
    const candidateBytes = encodeDbfText(candidate, encoding)
    if (candidateBytes.length > maxLength) {
      break
    }
    prefix = candidate
    encoded = candidateBytes
  }
  return encoded
}

export function decodeDbfText(bytes: Uint8Array, encoding: string): string {
  return iconv.decode(bytes, encoding)
}

/** 读取 null 结尾的定长文本字段（DBF 字段名等），按指定编码解码。 */
export function decodeNullTerminatedText(
  bytes: Uint8Array,
  start: number,
  length: number,
  encoding: string,
): string {
  let end = start
  const limit = start + length
  while (end < limit && bytes[end] !== 0) {
    end += 1
  }
  return decodeDbfText(bytes.subarray(start, end), encoding)
}

export interface DbfCharacterTextResult {
  /** 解码后的文本；尾部截断时为去掉不完整序列后的完整字符文本。 */
  text: string
  /** 内容以一个被字段边界截断的多字节字符结尾（不完整部分已丢弃）。 */
  tailTruncated: boolean
  /** 字节序列无法按当前编码恢复（存在非尾部的无效序列）。 */
  invalid: boolean
}

/**
 * 解码 C 字段内容，并容忍字段边界截断的多字节字符。
 *
 * 真实世界的 DBF 常把超长文本直接按字段宽度截断存储，最后一个多字节字符
 * 只剩前半个字节。解码失败时逐字节尝试去掉尾部不完整序列（最多 3 字节，
 * 覆盖 GBK/GB18030 的序列宽度），保留所有完整字符；尾部的不完整半个字符
 * 在源文件中已不存在，丢弃不构成额外损失。
 */
export function decodeDbfCharacterField(
  bytes: Uint8Array,
  encoding: string,
): DbfCharacterTextResult {
  const decoded = decodeDbfText(bytes, encoding)
  if (isLosslessDecoding(bytes, decoded, encoding)) {
    return { text: decoded, tailTruncated: false, invalid: false }
  }
  const maxDrop = Math.min(3, bytes.length)
  for (let drop = 1; drop <= maxDrop; drop += 1) {
    const prefix = bytes.subarray(0, bytes.length - drop)
    const prefixText = decodeDbfText(prefix, encoding)
    if (isLosslessDecoding(prefix, prefixText, encoding)) {
      return { text: prefixText, tailTruncated: true, invalid: false }
    }
  }
  return { text: decoded, tailTruncated: false, invalid: true }
}
