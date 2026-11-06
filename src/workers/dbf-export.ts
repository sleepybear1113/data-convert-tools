import { ArrayBufferDbfWriter } from '../core/dbf/writer'
import { languageDriverForEncoding } from '../core/dbf/encoding'
import type { DbfFieldDescriptor, DbfFieldType } from '../core/dbf/types'
import { isSupportedDbfFieldType } from '../core/dbf/validate'
import type { ExportOptions } from '../core/model/conversion'
import type { TableSchema } from '../core/model/table'
import type { SelectionReader } from './selection'

/**
 * Preserve an original DBF schema when the selected columns still contain every
 * original business field. Returns undefined so the caller can use inference instead.
 */
export async function writeOriginalDbfIfPossible(
  selection: SelectionReader,
  schema: TableSchema,
  options: ExportOptions,
): Promise<Uint8Array | undefined> {
  const source = schema.source
  if (source?.format !== 'dbf' || !source.fieldDescriptors?.length) return undefined
  if (new Set(selection.columns).size !== selection.columns.length) return undefined

  const fields: DbfFieldDescriptor[] = []
  const columnIndexes: number[] = []

  for (const stored of source.fieldDescriptors) {
    if (!isSupportedDbfFieldType(stored.type as DbfFieldType)) return undefined
    if (stored.system && stored.name.toLowerCase() !== '_nullflags') return undefined

    const field: DbfFieldDescriptor = {
      name: stored.name,
      type: stored.type as DbfFieldType,
      length: stored.length,
      decimalPlaces: stored.decimalPlaces,
      flags: stored.flags,
      nullable: stored.nullable,
      system: stored.system,
    }
    fields.push(field)

    if (field.system) {
      columnIndexes.push(-1)
      continue
    }

    const columnIndex = selection.columns.indexOf(field.name)
    if (columnIndex < 0) return undefined
    columnIndexes.push(columnIndex)
  }

  const deletedIndex = source.deletedColumnName
    ? selection.columns.indexOf(source.deletedColumnName)
    : -1
  const encoding = options.encoding ?? source.encoding
  const languageDriver = options.encoding && options.encoding !== source.encoding
    ? languageDriverForEncoding(options.encoding) ?? 0
    : source.languageDriver

  return new ArrayBufferDbfWriter().write(fields, {
    recordCount: selection.recordCount,
    records: {
      async *[Symbol.asyncIterator]() {
        for await (const row of selection.rows) {
          yield {
            values: fields.map((field, index) =>
              columnIndexes[index] < 0
                ? new Uint8Array(field.length)
                : row[columnIndexes[index]]
            ),
            deleted: deletedIndex >= 0 && Boolean(row[deletedIndex]),
          }
        }
      },
    },
  }, {
    fileVersion: source.fileVersion,
    encoding,
    languageDriver,
    strict: options.strict,
    trailingHeader: source.trailingHeader,
  })
}
