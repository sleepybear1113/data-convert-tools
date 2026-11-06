import type { DatabaseEngine } from '../core/database/engine'
import { METADATA_TABLE_NAME, parseTableMetadata, serializeTableMetadata } from '../core/model/metadata-store'
import type { CellValue } from '../core/model/value'
import type { ColumnDataType, ColumnSchema, TableRow, TableSchema } from '../core/model/table'
import { chunkIterable } from '../core/utils/chunks'
import { quoteSqliteIdentifier, quoteSqliteString } from '../core/utils/identifiers'

const DEFAULT_BATCH_SIZE = 500
const MIN_SQLITE_INTEGER = -(1n << 63n)
const MAX_SQLITE_INTEGER = (1n << 63n) - 1n

export interface SqliteImportOptions {
  includeMetadata?: boolean
  batchSize?: number
  onProgress?(completed: number, total: number): void
}

export async function importTableIntoSqlite(
  engine: DatabaseEngine,
  schema: TableSchema,
  source: { recordCount: number; rows: AsyncIterable<TableRow> },
  options: SqliteImportOptions = {},
): Promise<number> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE
  let transactionOpen = false
  let imported = 0

  try {
    await engine.execute('BEGIN IMMEDIATE')
    transactionOpen = true
    await engine.execute(createTableSql(schema))

    for await (const batch of chunkIterable(source.rows, batchSize)) {
      await engine.execute(insertBatchSql(schema, batch))
      imported += batch.length
      options.onProgress?.(imported, source.recordCount)
    }

    if (imported !== source.recordCount) {
      throw new Error(`Import row count mismatch: expected ${source.recordCount}, received ${imported}`)
    }

    if (options.includeMetadata !== false) {
      await saveTableMetadata(engine, schema)
    }

    await engine.execute('COMMIT')
    transactionOpen = false
    return imported
  } catch (error) {
    if (transactionOpen) {
      try {
        await engine.execute('ROLLBACK')
      } catch {
        // Preserve the original import error.
      }
    }
    throw error
  }
}

export async function saveTableMetadata(
  engine: DatabaseEngine,
  schema: TableSchema,
): Promise<void> {
  const tableName = quoteSqliteIdentifier(METADATA_TABLE_NAME)
  await engine.execute(`
    CREATE TABLE IF NOT EXISTS ${tableName} (
      table_name TEXT PRIMARY KEY,
      payload TEXT NOT NULL
    )
  `)
  await engine.execute(`
    INSERT INTO ${tableName} (table_name, payload)
    VALUES (${quoteSqliteString(schema.name)}, ${quoteSqliteString(serializeTableMetadata(schema))})
    ON CONFLICT(table_name) DO UPDATE SET payload = excluded.payload
  `)
}

export async function readTableMetadata(
  engine: DatabaseEngine,
  tableName: string,
): Promise<TableSchema | undefined> {
  let resultId: string | undefined

  try {
    const execution = await engine.execute(`
      SELECT table_name, payload
      FROM ${quoteSqliteIdentifier(METADATA_TABLE_NAME)}
      WHERE table_name = ${quoteSqliteString(tableName)}
    `)
    resultId = execution.statements.find((statement) => statement.resultId)?.resultId
    if (!resultId) return undefined

    const page = await engine.getResultPage({ resultId, offset: 0, limit: 1 })
    const payload = page.rows[0]?.[1]
    return typeof payload === 'string' ? parseTableMetadata(payload) : undefined
  } catch (error) {
    if (error instanceof Error && /no such table/i.test(error.message)) return undefined
    throw error
  } finally {
    if (resultId) await engine.releaseResult(resultId)
  }
}

function createTableSql(schema: TableSchema): string {
  if (schema.columns.length === 0) throw new Error('Cannot import a table with zero columns')
  const columns = schema.columns
    .map((column) => `${quoteSqliteIdentifier(column.name)} ${sqliteType(column.dataType)}`)
    .join(', ')
  return `CREATE TABLE ${quoteSqliteIdentifier(schema.name)} (${columns})`
}

function insertBatchSql(schema: TableSchema, rows: readonly TableRow[]): string {
  const columnNames = schema.columns
    .map((column) => quoteSqliteIdentifier(column.name))
    .join(', ')
  const values = rows.map((row) => {
    if (row.length !== schema.columns.length) {
      throw new Error(`Row has ${row.length} values but schema has ${schema.columns.length} columns`)
    }
    return `(${row.map((value, index) => sqlLiteral(value, schema.columns[index])).join(', ')})`
  }).join(', ')

  return `INSERT INTO ${quoteSqliteIdentifier(schema.name)} (${columnNames}) VALUES ${values}`
}

function sqliteType(type: ColumnDataType): string {
  switch (type) {
    case 'integer':
    case 'boolean':
      return 'INTEGER'
    case 'float':
      return 'REAL'
    case 'binary':
      return 'BLOB'
    default:
      // Decimal, date/time, unknown and high-precision values remain text by design.
      return 'TEXT'
  }
}

function sqlLiteral(value: CellValue, column: ColumnSchema): string {
  if (value === null) return 'NULL'

  switch (typeof value) {
    case 'string':
      return quoteSqliteString(value)
    case 'boolean':
      return value ? '1' : '0'
    case 'number': {
      if (!Number.isFinite(value)) throw new Error(`Non-finite number in column ${column.name}`)
      if (column.dataType === 'integer' && !Number.isSafeInteger(value)) {
        throw new Error(`Unsafe integer in column ${column.name}; map it as exact text instead`)
      }
      return String(value)
    }
    case 'bigint': {
      if (column.dataType === 'integer'
        && (value < MIN_SQLITE_INTEGER || value > MAX_SQLITE_INTEGER)) {
        throw new RangeError(`Integer outside SQLite int64 range in column ${column.name}`)
      }
      return quoteSqliteString(value.toString())
    }
    case 'object':
      if (value instanceof Uint8Array) {
        return `X'${Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('')}'`
      }
  }

  throw new Error(`Unsupported value in column ${column.name}`)
}
