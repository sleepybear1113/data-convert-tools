import type {
  QueryResultPage,
  ResultPageRequest,
  SqlExecutionResult,
} from './query'
import type { DatabaseSchema } from './schema'

export interface DatabaseEngine {
  open(source?: Uint8Array): Promise<void>
  execute(sql: string): Promise<SqlExecutionResult>
  getResultPage(request: ResultPageRequest): Promise<QueryResultPage>
  releaseResult(resultId: string): Promise<void>
  getSchema(): Promise<DatabaseSchema>
  exportDatabase(): Promise<Uint8Array>
  close(): Promise<void>
}
