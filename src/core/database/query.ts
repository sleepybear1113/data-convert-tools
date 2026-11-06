import type { Diagnostic } from '../model/diagnostic'
import type { TableRow } from '../model/table'

export interface SqlStatementResult {
  resultId?: string
  columns: readonly string[]
  rowsAffected?: number
  totalRows?: number
}

export interface SqlExecutionResult {
  statements: readonly SqlStatementResult[]
  durationMs: number
  diagnostics: readonly Diagnostic[]
}

export interface ResultPageRequest {
  resultId: string
  offset: number
  limit: number
}

export interface QueryResultPage {
  resultId: string
  columns: readonly string[]
  rows: readonly TableRow[]
  offset: number
  totalRows?: number
}
