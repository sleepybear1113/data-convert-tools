import type { DatabaseEngine } from '../core/database/engine'
import { METADATA_TABLE_NAME } from '../core/model/metadata-store'
import { quoteSqliteIdentifier, quoteSqliteString } from '../core/utils/identifiers'
import type { WorkerHandlers } from './dispatch'

type SqliteHandlers = Pick<
  WorkerHandlers,
  | 'workspace:reset'
  | 'sqlite:open'
  | 'sqlite:execute'
  | 'sqlite:page'
  | 'sqlite:schema'
  | 'sqlite:drop-table'
  | 'sqlite:rename-table'
>

export function createSqliteHandlers(engine: DatabaseEngine): SqliteHandlers {
  let ready = engine.open()

  const getEngine = async (): Promise<DatabaseEngine> => {
    await ready
    return engine
  }

  /** 解析对象类型（table/view），并确保目标存在。 */
  const requireObjectKind = async (
    database: DatabaseEngine,
    name: string,
  ): Promise<'table' | 'view'> => {
    const execution = await database.execute(
      `SELECT type FROM sqlite_master WHERE name = ${quoteSqliteString(name)}`,
    )
    const resultId = execution.statements.find((statement) => statement.resultId)?.resultId
    if (!resultId) throw new Error(`Table not found: ${name}`)
    try {
      const page = await database.getResultPage({ resultId, offset: 0, limit: 1 })
      const kind = page.rows[0]?.[0]
      if (kind === 'table' || kind === 'view') return kind
    } finally {
      await database.releaseResult(resultId)
    }
    throw new Error(`Table not found: ${name}`)
  }

  return {
    'workspace:reset': async () => {
      ready = engine.open()
      await ready
      return { reset: true as const }
    },
    'sqlite:open': async ({ bytes }) => {
      ready = engine.open(bytes)
      await ready
      return engine.getSchema()
    },
    'sqlite:execute': async ({ sql }) => {
      const database = await getEngine()
      return database.execute(sql)
    },
    'sqlite:page': async (request) => {
      const database = await getEngine()
      return database.getResultPage(request)
    },
    'sqlite:schema': async () => {
      const database = await getEngine()
      return database.getSchema()
    },
    'sqlite:drop-table': async ({ tableName }) => {
      const database = await getEngine()
      const kind = await requireObjectKind(database, tableName)
      const quoted = quoteSqliteIdentifier(tableName)
      await database.execute(
        kind === 'view' ? `DROP VIEW ${quoted}` : `DROP TABLE ${quoted}`,
      )
      // 清理该表的导入元数据（若存在）。
      await database.execute(`
        DELETE FROM ${quoteSqliteIdentifier(METADATA_TABLE_NAME)}
        WHERE table_name = ${quoteSqliteString(tableName)}
      `).catch(() => undefined)
      return database.getSchema()
    },
    'sqlite:rename-table': async ({ tableName, newName }) => {
      const database = await getEngine()
      const target = newName.trim()
      if (!target) throw new Error('New table name must not be empty')
      if (target.toLowerCase() === tableName.toLowerCase()) {
        return database.getSchema()
      }
      const kind = await requireObjectKind(database, tableName)
      if (kind !== 'table') {
        throw new Error('视图暂不支持重命名，请删除后重新创建。')
      }
      const schema = await database.getSchema()
      const exists = schema.tables.some(
        (table) => table.name.toLowerCase() === target.toLowerCase(),
      )
      if (exists) throw new Error(`Target table already exists: ${target}`)

      await database.execute(
        `ALTER TABLE ${quoteSqliteIdentifier(tableName)} RENAME TO ${quoteSqliteIdentifier(target)}`,
      )
      // 同步元数据中的表名（若存在）。
      await database.execute(`
        UPDATE ${quoteSqliteIdentifier(METADATA_TABLE_NAME)}
        SET table_name = ${quoteSqliteString(target)}
        WHERE table_name = ${quoteSqliteString(tableName)}
      `).catch(() => undefined)
      return database.getSchema()
    },
  }
}
