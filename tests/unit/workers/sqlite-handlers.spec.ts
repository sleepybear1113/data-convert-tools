import { afterEach, describe, expect, it } from 'vitest'

import { createNodeSqlJsEngine } from '../../../src/core/database/sqljs-node'
import type { SqlJsEngine } from '../../../src/core/database/sqljs-engine'
import { createSqliteHandlers } from '../../../src/workers/sqlite-handlers'

const engines: SqlJsEngine[] = []

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.close()))
})

describe('SQLite worker handlers', () => {
  it('executes, pages, exports, reopens and resets a workspace', async () => {
    const engine = createNodeSqlJsEngine()
    engines.push(engine)
    const handlers = createSqliteHandlers(engine)
    const context = { reportProgress: () => undefined }

    await handlers['workspace:reset']({}, context)
    await handlers['sqlite:execute']({
      sql: 'CREATE TABLE sample(id INTEGER, name TEXT); INSERT INTO sample VALUES (1, \'张三\'), (2, \'李四\');',
    }, context)
    const execution = await handlers['sqlite:execute']({ sql: 'SELECT * FROM sample ORDER BY id' }, context)
    const resultId = execution.statements[0].resultId!

    const page = await handlers['sqlite:page']({ resultId, offset: 1, limit: 1 }, context)
    expect(page.rows).toEqual([[2, '李四']])
    expect((await handlers['sqlite:schema']({}, context)).tables[0].name).toBe('sample')

    const bytes = await engine.exportDatabase()
    await handlers['sqlite:open']({ bytes }, context)
    expect((await handlers['sqlite:schema']({}, context)).tables[0].name).toBe('sample')

    await handlers['workspace:reset']({}, context)
    expect((await handlers['sqlite:schema']({}, context)).tables).toEqual([])
  })
})
