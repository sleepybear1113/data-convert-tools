import type { Diagnostic } from '../model/diagnostic'
import type { DbfFieldDescriptor } from './types'

export interface DbfValidationResult {
  fields: readonly DbfFieldDescriptor[]
  diagnostics: readonly Diagnostic[]
  canWrite: boolean
}

const FIXED_LENGTHS: Partial<Record<DbfFieldDescriptor['type'], number>> = {
  Y: 8,
  I: 4,
  L: 1,
  D: 8,
  T: 8,
  B: 8,
}

const SUPPORTED_TYPES = new Set(['C', 'N', 'F', 'Y', 'I', 'L', 'D', 'T', 'B', '0'])

export function isSupportedDbfFieldType(type: DbfFieldDescriptor['type']): boolean {
  return SUPPORTED_TYPES.has(type)
}

export function expectedFixedFieldLength(type: DbfFieldDescriptor['type']): number | undefined {
  return FIXED_LENGTHS[type]
}

export function requiredNullFlagLength(fields: readonly DbfFieldDescriptor[]): number {
  let bits = 0
  for (const field of fields) {
    if (field.type !== '0' && field.nullable) {
      bits += 1
    }
  }
  return Math.ceil(bits / 8)
}

export function validateDbfFields(fields: readonly DbfFieldDescriptor[]): DbfValidationResult {
  const diagnostics: Diagnostic[] = []
  const normalized = fields.map((field, index) => {
    const flags = field.flags ?? 0
    const result: DbfFieldDescriptor = {
      ...field,
      flags,
      nullable: field.nullable || (flags & 0x02) !== 0,
      system: field.system || (flags & 0x01) !== 0,
    }
    const location = { columnIndex: index, columnName: field.name }
    if (!SUPPORTED_TYPES.has(result.type)) {
      diagnostics.push({
        code: 'DBF_UNSUPPORTED_FIELD_TYPE',
        severity: 'error',
        message: `字段 ${result.name} 的 DBF 类型 ${result.type} 不受支持`,
        location,
      })
    }
    if (!Number.isInteger(result.length) || result.length < 0 || result.length > 255) {
      diagnostics.push({
        code: 'DBF_INVALID_FIELD_LENGTH',
        severity: 'error',
        message: `字段 ${result.name} 的字节长度无效`,
        location,
      })
    }
    const fixedLength = FIXED_LENGTHS[result.type]
    if (fixedLength !== undefined && result.length !== fixedLength) {
      diagnostics.push({
        code: 'DBF_INVALID_FIELD_LENGTH',
        severity: 'error',
        message: `${result.type} 类型字段 ${result.name} 必须为 ${fixedLength} 字节`,
        location,
      })
    }
    if (['C', 'N', 'F'].includes(result.type) && result.length === 0) {
      diagnostics.push({
        code: 'DBF_INVALID_FIELD_LENGTH',
        severity: 'error',
        message: `${result.type} 类型字段 ${result.name} 的宽度不能为 0`,
        location,
      })
    }
    if (!Number.isInteger(result.decimalPlaces) || result.decimalPlaces < 0 || result.decimalPlaces > 255) {
      diagnostics.push({
        code: 'DBF_INVALID_DECIMAL_PLACES',
        severity: 'error',
        message: `字段 ${result.name} 的小数位无效`,
        location,
      })
    }
    if (!Number.isInteger(flags) || flags < 0 || flags > 255) {
      diagnostics.push({
        code: 'DBF_INVALID_FIELD_FLAGS',
        severity: 'error',
        message: `字段 ${result.name} 的标志位无效`,
        location,
      })
    }
    return result
  })
  return {
    fields: normalized,
    diagnostics,
    canWrite: diagnostics.every((diagnostic) => diagnostic.severity !== 'error'),
  }
}
