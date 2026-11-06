import initSqlJs, { type SqlJsStatic } from 'sql.js'

import { SqlJsEngine } from './sqljs-engine'

/** sql.js resolves its own dist/sql-wasm.wasm through node:fs in Node. */
export function loadNodeSqlJs(): Promise<SqlJsStatic> {
  return initSqlJs()
}

/** Node/Vitest entry point; deliberately has no Vite ?url import. */
export function createNodeSqlJsEngine(): SqlJsEngine {
  return new SqlJsEngine({ loadSqlJs: loadNodeSqlJs })
}
