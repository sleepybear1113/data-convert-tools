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
    throw new Error(`Unsupported DBF character encoding: ${encoding}`)
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
