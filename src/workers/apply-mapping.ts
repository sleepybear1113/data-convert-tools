import type { ImportMapping } from '../core/model/conversion'
import type { TableRow, TableSchema } from '../core/model/table'
import type { Diagnostic } from '../core/model/diagnostic'

export interface MappableTableSource {
  schema: TableSchema
  recordCount: number
  rows: AsyncIterable<TableRow>
  diagnostics: readonly Diagnostic[]
}

export function applyImportMapping<TSource extends MappableTableSource>(
  source: TSource,
  mapping: ImportMapping,
): TSource {
  const tableName = mapping.targetTableName.trim()
  if (!tableName) throw new Error('Target table name cannot be empty')
  if (mapping.columns.length === 0) throw new Error('At least one column must be selected')

  const included = mapping.columns.filter((column) => column.included)
  if (included.length === 0) throw new Error('At least one column must be selected')

  const sourceIndexes = included.map((column) => {
    if (!Number.isInteger(column.sourceIndex)
      || column.sourceIndex < 0
      || column.sourceIndex >= source.schema.columns.length) {
      throw new Error(`Invalid source column index: ${column.sourceIndex}`)
    }
    return column.sourceIndex
  })
  if (new Set(sourceIndexes).size !== sourceIndexes.length) {
    throw new Error('The same source column cannot be mapped more than once')
  }

  const names = new Set<string>()
  const columns = included.map((column, index) => {
    const sourceColumn = source.schema.columns[column.sourceIndex]
    const name = column.targetName.trim()
    if (!name) throw new Error(`Target column ${index + 1} has an empty name`)
    const key = name.toLowerCase()
    if (names.has(key)) throw new Error(`Duplicate target column name: ${name}`)
    names.add(key)

    return {
      ...sourceColumn,
      id: `column_${index}`,
      name,
      dataType: column.targetType ?? sourceColumn.dataType,
    }
  })
  const schema: TableSchema = {
    ...source.schema,
    id: tableName,
    name: tableName,
    columns,
  }

  return {
    ...source,
    schema,
    rows: {
      async *[Symbol.asyncIterator]() {
        for await (const row of source.rows) {
          yield sourceIndexes.map((index) => row[index])
        }
      },
    },
  }
}
