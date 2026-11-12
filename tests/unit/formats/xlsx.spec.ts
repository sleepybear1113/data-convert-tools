import { describe, expect, it } from 'vitest'
import { utils } from 'xlsx'
import type { WorkBook } from 'xlsx'

import {
  SheetJsXlsxAdapter,
  XlsxFormatError,
  createXlsxWorkbook,
  readXlsx,
  readXlsxTable,
  readXlsxWorkbook,
  writeXlsx,
  writeXlsxWorkbook,
} from '../../../src/core/formats/xlsx'
import type { TableSchema } from '../../../src/core/model/table'

function workbookWithSheets(): WorkBook {
  const workbook = utils.book_new()
  utils.book_append_sheet(workbook, utils.aoa_to_sheet([['not this sheet']]), 'Other')
  const sheet = utils.aoa_to_sheet([
    ['metadata', null, null, null],
    ['id', 'name', 'date', 'amount'],
    ['001', 'Alice', new Date(Date.UTC(2024, 1, 29)), 12.5],
    ['002', 'Bob', new Date(Date.UTC(2024, 1, 29, 12, 34, 56, 123)), 7],
  ], { cellDates: true, UTC: true })
  utils.book_append_sheet(workbook, sheet, 'Data')
  return workbook
}

const outputSchema: TableSchema = {
  id: 'output',
  name: 'Result',
  columns: [
    { id: 'id', name: 'id', dataType: 'string', nullable: false },
    { id: 'value', name: 'value', dataType: 'decimal', nullable: true },
  ],
}

describe('XLSX SheetJS adapter', () => {
  it('reads a selected real workbook sheet, header row, columns and calendar dates', () => {
    const bytes = writeXlsxWorkbook(workbookWithSheets())
    const result = readXlsx(bytes, {
      sheetName: 'Data',
      headerRow: 2,
      columns: [0, 2, 'name'],
    })

    expect(result.sheetNames).toEqual(['Other', 'Data'])
    expect(result.schema.columns.map((column) => column.name)).toEqual(['id', 'date', 'name'])
    expect(result.rows).toEqual([
      ['001', '2024-02-29', 'Alice'],
      ['002', '2024-02-29 12:34:56.123', 'Bob'],
    ])
    expect(result.schema.source).toMatchObject({ format: 'xlsx', sheetName: 'Data' })
  })

  it('uses formula cached values and never recalculates formulas', () => {
    const workbook = utils.book_new()
    const sheet = utils.aoa_to_sheet([
      ['a', 'b', 'total', 'missing'],
      [2, 3, null, null],
    ])
    sheet.C2 = { t: 'n', v: 12345, f: 'A2+B2' }
    sheet.D2 = { t: 'n', f: 'A2+B2' }
    utils.book_append_sheet(workbook, sheet, 'Formula')

    const bytes = writeXlsxWorkbook(workbook)
    const workbook2 = readXlsxWorkbook(bytes)
    expect(workbook2.Sheets.Formula.C2.f).toBe('A2+B2')
    expect(workbook2.Sheets.Formula.C2.v).toBe(12345)

    const result = readXlsxTable(workbook2)
    expect(result.rows[0]).toEqual([2, 3, 12345, null])
    expect(result.rows[0][2]).not.toBe(5)
  })

  it('supports headerless reads and writes big integers as exact text', () => {
    const workbook = utils.book_new()
    utils.book_append_sheet(workbook, utils.aoa_to_sheet([['001', 2], ['003', 4]]), 'Raw')
    const headerless = readXlsxTable(workbook, { hasHeader: false })
    expect(headerless.schema.columns.map((column) => column.name)).toEqual(['Column1', 'Column2'])
    expect(headerless.rows).toEqual([['001', 2], ['003', 4]])

    const bytes = writeXlsx(outputSchema, [
      [900719925474099312345n, '1.234567890123456789'],
      [null, 2.5],
    ], { sheetName: 'Exact', includeHeader: true })
    const result = readXlsx(bytes, { sheetName: 'Exact' })
    expect(result.rows[0][0]).toBe('900719925474099312345')
    expect(result.rows[0][1]).toBe('1.234567890123456789')
    expect(result.rows[1]).toEqual([null, 2.5])
  })

  it('keeps duplicate and blank headers column-addressable', () => {
    const workbook = utils.book_new()
    utils.book_append_sheet(workbook, utils.aoa_to_sheet([
      ['a', 'a', ''],
      [1, 2, 3],
    ]), 'Duplicates')
    const result = readXlsxTable(workbook)
    expect(result.schema.columns.map((column) => column.name)).toEqual(['a', 'a', ''])
    expect(result.rows).toEqual([[1, 2, 3]])
    expect(new Set(result.schema.columns.map((column) => column.id)).size).toBe(3)
  })

  it('exposes the workbook adapter and validates selection and values', () => {
    const adapter = new SheetJsXlsxAdapter()
    const workbook = createXlsxWorkbook(outputSchema, [['x', 1]], { sheetName: 'Data' })
    const bytes = adapter.write(workbook)
    expect(adapter.read(bytes).SheetNames).toEqual(['Data'])
    expect(() => readXlsxTable(workbook, { sheetName: 'Missing' })).toThrowError(XlsxFormatError)
    expect(() => readXlsxTable(workbook, { columns: [99] })).toThrowError(/越界/u)
    expect(() => writeXlsx(outputSchema, [[new Uint8Array([1]), 1]])).toThrowError(/二进制值/u)
  })
})
