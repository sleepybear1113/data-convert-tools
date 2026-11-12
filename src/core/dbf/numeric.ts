import Decimal from 'decimal.js'

import type { CellValue } from '../model/value'

const DECIMAL_TEXT = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i
const INT32_MIN = -0x8000_0000n
const INT32_MAX = 0x7fff_ffffn
const INT64_MIN = -(1n << 63n)
const INT64_MAX = (1n << 63n) - 1n

export function decimalFromDbfText(value: string): Decimal {
  const text = value.trim()
  if (!DECIMAL_TEXT.test(text)) {
    throw new Error(`无效的 DBF 数值：${JSON.stringify(value)}`)
  }
  const decimal = new Decimal(text)
  if (!decimal.isFinite()) {
    throw new Error('DBF 数值必须为有限数')
  }
  return decimal
}

export function decimalFromValue(value: unknown, label: string, strict: boolean): Decimal {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`${label} 必须为有限数`)
    }
    if (strict && Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new Error(`${label} 是精度不安全的整数；请传入精确的字符串或 bigint`)
    }
    return new Decimal(value)
  }
  if (typeof value === 'bigint') {
    return new Decimal(value.toString())
  }
  if (typeof value === 'string') {
    try {
      return decimalFromDbfText(value)
    } catch {
      throw new Error(`${label} 不是有效的数值`)
    }
  }
  if (Decimal.isDecimal(value)) {
    if (!value.isFinite()) {
      throw new Error(`${label} 必须为有限数`)
    }
    return value
  }
  throw new Error(`${label} 必须是数字、bigint、十进制字符串或 Decimal`)
}

/** Return a Number only for commonly safe values; retain exact decimal text otherwise. */
export function decimalToCellValue(decimal: Decimal, exactText = decimal.toString()): CellValue {
  if (decimal.sd() <= 15) {
    const value = decimal.toNumber()
    if (Number.isFinite(value) && (!decimal.isInteger() || Number.isSafeInteger(value))) {
      return value
    }
  }
  return exactText
}

export function decimalFromNumericField(value: string): {
  decimal: Decimal
  cellValue: CellValue
} {
  const decimal = decimalFromDbfText(value)
  return { decimal, cellValue: decimalToCellValue(decimal, value.trim()) }
}

export function decimalFromCurrency(scaled: bigint): {
  decimal: Decimal
  cellValue: CellValue
} {
  const negative = scaled < 0n
  const digits = (negative ? -scaled : scaled).toString().padStart(5, '0')
  const exactText = `${negative ? '-' : ''}${digits.slice(0, -4)}.${digits.slice(-4)}`
  const decimal = new Decimal(exactText)
  return { decimal, cellValue: decimalToCellValue(decimal, exactText) }
}

export function formatNumericField(
  value: unknown,
  length: number,
  decimalPlaces: number,
  strict: boolean,
  label: string,
): string {
  const decimal = decimalFromValue(value, label, strict)
  const rounded = decimal.toDecimalPlaces(decimalPlaces, Decimal.ROUND_HALF_UP)
  if (strict && !rounded.eq(decimal)) {
    throw new Error(`${label} 的小数位超过 ${decimalPlaces} 位`)
  }
  // 优先固定小数位格式（与 VFP 显示约定一致，如 N(20,4) 的 "1.5000"）；
  // 若该格式放不下字段宽度，退回自然表示（整数不带小数点、去掉无效尾随零，
  // 如 N(4,1) 的 110 写 "110" 而非 "110.0"），仍放不下才报溢出。
  let text = rounded.toFixed(decimalPlaces)
  if (text.length > length) {
    text = normalizedDecimalText(rounded)
  }
  if (text.length > length) {
    throw new Error(`${label} 需要 ${text.length} 字节，但字段宽度为 ${length}`)
  }
  return text
}

function normalizedDecimalText(decimal: Decimal): string {
  const text = decimal.toString()
  // Decimal 对极大/极小值会使用指数表示，DBF 文本必须展开为定点表示。
  if (!/e/i.test(text)) return text
  return decimal.toFixed(decimal.dp())
}

export function integerFieldValue(
  value: unknown,
  strict: boolean,
  label: string,
): number {
  const scaled = decimalFromValue(value, label, strict)
  const rounded = scaled.toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
  if (strict && !rounded.eq(scaled)) {
    throw new Error(`${label} 必须是 int32 整数`)
  }
  const integer = BigInt(rounded.toFixed(0))
  if (integer < INT32_MIN || integer > INT32_MAX) {
    throw new Error(`${label} 超出 int32 范围`)
  }
  return Number(integer)
}

export function currencyFieldValue(
  value: unknown,
  strict: boolean,
  label: string,
): bigint {
  const decimal = decimalFromValue(value, label, strict)
  const rounded = decimal.toDecimalPlaces(4, Decimal.ROUND_HALF_UP)
  if (strict && !rounded.eq(decimal)) {
    throw new Error(`${label} 的小数位超过货币字段允许的 4 位`)
  }
  // Removing the four-place decimal point is exact and independent of Decimal.precision.
  const integer = BigInt(rounded.toFixed(4).replace('.', ''))
  if (integer < INT64_MIN || integer > INT64_MAX) {
    throw new Error(`${label} 超出 int64 货币字段范围`)
  }
  return integer
}
