import { describe, expect, it } from 'vitest'

import {
  dateFromJulianDay,
  dateTimeFromJulian,
  dateTimeToJulian,
  formatDbfDate,
  formatDbfDateTime,
  julianDayFromDate,
  parseDbfDateTime,
} from '../../../src/core/dbf/datetime'

describe('DBF calendar date and Julian date-time', () => {
  it('writes calendar values without using a timezone', () => {
    expect(formatDbfDate({ year: 2026, month: 2, day: 6 })).toBe('20260206')
    expect(julianDayFromDate({ year: 2000, month: 1, day: 1 })).toBe(2_451_545)
    expect(dateFromJulianDay(2_451_545)).toEqual({ year: 2000, month: 1, day: 1 })
  })

  it('round-trips Gregorian leap years and calendar boundaries', () => {
    for (const date of [
      { year: 1, month: 1, day: 1 },
      { year: 1900, month: 2, day: 28 },
      { year: 2000, month: 2, day: 29 },
      { year: 2024, month: 2, day: 29 },
      { year: 9999, month: 12, day: 31 },
    ]) {
      expect(dateFromJulianDay(julianDayFromDate(date))).toEqual(date)
    }
    expect(() => julianDayFromDate({ year: 1900, month: 2, day: 29 })).toThrow()
  })

  it('converts Julian day plus milliseconds without a timezone', () => {
    const parts = parseDbfDateTime('2000-01-01T23:59:59.999')
    expect(dateTimeToJulian(parts)).toEqual({ julianDay: 2_451_545, milliseconds: 86_399_999 })
    expect(formatDbfDateTime(dateTimeFromJulian(2_451_545, 86_399_999)))
      .toBe('2000-01-01T23:59:59.999')
    expect(() => parseDbfDateTime('2000-01-01T00:00:00Z')).toThrow(/timezone-less/)
    expect(() => dateTimeFromJulian(2_451_545, 86_400_000)).toThrow()
  })
})
