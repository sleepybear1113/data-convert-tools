import type { DatabaseEngine } from '../core/database/engine'
import type { WorkerHandlers } from './dispatch'

type SqliteHandlers = Pick<
  WorkerHandlers,
  'workspace:reset' | 'sqlite:open' | 'sqlite:execute' | 'sqlite:page' | 'sqlite:schema'
>

export function createSqliteHandlers(engine: DatabaseEngine): SqliteHandlers {
  let ready = engine.open()

  const getEngine = async (): Promise<DatabaseEngine> => {
    await ready
    return engine
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
  }
}
