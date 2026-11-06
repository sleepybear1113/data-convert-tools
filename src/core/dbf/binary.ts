export function readNullTerminatedAscii(
  bytes: Uint8Array,
  start: number,
  length: number,
): string {
  const end = start + length
  let terminator = start

  while (terminator < end && bytes[terminator] !== 0) {
    terminator += 1
  }

  return String.fromCharCode(...bytes.subarray(start, terminator))
}

export function writeNullTerminatedAscii(
  bytes: Uint8Array,
  start: number,
  length: number,
  value: string,
): void {
  bytes.fill(0, start, start + length)
  for (let index = 0; index < value.length && index < length; index += 1) {
    bytes[start + index] = value.charCodeAt(index) & 0x7f
  }
}

export function ascii(bytes: Uint8Array): string {
  let result = ''
  for (const byte of bytes) {
    result += String.fromCharCode(byte)
  }
  return result
}

export function writeAscii(bytes: Uint8Array, value: string, start = 0): void {
  for (let index = 0; index < value.length; index += 1) {
    bytes[start + index] = value.charCodeAt(index) & 0xff
  }
}

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false
    }
  }
  return true
}
