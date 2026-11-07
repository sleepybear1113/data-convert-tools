import initSqlJs, {
  type Database,
  type SqlJsStatic,
  type SqlValue,
  type Statement,
} from 'sql.js'

import type { Diagnostic } from '../model/diagnostic'
import { METADATA_TABLE_NAME, parseTableMetadata } from '../model/metadata-store'
import type { TableRow } from '../model/table'
import type { DatabaseEngine } from './engine'
import type {
  QueryResultPage,
  ResultPageRequest,
  SqlExecutionResult,
  SqlStatementResult,
} from './query'
import type { DatabaseSchema } from './schema'

const INTERNAL_RESULT_PREFIX = '__dct_result_'
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER)
const MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER)

type RawSqlValue = SqlValue | bigint

type BigIntStatement = Statement & {
  get(params: null, options: { useBigInt: true }): RawSqlValue[]
}

interface StoredResult {
  columns: readonly string[]
  tableName: string
  totalRows: number
}

export type SqlJsLoader = () => Promise<SqlJsStatic>

export interface SqlJsEngineOptions {
  /** Override WASM initialization in browsers or tests. */
  loadSqlJs?: SqlJsLoader
}

/** An execution failure with the same diagnostics shape as a successful result. */
export class SqlJsExecutionError extends Error {
  readonly statementIndex: number
  readonly statementSql?: string
  readonly result: SqlExecutionResult

  constructor(
    message: string,
    statementIndex: number,
    statementSql: string | undefined,
    result: SqlExecutionResult,
    cause: unknown,
  ) {
    super(message, { cause })
    this.name = 'SqlJsExecutionError'
    this.statementIndex = statementIndex
    this.statementSql = statementSql
    this.result = result
  }

  get diagnostics(): readonly Diagnostic[] {
    return this.result.diagnostics
  }
}

/**
 * SQLite engine backed by sql.js.
 *
 * Query rows are copied one at a time into a separate in-memory result database.
 * The UI can therefore fetch bounded pages without keeping a second full JS array
 * copy, and user transactions cannot roll back an already materialized result.
 */
export class SqlJsEngine implements DatabaseEngine {
  private readonly loadSqlJs: SqlJsLoader
  private sqlJsPromise: Promise<SqlJsStatic> | undefined
  private database: Database | undefined
  private resultDatabase: Database | undefined
  private readonly results = new Map<string, StoredResult>()
  private nextResultId = 1

  constructor(options: SqlJsEngineOptions = {}) {
    this.loadSqlJs = options.loadSqlJs ?? (() => initSqlJs())
  }

  async open(source?: Uint8Array): Promise<void> {
    const SQL = await this.getSqlJs()
    let database: Database | undefined
    let resultDatabase: Database | undefined

    try {
      // sql.js owns the bytes it opens; copying also detaches us from caller reuse.
      database = new SQL.Database(source === undefined ? undefined : new Uint8Array(source))
      resultDatabase = new SQL.Database()
    } catch (error) {
      resultDatabase?.close()
      database?.close()
      throw error
    }

    this.closeDatabases()
    this.database = database
    this.resultDatabase = resultDatabase
  }

  async execute(sql: string): Promise<SqlExecutionResult> {
    const database = this.requireDatabase()
    const startedAt = now()
    const statements: SqlStatementResult[] = []
    let statementIndex = 0
    let statementSql: string | undefined

    try {
      for (const statement of database.iterateStatements(sql)) {
        statementSql = statement.getSQL()
        const columns = statement.getColumnNames()
        const modifiesData = isDataModificationStatement(statementSql)

        if (columns.length === 0) {
          while (statement.step()) {
            // Drain the statement even if a future SQLite statement gains rows.
          }
          statements.push({
            columns,
            rowsAffected: modifiesData ? database.getRowsModified() : 0,
          })
        } else {
          const stored = this.materializeResult(statement, columns)
          const result: SqlStatementResult = {
            resultId: stored.resultId,
            columns,
            totalRows: stored.totalRows,
          }
          if (modifiesData) {
            result.rowsAffected = database.getRowsModified()
          }
          statements.push(result)
        }

        statementIndex += 1
        statementSql = undefined
      }
    } catch (cause) {
      const reason = errorMessage(cause)
      const message = `SQLite statement ${statementIndex + 1} failed: ${reason}`
      const diagnostic: Diagnostic = {
        code: 'SQLITE_STATEMENT_ERROR',
        severity: 'error',
        message,
        details: {
          statementIndex,
          ...(statementSql === undefined ? {} : { statementSql }),
        },
      }
      const result: SqlExecutionResult = {
        statements,
        durationMs: elapsedSince(startedAt),
        diagnostics: [diagnostic],
      }
      throw new SqlJsExecutionError(message, statementIndex, statementSql, result, cause)
    }

    return {
      statements,
      durationMs: elapsedSince(startedAt),
      diagnostics: [],
    }
  }

  async getResultPage(request: ResultPageRequest): Promise<QueryResultPage> {
    const resultDatabase = this.requireResultDatabase()
    const stored = this.results.get(request.resultId)
    if (stored === undefined) {
      throw new Error(`Unknown or released SQLite resultId: ${request.resultId}`)
    }
    validatePageRequest(request)

    const statement = resultDatabase.prepare(
      `SELECT * FROM ${quoteIdentifier(stored.tableName)} LIMIT ? OFFSET ?`,
    )
    const rows: TableRow[] = []
    try {
      statement.bind([request.limit, request.offset])
      while (statement.step()) {
        rows.push(readRow(statement))
      }
    } finally {
      statement.free()
    }

    return {
      resultId: request.resultId,
      columns: stored.columns,
      rows,
      offset: request.offset,
      totalRows: stored.totalRows,
    }
  }

  async releaseResult(resultId: string): Promise<void> {
    const stored = this.results.get(resultId)
    if (stored === undefined) {
      return
    }

    this.requireResultDatabase().run(
      `DROP TABLE IF EXISTS ${quoteIdentifier(stored.tableName)}`,
    )
    this.results.delete(resultId)
  }

  async getSchema(): Promise<DatabaseSchema> {
    const database = this.requireDatabase()
    const objects = database.exec(`
      SELECT name, type
      FROM sqlite_master
      WHERE type IN ('table', 'view')
        AND substr(name, 1, 6) <> '__dct_'
        AND substr(name, 1, 7) <> 'sqlite_'
      ORDER BY name COLLATE NOCASE, name
    `)

    const rows = objects[0]?.values ?? []
    const sourceFileNames = this.readSourceFileNames()
    const tables = rows.map(([rawName]) => {
      const name = String(rawName)
      const info = database.exec(`PRAGMA table_info(${quoteIdentifier(name)})`)
      const values = info[0]?.values ?? []
      const countStatement = database.prepare(
        `SELECT COUNT(*) FROM ${quoteIdentifier(name)}`,
      )
      let rowCount = 0
      try {
        if (countStatement.step()) rowCount = Number(countStatement.get([])[0])
      } finally {
        countStatement.free()
      }
      return {
        name,
        columns: values.map((column) => ({
          name: String(column[1]),
          declaredType: String(column[2] ?? ''),
          nullable: Number(column[3]) === 0,
          primaryKey: Number(column[5]) > 0,
        })),
        rowCount,
        ...(sourceFileNames.get(name.toLowerCase())
          ? { sourceFileName: sourceFileNames.get(name.toLowerCase()) }
          : {}),
      }
    })

    return { tables }
  }

  /** 读取导入元数据中的来源文件名（表名小写 → 文件名）。元数据表不存在时返回空表。 */
  private readSourceFileNames(): Map<string, string> {
    const database = this.requireDatabase()
    const names = new Map<string, string>()
    try {
      const info = database.exec(
        `SELECT table_name, payload FROM ${quoteIdentifier(METADATA_TABLE_NAME)}`,
      )
      for (const row of info[0]?.values ?? []) {
        const tableName = row[0]
        const payload = row[1]
        if (typeof tableName !== 'string' || typeof payload !== 'string') continue
        try {
          const source = parseTableMetadata(payload).source
          const fileName = source && 'fileName' in source ? source.fileName : undefined
          if (fileName) names.set(tableName.toLowerCase(), fileName)
        } catch {
          // 单条元数据损坏不应影响整体 schema 读取。
        }
      }
    } catch {
      // 元数据表不存在（未导入过文件）时静默返回空表。
    }
    return names
  }

  async exportDatabase(): Promise<Uint8Array> {
    return new Uint8Array(this.requireDatabase().export())
  }

  async close(): Promise<void> {
    this.closeDatabases()
  }

  private async getSqlJs(): Promise<SqlJsStatic> {
    if (this.sqlJsPromise === undefined) {
      const loading = this.loadSqlJs()
      this.sqlJsPromise = loading
      loading.catch(() => {
        if (this.sqlJsPromise === loading) {
          this.sqlJsPromise = undefined
        }
      })
    }
    return this.sqlJsPromise
  }

  private requireDatabase(): Database {
    if (this.database === undefined) {
      throw new Error('SQLite database is not open. Call open() first.')
    }
    return this.database
  }

  private requireResultDatabase(): Database {
    if (this.resultDatabase === undefined) {
      throw new Error('SQLite database is not open. Call open() first.')
    }
    return this.resultDatabase
  }

  private closeDatabases(): void {
    this.results.clear()
    const resultDatabase = this.resultDatabase
    const database = this.database
    this.resultDatabase = undefined
    this.database = undefined

    try {
      resultDatabase?.close()
    } finally {
      database?.close()
    }
  }

  private materializeResult(
    statement: Statement,
    columns: readonly string[],
  ): { resultId: string; totalRows: number } {
    const resultDatabase = this.requireResultDatabase()
    const resultNumber = this.nextResultId++
    const resultId = `result_${resultNumber}`
    const tableName = `${INTERNAL_RESULT_PREFIX}${resultNumber}`
    const columnDefinitions = columns
      .map((_, index) => quoteIdentifier(resultColumnName(index)))
      .join(', ')
    const inserters = new Map<string, Statement>()
    let totalRows = 0
    let transactionOpen = false

    try {
      resultDatabase.run(
        `CREATE TEMP TABLE ${quoteIdentifier(tableName)} (${columnDefinitions})`,
      )
      resultDatabase.run('BEGIN TRANSACTION')
      transactionOpen = true

      while (statement.step()) {
        const row = readRawRow(statement)
        const bigIntMask = row.map((value) => typeof value === 'bigint').join(',')
        let insert = inserters.get(bigIntMask)
        if (insert === undefined) {
          const expressions = row
            .map((value) => (typeof value === 'bigint' ? 'CAST(? AS INTEGER)' : '?'))
            .join(', ')
          insert = resultDatabase.prepare(
            `INSERT INTO ${quoteIdentifier(tableName)} VALUES (${expressions})`,
          )
          inserters.set(bigIntMask, insert)
        }
        insert.run(row.map((value) =>
          typeof value === 'bigint' ? value.toString() : value,
        ))
        totalRows += 1
      }

      resultDatabase.run('COMMIT')
      transactionOpen = false
    } catch (error) {
      if (transactionOpen) {
        try {
          resultDatabase.run('ROLLBACK')
        } catch {
          // Preserve the error that prevented materialization.
        }
      }
      try {
        resultDatabase.run(`DROP TABLE IF EXISTS ${quoteIdentifier(tableName)}`)
      } catch {
        // Closing the result database will reclaim any failed partial result.
      }
      throw error
    } finally {
      for (const insert of inserters.values()) {
        insert.free()
      }
    }

    this.results.set(resultId, { columns, tableName, totalRows })
    return { resultId, totalRows }
  }
}

function readRawRow(statement: Statement): RawSqlValue[] {
  return (statement as BigIntStatement).get(null, { useBigInt: true })
}

function readRow(statement: Statement): TableRow {
  return readRawRow(statement).map((value) => {
    if (typeof value === 'bigint') {
      return value <= MAX_SAFE_BIGINT && value >= MIN_SAFE_BIGINT ? Number(value) : value
    }
    if (value instanceof Uint8Array) {
      return new Uint8Array(value)
    }
    return value
  })
}

function resultColumnName(index: number): string {
  return `column_${index}`
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`
}

function validatePageRequest(request: ResultPageRequest): void {
  if (!Number.isSafeInteger(request.offset) || request.offset < 0) {
    throw new RangeError('Result page offset must be a non-negative safe integer.')
  }
  if (!Number.isSafeInteger(request.limit) || request.limit < 0) {
    throw new RangeError('Result page limit must be a non-negative safe integer.')
  }
}

function isDataModificationStatement(sql: string): boolean {
  const withoutLeadingComments = sql
    .replace(/^(?:\s+|--[^\r\n]*(?:\r?\n|$)|\/\*[\s\S]*?\*\/)+/, '')
  if (/^(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(withoutLeadingComments)) {
    return true
  }
  // SQLite does not allow DML inside a CTE, so a DML keyword after WITH is the
  // outer statement. This also covers the common WITH ... UPDATE/INSERT form.
  return /^WITH\b/i.test(withoutLeadingComments)
    && /\b(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(withoutLeadingComments)
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

function now(): number {
  return globalThis.performance?.now() ?? Date.now()
}

function elapsedSince(startedAt: number): number {
  return Math.max(0, now() - startedAt)
}
