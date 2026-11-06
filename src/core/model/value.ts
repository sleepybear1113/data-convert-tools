/** ISO date without a timezone, formatted as YYYY-MM-DD. */
export type DateOnlyValue = string

/** ISO date-time whose timezone semantics are defined by source metadata. */
export type DateTimeValue = string

/** Exact decimal text used when a Number could lose precision. */
export type DecimalValue = string

export type CellValue =
  | null
  | string
  | number
  | bigint
  | boolean
  | Uint8Array
