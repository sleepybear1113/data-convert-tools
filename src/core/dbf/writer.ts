import Decimal from 'decimal.js'

import type { CellValue } from '../model/value'
import { writeAscii } from './binary'
import {
  dateTimeToJulian,
  formatDbfDate,
  parseDateOnly,
  parseDbfDate,
  parseDbfDateTime,
} from './datetime'
import {
  assertDbfEncoding,
  decodeDbfText,
  DEFAULT_DBF_ENCODING,
  encodeDbfText,
  encodeDbfTextTruncated,
  isLosslessEncoding,
  languageDriverForEncoding,
} from './encoding'
import {
  currencyFieldValue,
  decimalFromValue,
  formatNumericField,
  integerFieldValue,
} from './numeric'
import type {
  DbfFieldDescriptor,
  DbfRecordSource,
  DbfWriteOptions,
} from './types'
import { requiredNullFlagLength, validateDbfFields } from './validate'

export interface DbfWriter {
  write(
    fields: readonly DbfFieldDescriptor[],
    source: DbfRecordSource,
    options: DbfWriteOptions,
  ): Promise<Uint8Array>
}

interface WriteLayout {
  field: DbfFieldDescriptor
  offset: number
  nullBit?: number
}

function writerFieldName(field: DbfFieldDescriptor, strict: boolean, encoding: string): string {
  const name = field.name
  if (!name || name.includes('\0')) {
    throw new Error(`DBF field name ${JSON.stringify(name)} must not be empty`)
  }
  const encoded = encodeDbfText(name, encoding)
  if (!isLosslessEncoding(name, encoded, encoding)) {
    throw new Error(`DBF field name ${JSON.stringify(name)} cannot be represented as ${encoding}`)
  }
  if (encoded.length > 10) {
    if (strict) throw new Error(`DBF field name ${name} exceeds ten encoded bytes`)
    return decodeDbfText(encodeDbfTextTruncated(name, encoding, 10), encoding)
  }
  return name
}

function defaultRecordValue(record: Uint8Array, field: DbfFieldDescriptor, offset: number): void {
  if (['C', 'N', 'F', 'D'].includes(field.type)) {
    record.fill(0x20, offset, offset + field.length)
  } else if (field.type === 'L') {
    record[offset] = 0x3f
  }
}

function encodeCharacter(
  record: Uint8Array,
  field: DbfFieldDescriptor,
  offset: number,
  value: CellValue | undefined,
  encoding: string,
  strict: boolean,
): void {
  if (typeof value !== 'string') {
    if (strict || value instanceof Uint8Array || typeof value === 'object') {
      throw new Error(`Character field ${field.name} requires a string`)
    }
    value = String(value)
  }
  let encoded = encodeDbfText(value, encoding)
  if (strict && !isLosslessEncoding(value, encoded, encoding)) {
    throw new Error(`Character field ${field.name} cannot be represented losslessly as ${encoding}`)
  }
  if (encoded.length > field.length) {
    if (strict) {
      throw new Error(`Character field ${field.name} needs ${encoded.length} bytes; width is ${field.length}`)
    }
    encoded = encodeDbfTextTruncated(value, encoding, field.length)
  }
  record.set(encoded, offset)
}

function encodeLogical(value: CellValue | undefined, field: DbfFieldDescriptor, strict: boolean): number {
  if (typeof value === 'boolean') return value ? 0x54 : 0x46
  if (typeof value === 'string' && /^[tTyYfFnN? ]$/.test(value)) {
    return value.toUpperCase().charCodeAt(0)
  }
  if (!strict && (value === 1 || value === 0)) return value === 1 ? 0x54 : 0x46
  throw new Error(`Logical field ${field.name} requires a boolean or T/F/Y/N value`)
}

function encodeDouble(
  view: DataView,
  offset: number,
  value: CellValue | undefined,
  field: DbfFieldDescriptor,
  strict: boolean,
): void {
  if (typeof value === 'number') {
    view.setFloat64(offset, value, true)
    return
  }
  const decimal = decimalFromValue(value, `Double field ${field.name}`, strict)
  const number = decimal.toNumber()
  if (strict && (!Number.isFinite(number) || !new Decimal(number).eq(decimal))) {
    throw new Error(`Double field ${field.name} would lose decimal precision; use a number or exact decimal text`)
  }
  view.setFloat64(offset, number, true)
}

/** JavaDBF-compatible VFP writer with exact decimal and NULL-flag handling. */
export class ArrayBufferDbfWriter implements DbfWriter {
  async write(
    inputFields: readonly DbfFieldDescriptor[],
    source: DbfRecordSource,
    options: DbfWriteOptions = {},
  ): Promise<Uint8Array> {
    const strict = options.strict ?? false
    const fileVersion = options.fileVersion ?? 0x30
    if (fileVersion !== 0x30) {
      throw new Error(`Unsupported DBF output version 0x${fileVersion.toString(16)}; expected 0x30`)
    }
    const encoding = options.encoding ?? DEFAULT_DBF_ENCODING
    assertDbfEncoding(encoding)
    if (!Number.isInteger(source.recordCount) || source.recordCount < 0 || source.recordCount > 0xffff_ffff) {
      throw new Error('DBF source recordCount must be a uint32')
    }

    const validation = validateDbfFields(inputFields)
    if (!validation.canWrite) {
      throw new Error(validation.diagnostics.find((item) => item.severity === 'error')?.message
        ?? 'Invalid DBF fields')
    }
    const fields = validation.fields.map((field) => ({ ...field }))
    let nullFlagIndex = fields.findIndex((field) => field.name.toLowerCase() === '_nullflags')
    if (nullFlagIndex >= 0 && fields[nullFlagIndex].type !== '0') {
      throw new Error('_NullFlags is reserved for the VFP type 0 system field')
    }
    const nullFlagLength = requiredNullFlagLength(fields)
    if (nullFlagIndex < 0 && nullFlagLength > 0) {
      fields.push({
        name: '_NullFlags',
        type: '0',
        length: nullFlagLength,
        decimalPlaces: 0,
        flags: 0x05,
        nullable: false,
        system: true,
      })
      nullFlagIndex = fields.length - 1
    } else if (nullFlagIndex >= 0) {
      const nullFlags = fields[nullFlagIndex]
      if (nullFlags.length < nullFlagLength) {
        if (strict) {
          throw new Error(`_NullFlags must contain at least ${nullFlagLength} bytes`)
        }
        nullFlags.length = nullFlagLength
      }
      nullFlags.flags = ((nullFlags.flags ?? 0) | 0x05) & ~0x02
      nullFlags.system = true
      nullFlags.nullable = false
    }

    const names = new Set<string>()
    const outputNames = fields.map((field) => {
      const name = writerFieldName(field, strict, encoding)
      const key = name.toLowerCase()
      if (names.has(key)) throw new Error(`Duplicate DBF field name ${name}`)
      names.add(key)
      return name
    })

    const layouts: WriteLayout[] = []
    let recordLength = 1
    let nullBit = 0
    for (const field of fields) {
      const layout: WriteLayout = { field, offset: recordLength }
      if (field.type !== '0' && field.nullable) {
        layout.nullBit = nullBit
        nullBit += 1
      }
      layouts.push(layout)
      recordLength += field.length
    }
    if (recordLength > 0xffff) throw new Error(`DBF record length ${recordLength} exceeds uint16`)
    const trailingHeader = options.trailingHeader?.slice() ?? new Uint8Array()
    const headerLength = 32 + fields.length * 32 + 1 + trailingHeader.length
    if (headerLength > 0xffff) throw new Error(`DBF header length ${headerLength} exceeds uint16`)

    const encodedRecords: Uint8Array[] = []
    let rowIndex = 0
    for await (const record of source.records) {
      const values = record.values
      if (strict && values.length !== inputFields.length) {
        throw new Error(`Record ${rowIndex} has ${values.length} values; expected ${inputFields.length}`)
      }
      const output = new Uint8Array(recordLength)
      const view = new DataView(output.buffer)
      output[0] = record.deleted ? 0x2a : 0x20
      for (const layout of layouts) defaultRecordValue(output, layout.field, layout.offset)

      for (let columnIndex = 0; columnIndex < layouts.length; columnIndex += 1) {
        const layout = layouts[columnIndex]
        const { field, offset } = layout
        const value = values[columnIndex]
        const isNullFlags = columnIndex === nullFlagIndex
        if (isNullFlags) continue
        const isNull = value === null || value === undefined
        if (isNull) {
          // writeNullAsBlank：非可空字段的 NULL 写为空白填充（还原源文件的空白语义）；
          // 非可空字段不占 _NullFlags 位，因此不会置位。可空字段的 NULL 仍写显式 .NULL.。
          const writeAsBlank = options.writeNullAsBlank && !field.nullable && field.type !== '0'
          if (!writeAsBlank && strict && !field.nullable && field.type !== '0') {
            throw new Error(`Record ${rowIndex}, field ${field.name} is NULL but is not nullable`)
          }
          continue
        }

        const label = `Record ${rowIndex}, field ${field.name}`
        switch (field.type) {
          case 'C':
            encodeCharacter(output, field, offset, value, encoding, strict)
            break
          case 'N':
          case 'F': {
            const text = formatNumericField(value, field.length, field.decimalPlaces, strict, label)
            writeAscii(output, text, offset + field.length - text.length)
            break
          }
          case 'Y':
            view.setBigInt64(offset, currencyFieldValue(value, strict, label), true)
            break
          case 'I':
            view.setInt32(offset, integerFieldValue(value, strict, label), true)
            break
          case 'L':
            output[offset] = encodeLogical(value, field, strict)
            break
          case 'D': {
            if (typeof value !== 'string') throw new Error(`${label} requires YYYY-MM-DD date text`)
            const date = /^\d{8}$/.test(value) ? parseDbfDate(value) : parseDateOnly(value)
            if (date === null) throw new Error(`${label} requires a non-empty date`)
            writeAscii(output, formatDbfDate(date), offset)
            break
          }
          case 'T': {
            if (typeof value !== 'string') throw new Error(`${label} requires timezone-less ISO date-time text`)
            const julian = dateTimeToJulian(parseDbfDateTime(value))
            view.setInt32(offset, julian.julianDay, true)
            view.setInt32(offset + 4, julian.milliseconds, true)
            break
          }
          case 'B':
            encodeDouble(view, offset, value, field, strict)
            break
          case '0': {
            if (!(value instanceof Uint8Array)) throw new Error(`${label} requires Uint8Array binary data`)
            if (strict && value.length > field.length) {
              throw new Error(`${label} exceeds its ${field.length}-byte system field`)
            }
            output.set(value.subarray(0, field.length), offset)
            break
          }
        }
      }

      if (nullFlagIndex >= 0) {
        const nullLayout = layouts[nullFlagIndex]
        for (let columnIndex = 0; columnIndex < layouts.length; columnIndex += 1) {
          const layout = layouts[columnIndex]
          if (layout.nullBit === undefined) continue
          const value = values[columnIndex]
          if (value === null || value === undefined) {
            output[nullLayout.offset + Math.floor(layout.nullBit / 8)] |= 1 << (layout.nullBit % 8)
          }
        }
      }
      encodedRecords.push(output)
      rowIndex += 1
    }

    if (strict && rowIndex !== source.recordCount) {
      throw new Error(`DBF source declared ${source.recordCount} records but yielded ${rowIndex}`)
    }
    const recordCount = strict ? source.recordCount : rowIndex
    const result = new Uint8Array(headerLength + recordCount * recordLength + 1)
    const view = new DataView(result.buffer)
    result[0] = fileVersion
    const now = new Date()
    result[1] = now.getFullYear() - 1900
    result[2] = now.getMonth() + 1
    result[3] = now.getDate()
    view.setUint32(4, recordCount, true)
    view.setUint16(8, headerLength, true)
    view.setUint16(10, recordLength, true)
    result[29] = options.languageDriver ?? languageDriverForEncoding(encoding) ?? 0
    for (let index = 0; index < fields.length; index += 1) {
      const descriptorOffset = 32 + index * 32
      const field = fields[index]
      // 字段名按文件编码写出（GBK 时支持中文名），其余字节保持 null 填充。
      const encodedName = encodeDbfText(outputNames[index] ?? '', encoding)
      result.set(encodedName.subarray(0, 11), descriptorOffset)
      result[descriptorOffset + 11] = field.type.charCodeAt(0)
      view.setUint32(descriptorOffset + 12, layouts[index].offset, true)
      result[descriptorOffset + 16] = field.length
      result[descriptorOffset + 17] = field.decimalPlaces
      result[descriptorOffset + 18] = ((field.flags ?? 0) & 0xfc)
        | (field.system ? 0x01 : 0)
        | (field.nullable ? 0x02 : 0)
    }
    result[32 + fields.length * 32] = 0x0d
    result.set(trailingHeader, 33 + fields.length * 32)
    for (let index = 0; index < encodedRecords.length; index += 1) {
      result.set(encodedRecords[index], headerLength + index * recordLength)
    }
    result[result.length - 1] = 0x1a
    return result
  }
}
