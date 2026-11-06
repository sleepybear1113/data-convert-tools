import { describe, expect, it } from 'vitest'

import { detectFileFormat } from '../../../src/services/file-open'
import { sanitizeFileName } from '../../../src/services/file-save'

describe('file format detection', () => {
  it('recognizes supported extensions', () => {
    expect(detectFileFormat('DATA.DBF')).toBe('dbf')
    expect(detectFileFormat('database.sqlite3')).toBe('sqlite')
    expect(detectFileFormat('book.xlsx')).toBe('xlsx')
    expect(detectFileFormat('data.csv')).toBe('csv')
  })

  it('rejects unknown extensions', () => {
    expect(detectFileFormat('data.txt')).toBeUndefined()
  })
})

describe('sanitizeFileName', () => {
  it('removes path and control characters', () => {
    expect(sanitizeFileName('a/b\\c:d*.dbf')).toBe('a_b_c_d_.dbf')
  })

  it('uses a fallback for empty names', () => {
    expect(sanitizeFileName('...')).toBe('export')
  })
})
