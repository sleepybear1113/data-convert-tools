import { createBrowserSqlJsEngine } from '../core/database/sqljs-browser'
import { attachWorkerHandlers } from './dispatch'
import type { WorkerScope } from './dispatch'
import { createWorkerHandlers } from './handlers'

const workerScope = self as unknown as WorkerScope
const engine = createBrowserSqlJsEngine()

attachWorkerHandlers(
  workerScope,
  createWorkerHandlers(engine, createBrowserSqlJsEngine),
)
