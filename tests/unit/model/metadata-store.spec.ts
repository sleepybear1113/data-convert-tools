import { describe, expect, it } from 'vitest'

import { parseTableMetadata, serializeTableMetadata } from '../../../src/core/model/metadata-store'
import type { TableSchema } from '../../../src/core/model/table'

describe('table metadata persistence', () => {
  it('preserves schema and source bytes', () => {
    const table: TableSchema = {
      id: 'table-1',
      name: 'sample',
      columns: [{
        id: 'column-1',
        name: 'VALUE',
        dataType: 'integer',
        nullable: true,
      }],
      source: {
        format: 'dbf',
        fileVersion: 0x30,
        languageDriver: 0x7a,
        encoding: 'gbk',
        headerLength: 100,
        recordLength: 20,
        trailingHeader: new Uint8Array([0, 1, 255]),
      },
    }

    const restored = parseTableMetadata(serializeTableMetadata(table))
    expect(restored).toEqual(table)
  })
})
