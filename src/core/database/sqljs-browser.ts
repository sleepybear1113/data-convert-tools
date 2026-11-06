import initSqlJs, { type SqlJsStatic } from 'sql.js'
import sqlWasmUrl from 'sql.js/dist/sql-wasm.wasm?url'

import { SqlJsEngine } from './sqljs-engine'

/** Load the locally bundled WASM asset in a browser Worker (no CDN). */
export function loadBrowserSqlJs(): Promise<SqlJsStatic> {
  return initSqlJs({
    locateFile: (file) => file.endsWith('.wasm') ? sqlWasmUrl : file,
  })
}

/** Entry point intended for the data Worker rather than Vue components. */
export function createBrowserSqlJsEngine(): SqlJsEngine {
  return new SqlJsEngine({ loadSqlJs: loadBrowserSqlJs })
}
