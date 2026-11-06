import { describe, expect, it } from 'vitest'

import { CsvFormatError, decodeCsv, readCsv, writeCsv } from '../../../src/core/formats/csv'
import type { TableSchema } from '../../../src/core/model/table'

function schema(names: readonly string[] = ['id', 'text']): TableSchema {
  return {
    id: 'test',
    name: 'test',
    columns: names.map((name, index) => ({
      id: `c${index}`,
      name,
      dataType: 'unknown',
      nullable: true,
    })),
  }
}

describe('CSV adapter - quotes, embedded lines, encodings and BOM', () => {
  it('parses quotes, escaped quotes, delimiters and embedded newlines without dynamic typing', () => {
    const result = readCsv(
      'id,name,note,empty\r\n001,"A,1","line 1\r\nline 2",""\r\n002,"say ""hi""",plain,',
      { encoding: 'utf-8', hasHeader: true },
    )

    expect(result.schema.columns.map((column) => column.name)).toEqual(['id', 'name', 'note', 'empty'])
    expect(result.rows).toEqual([
      ['001', 'A,1', 'line 1\r\nline 2', ''],
      ['002', 'say "hi"', 'plain', ''],
    ])
    expect(result.meta.delimiter).toBe(',')
    expect(result.meta.lineEnding).toBe('\r\n')
  })

  it('round-trips GBK Chinese with custom delimiters and LF output', () => {
    const bytes = writeCsv(schema(['编号', '内容']), [
      ['001', '中文;分号'],
      ['002', '换行\n和"引号"'],
    ], {
      encoding: 'gbk',
      bom: false,
      delimiter: ';',
      lineEnding: '\n',
    })

    expect(Array.from(bytes.subarray(0, 3))).not.toEqual([0xef, 0xbb, 0xbf])
    const result = readCsv(bytes, { encoding: 'gbk', delimiter: ';' })
    expect(result.schema.columns.map((column) => column.name)).toEqual(['编号', '内容'])
    expect(result.rows).toEqual([
      ['001', '中文;分号'],
      ['002', '换行\n和"引号"'],
    ])
  })

  it('writes UTF-8 with BOM by default and removes exactly one BOM when reading', () => {
    const bytes = writeCsv(schema(), [['001', '中文']])
    expect(Array.from(bytes.subarray(0, 3))).toEqual([0xef, 0xbb, 0xbf])

    const result = readCsv(bytes)
    expect(result.meta.bom).toBe(true)
    expect(result.schema.columns[0].name).toBe('id')
    expect(result.rows[0]).toEqual(['001', '中文'])
    expect(decodeCsv('\ufeff\ufeffa').text).toBe('\ufeffa')
  })

  it('supports UTF-8 without BOM and explicit tab/CR parsing options', () => {
    const bytes = writeCsv(schema(), [['1', 'x']], { bom: false })
    expect(Array.from(bytes.subarray(0, 3))).toEqual(Array.from(new TextEncoder().encode('id,')))

    const result = readCsv('a\tb\r1\t"x\ty"', {
      delimiter: '\t',
      lineEnding: '\r',
    })
    expect(result.rows).toEqual([['1', 'x\ty']])
  })

  it('preserves duplicate headers and pads short rows with NULL instead of empty strings', () => {
    const result = readCsv('a,a,\n1,2\n3,4,5,6', { sampleSize: 1 })
    expect(result.schema.columns.map((column) => column.name)).toEqual(['a', 'a', '', ''])
    expect(result.rows).toEqual([['1', '2', null, null]])
    expect(result.meta.truncated).toBe(true)
    expect(result.diagnostics.some((item) => item.code === 'CSV_SAMPLE_LIMIT')).toBe(true)

    const noHeader = readCsv('1,2\n3', { hasHeader: false })
    expect(noHeader.schema.columns.map((column) => column.name)).toEqual(['Column1', 'Column2'])
    expect(noHeader.rows).toEqual([['1', '2'], ['3', null]])
  })

  it('supports a custom quote and escape character', () => {
    const bytes = writeCsv(schema(['text']), [[`it's "quoted"`]], {
      quoteChar: `'`,
      bom: false,
    })
    const result = readCsv(bytes, { quoteChar: `'` })
    expect(result.rows).toEqual([[`it's "quoted"`]])
  })

  it('rejects lossy GBK export in strict mode', () => {
    expect(() => writeCsv(schema(['text']), [['😀']], { encoding: 'gbk' })).toThrowError(CsvFormatError)
    try {
      writeCsv(schema(['text']), [['😀']], { encoding: 'gbk' })
    } catch (error) {
      expect((error as CsvFormatError).code).toBe('CSV_ENCODING_ERROR')
    }
  })

  it('returns parser diagnostics and rejects zero-column export', () => {
    const malformed = readCsv('a,b\n"unterminated,2')
    expect(malformed.diagnostics.length).toBeGreaterThan(0)
    expect(() => writeCsv(schema([]), [])).toThrowError(/zero columns/u)
  })
})
