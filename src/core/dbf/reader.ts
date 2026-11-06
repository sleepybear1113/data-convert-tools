import type { CellValue } from '../model/value'
import type { Diagnostic } from '../model/diagnostic'
import { ascii, readNullTerminatedAscii } from './binary'
import {
  dateTimeFromJulian,
  formatDbfDateTime,
  formatDateOnly,
  parseDbfDate,
} from './datetime'
import {
  assertDbfEncoding,
  decodeDbfText,
  DEFAULT_DBF_ENCODING,
  encodingForLanguageDriver,
  isLosslessDecoding,
} from './encoding'
import { decimalFromCurrency, decimalFromNumericField } from './numeric'
import type {
  DbfFieldDescriptor,
  DbfFieldType,
  DbfReadOptions,
  DbfReadResult,
  DbfRecord,
} from './types'
import { expectedFixedFieldLength, requiredNullFlagLength } from './validate'

export interface DbfReader {
  read(input: ArrayBuffer, options?: DbfReadOptions): Promise<DbfReadResult>
}

const FIELD_TYPES = new Set(['C', 'N', 'F', 'Y', 'I', 'L', 'D', 'T', 'B', 'M', 'G', 'V', 'Q', '0'])
const SUPPORTED_VALUE_TYPES = new Set(['C', 'N', 'F', 'Y', 'I', 'L', 'D', 'T', 'B', '0'])

interface FieldLayout {
  field: DbfFieldDescriptor
  offset: number
  nullBit?: number
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function trimPaddedCharacterBytes(bytes: Uint8Array): Uint8Array {
  let end = bytes.length
  while (end > 0 && (bytes[end - 1] === 0x20 || bytes[end - 1] === 0)) {
    end -= 1
  }
  return bytes.subarray(0, end)
}

function decodeField(
  view: DataView,
  bytes: Uint8Array,
  recordOffset: number,
  layout: FieldLayout,
  encoding: string,
): CellValue {
  const { field, offset } = layout
  const start = recordOffset + offset
  const raw = bytes.subarray(start, start + field.length)
  switch (field.type) {
    case 'C': {
      const textBytes = trimPaddedCharacterBytes(raw)
      const decoded = decodeDbfText(textBytes, encoding)
      if (!isLosslessDecoding(textBytes, decoded, encoding)) {
        throw new Error(`Field ${field.name} contains invalid ${encoding} byte sequences`)
      }
      return decoded
    }
    case 'N':
    case 'F': {
      const text = ascii(raw).replace(/^[ \0]+|[ \0]+$/g, '')
      return text === '' ? null : decimalFromNumericField(text).cellValue
    }
    case 'Y':
      return decimalFromCurrency(view.getBigInt64(start, true)).cellValue
    case 'I':
      return view.getInt32(start, true)
    case 'L': {
      const value = String.fromCharCode(raw[0]).toUpperCase()
      if (['T', 'Y'].includes(value)) return true
      if (['F', 'N'].includes(value)) return false
      if (['?', ' ', '\0'].includes(value)) return null
      throw new Error(`Field ${field.name} has invalid logical byte 0x${raw[0].toString(16)}`)
    }
    case 'D': {
      const date = parseDbfDate(ascii(raw))
      return date === null ? null : formatDateOnly(date)
    }
    case 'T': {
      const julianDay = view.getInt32(start, true)
      const milliseconds = view.getInt32(start + 4, true)
      if (julianDay === 0 && milliseconds === 0) return null
      return formatDbfDateTime(dateTimeFromJulian(julianDay, milliseconds))
    }
    case 'B':
      return view.getFloat64(start, true)
    case '0':
      return raw.slice()
    default:
      return raw.slice()
  }
}

/** ArrayBuffer/DataView Visual FoxPro DBF reader. */
export class ArrayBufferDbfReader implements DbfReader {
  async read(input: ArrayBuffer, options: DbfReadOptions = {}): Promise<DbfReadResult> {
    const bytes = new Uint8Array(input)
    if (bytes.length < 32) {
      throw new Error('DBF input is shorter than its 32-byte file header')
    }
    const view = new DataView(input)
    const fileVersion = view.getUint8(0)
    if (fileVersion !== 0x30) {
      throw new Error(`Unsupported DBF version 0x${fileVersion.toString(16)}; expected VFP 0x30`)
    }
    const recordCount = view.getUint32(4, true)
    const headerLength = view.getUint16(8, true)
    const recordLength = view.getUint16(10, true)
    const languageDriver = view.getUint8(29)
    const strict = options.strict ?? false
    const encoding = options.encoding
      ?? encodingForLanguageDriver(languageDriver)
      ?? DEFAULT_DBF_ENCODING
    assertDbfEncoding(encoding)
    const diagnostics: Diagnostic[] = []

    if (headerLength < 33 || headerLength > bytes.length) {
      throw new Error(`Invalid DBF header length ${headerLength}`)
    }

    const fields: DbfFieldDescriptor[] = []
    let descriptorOffset = 32
    let terminatorOffset = -1
    while (descriptorOffset < headerLength) {
      if (bytes[descriptorOffset] === 0x0d) {
        terminatorOffset = descriptorOffset
        break
      }
      if (descriptorOffset + 32 > headerLength) {
        throw new Error('DBF field descriptor crosses the header boundary')
      }
      const rawType = String.fromCharCode(bytes[descriptorOffset + 11])
      const type = (FIELD_TYPES.has(rawType) ? rawType : 'unknown') as DbfFieldType
      const flags = bytes[descriptorOffset + 18]
      const field: DbfFieldDescriptor = {
        name: readNullTerminatedAscii(bytes, descriptorOffset, 11).trim(),
        type,
        length: bytes[descriptorOffset + 16],
        decimalPlaces: bytes[descriptorOffset + 17],
        flags,
        nullable: (flags & 0x02) !== 0,
        system: (flags & 0x01) !== 0,
      }
      if (!field.name) {
        throw new Error(`DBF field ${fields.length} has an empty name`)
      }
      const fixedLength = expectedFixedFieldLength(type)
      if (fixedLength !== undefined && field.length !== fixedLength) {
        throw new Error(`${type} field ${field.name} must have length ${fixedLength}, got ${field.length}`)
      }
      if (['C', 'N', 'F'].includes(type) && field.length === 0) {
        throw new Error(`${type} field ${field.name} has zero length`)
      }
      if (!SUPPORTED_VALUE_TYPES.has(type)) {
        const diagnostic: Diagnostic = {
          code: 'DBF_UNSUPPORTED_FIELD_TYPE',
          severity: strict ? 'error' : 'warning',
          message: `Unsupported DBF field type ${rawType} for ${field.name}; returning raw bytes`,
          location: { columnIndex: fields.length, columnName: field.name },
        }
        if (strict) throw new Error(diagnostic.message)
        diagnostics.push(diagnostic)
      }
      fields.push(field)
      descriptorOffset += 32
    }
    if (terminatorOffset < 0) {
      throw new Error('DBF header has no 0x0d field descriptor terminator')
    }

    const layouts: FieldLayout[] = []
    let fieldOffset = 1
    for (const field of fields) {
      layouts.push({ field, offset: fieldOffset })
      fieldOffset += field.length
    }
    if (recordLength < fieldOffset) {
      throw new Error(`DBF record length ${recordLength} is smaller than field data length ${fieldOffset}`)
    }

    const nullFlagIndexes = fields
      .map((field, index) => ({ field, index }))
      .filter(({ field }) => field.type === '0' && field.name.toLowerCase() === '_nullflags')
    if (nullFlagIndexes.length > 1) {
      throw new Error('DBF header contains more than one _NullFlags field')
    }
    const nullFlagIndex = nullFlagIndexes[0]?.index
    let nullBit = 0
    for (const layout of layouts) {
      if (layout.field.type !== '0' && layout.field.nullable) {
        layout.nullBit = nullBit
        nullBit += 1
      }
    }
    const nullFlagLength = requiredNullFlagLength(fields)
    if (nullFlagIndex === undefined && nullFlagLength > 0) {
      diagnostics.push({
        code: 'DBF_NULL_FLAGS_MISSING',
        severity: 'warning',
        message: 'Nullable DBF fields have no _NullFlags system field; NULL bits cannot be recovered',
      })
    } else if (nullFlagIndex !== undefined && fields[nullFlagIndex].length < nullFlagLength) {
      const message = `_NullFlags is ${fields[nullFlagIndex].length} bytes; ${nullFlagLength} are required`
      if (strict) throw new Error(message)
      diagnostics.push({ code: 'DBF_NULL_FLAGS_SHORT', severity: 'warning', message })
    }

    const expectedEnd = headerLength + recordCount * recordLength
    let recordsToRead = recordCount
    if (expectedEnd > bytes.length) {
      if (strict) {
        throw new Error(`DBF is truncated: header declares ${recordCount} records of ${recordLength} bytes`)
      }
      let availableEnd = bytes.length
      if (availableEnd > headerLength && bytes[availableEnd - 1] === 0x1a) {
        availableEnd -= 1
      }
      recordsToRead = Math.max(0, Math.floor((availableEnd - headerLength) / recordLength))
      diagnostics.push({
        code: 'DBF_TRUNCATED_RECORDS',
        severity: 'warning',
        message: `DBF declares ${recordCount} records but only ${recordsToRead} complete records are present`,
      })
    } else if (expectedEnd < bytes.length) {
      if (bytes[expectedEnd] !== 0x1a) {
        const message = `Unexpected data follows the ${recordCount} declared DBF records`
        if (strict) throw new Error(message)
        diagnostics.push({ code: 'DBF_TRAILING_DATA', severity: 'warning', message })
      } else if (expectedEnd + 1 < bytes.length) {
        const message = 'Bytes follow the DBF 0x1a file terminator'
        if (strict) throw new Error(message)
        diagnostics.push({ code: 'DBF_DATA_AFTER_TERMINATOR', severity: 'warning', message })
      }
    }

    const trailingHeader = bytes.slice(terminatorOffset + 1, headerLength)
    const header = {
      fileVersion,
      languageDriver,
      recordCount,
      headerLength,
      recordLength,
      trailingHeader,
    }

    const readRecords = async function* (): AsyncGenerator<DbfRecord> {
      for (let rowIndex = 0; rowIndex < recordsToRead; rowIndex += 1) {
        const recordOffset = headerLength + rowIndex * recordLength
        const deletionFlag = bytes[recordOffset]
        let deleted = deletionFlag === 0x2a
        if (deletionFlag !== 0x20 && deletionFlag !== 0x2a) {
          const message = `Record ${rowIndex} has invalid deletion flag 0x${deletionFlag.toString(16)}`
          if (strict) throw new Error(message)
          diagnostics.push({
            code: 'DBF_INVALID_DELETION_FLAG',
            severity: 'warning',
            message,
            location: { rowIndex, byteOffset: recordOffset },
          })
          deleted = false
        }
        if (deleted && !options.includeDeleted) continue

        let nullFlags: Uint8Array | undefined
        if (nullFlagIndex !== undefined) {
          const layout = layouts[nullFlagIndex]
          const start = recordOffset + layout.offset
          nullFlags = bytes.subarray(start, start + layout.field.length)
        }
        const values: CellValue[] = []
        for (let columnIndex = 0; columnIndex < layouts.length; columnIndex += 1) {
          const layout = layouts[columnIndex]
          const bit = layout.nullBit
          const isNull = bit !== undefined
            && nullFlags !== undefined
            && Math.floor(bit / 8) < nullFlags.length
            && (nullFlags[Math.floor(bit / 8)] & (1 << (bit % 8))) !== 0
          if (isNull) {
            values.push(null)
            continue
          }
          try {
            values.push(decodeField(view, bytes, recordOffset, layout, encoding))
          } catch (error) {
            const message = `Record ${rowIndex}, field ${layout.field.name}: ${messageFor(error)}`
            if (strict) throw new Error(message)
            diagnostics.push({
              code: 'DBF_INVALID_FIELD_VALUE',
              severity: 'warning',
              message,
              location: {
                rowIndex,
                columnIndex,
                columnName: layout.field.name,
                byteOffset: recordOffset + layout.offset,
              },
            })
            values.push(null)
          }
        }
        yield {
          values,
          deleted,
          raw: bytes.slice(recordOffset, recordOffset + recordLength),
        }
      }
    }

    return { header, fields, records: readRecords(), diagnostics }
  }
}
