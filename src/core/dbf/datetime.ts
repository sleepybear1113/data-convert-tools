export interface DbfDateParts {
  year: number
  month: number
  day: number
}

export interface DbfDateTimeParts extends DbfDateParts {
  hour: number
  minute: number
  second: number
  millisecond: number
}

const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/
const DATE_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/

function pad(value: number, size: number): string {
  return String(value).padStart(size, '0')
}

function integer(value: number, name: string): void {
  if (!Number.isInteger(value)) {
    throw new Error(`${name} 必须为整数`)
  }
}

export function isValidDbfDate({ year, month, day }: DbfDateParts): boolean {
  integer(year, 'year')
  integer(month, 'month')
  integer(day, 'day')
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1) {
    return false
  }
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return day <= days[month - 1]
}

function assertDate(parts: DbfDateParts): void {
  if (!isValidDbfDate(parts)) {
    throw new Error(`无效的 DBF 日历日期：${parts.year}-${parts.month}-${parts.day}`)
  }
}

/** DBF date values are calendar values and must not be passed through UTC Date conversion. */
export function formatDbfDate(parts: DbfDateParts): string {
  assertDate(parts)
  return `${pad(parts.year, 4)}${pad(parts.month, 2)}${pad(parts.day, 2)}`
}

export function formatDateOnly(parts: DbfDateParts): string {
  assertDate(parts)
  return `${pad(parts.year, 4)}-${pad(parts.month, 2)}-${pad(parts.day, 2)}`
}

export function parseDbfDate(value: string): DbfDateParts | null {
  if (/^[ 0]+$/.test(value)) {
    return null
  }
  if (!/^\d{8}$/.test(value)) {
    throw new Error('DBF 日期必须为 8 位 YYYYMMDD 数字')
  }
  const parts = {
    year: Number(value.slice(0, 4)),
    month: Number(value.slice(4, 6)),
    day: Number(value.slice(6, 8)),
  }
  assertDate(parts)
  return parts
}

export function parseDateOnly(value: string): DbfDateParts {
  const match = DATE_ONLY_PATTERN.exec(value)
  if (!match) {
    throw new Error('日期值必须使用 YYYY-MM-DD 格式')
  }
  const parts = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) }
  assertDate(parts)
  return parts
}

export function formatDbfDateTime(parts: DbfDateTimeParts): string {
  assertDate(parts)
  for (const [name, value] of [
    ['hour', parts.hour],
    ['minute', parts.minute],
    ['second', parts.second],
    ['millisecond', parts.millisecond],
  ] as const) {
    integer(value, name)
  }
  if (
    parts.hour < 0 || parts.hour > 23
    || parts.minute < 0 || parts.minute > 59
    || parts.second < 0 || parts.second > 59
    || parts.millisecond < 0 || parts.millisecond > 999
  ) {
    throw new Error('无效的 DBF 时间')
  }
  return `${formatDateOnly(parts)}T${pad(parts.hour, 2)}:${pad(parts.minute, 2)}:${pad(parts.second, 2)}.${pad(parts.millisecond, 3)}`
}

/** Parse a timezone-less ISO date/time. Offset and Z suffixes are deliberately rejected. */
export function parseDbfDateTime(value: string): DbfDateTimeParts {
  const match = DATE_TIME_PATTERN.exec(value)
  if (!match) {
    throw new Error('日期时间值必须为不含时区的 ISO 格式 YYYY-MM-DDTHH:mm:ss.SSS')
  }
  const parts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4] ?? 0),
    minute: Number(match[5] ?? 0),
    second: Number(match[6] ?? 0),
    millisecond: Number((match[7] ?? '').padEnd(3, '0') || 0),
  }
  formatDbfDateTime(parts)
  return parts
}

/** Gregorian calendar date to Julian day number, without using Date or a timezone. */
export function julianDayFromDate(parts: DbfDateParts): number {
  assertDate(parts)
  const a = Math.floor((14 - parts.month) / 12)
  const year = parts.year + 4800 - a
  const month = parts.month + 12 * a - 3
  return parts.day
    + Math.floor((153 * month + 2) / 5)
    + 365 * year
    + Math.floor(year / 4)
    - Math.floor(year / 100)
    + Math.floor(year / 400)
    - 32045
}

/** Julian day number to Gregorian calendar date, valid for DBF's positive day range. */
export function dateFromJulianDay(julianDay: number): DbfDateParts {
  integer(julianDay, 'Julian day')
  if (julianDay < 1) {
    throw new Error('儒略日必须为正数')
  }
  const a = julianDay + 32044
  const b = Math.floor((4 * a + 3) / 146097)
  const c = a - Math.floor((146097 * b) / 4)
  const d = Math.floor((4 * c + 3) / 1461)
  const e = c - Math.floor((1461 * d) / 4)
  const month = Math.floor((5 * e + 2) / 153)
  const parts = {
    day: e - Math.floor((153 * month + 2) / 5) + 1,
    month: month + 3 - 12 * Math.floor(month / 10),
    year: 100 * b + d - 4800 + Math.floor(month / 10),
  }
  assertDate(parts)
  return parts
}

export function dateTimeToJulian(parts: DbfDateTimeParts): {
  julianDay: number
  milliseconds: number
} {
  formatDbfDateTime(parts)
  return {
    julianDay: julianDayFromDate(parts),
    milliseconds: ((parts.hour * 60 + parts.minute) * 60 + parts.second) * 1000
      + parts.millisecond,
  }
}

export function dateTimeFromJulian(julianDay: number, milliseconds: number): DbfDateTimeParts {
  integer(milliseconds, 'milliseconds')
  if (milliseconds < 0 || milliseconds >= 86_400_000) {
    throw new Error('DBF 毫秒数必须在 0 到 86399999 之间')
  }
  const date = dateFromJulianDay(julianDay)
  const hour = Math.floor(milliseconds / 3_600_000)
  const minute = Math.floor((milliseconds % 3_600_000) / 60_000)
  const second = Math.floor((milliseconds % 60_000) / 1000)
  return { ...date, hour, minute, second, millisecond: milliseconds % 1000 }
}
