import type {
  QueryResultPage,
  ResultPageRequest,
  SqlExecutionResult,
} from '../core/database/query'
import type { DatabaseSchema } from '../core/database/schema'
import type { DbfReadOptions } from '../core/dbf/types'
import type { CsvReadOptions } from '../core/formats/csv'
import type { XlsxReadOptions } from '../core/formats/xlsx'
import type { ExportOptions, ImportMapping } from '../core/model/conversion'
import type { ExportFileResult, TablePreview, WorkspaceImportResult } from '../core/model/work'

interface RequestEnvelope<TType, TPayload> {
  id: string
  type: TType
  payload: TPayload
}

interface FilePayload {
  buffer: ArrayBuffer
  fileName?: string
}

interface ImportOptions<TOptions> {
  options: TOptions
  tableName?: string
  mapping?: ImportMapping
}

export type WorkerRequest =
  | RequestEnvelope<'workspace:reset', Record<string, never>>
  | RequestEnvelope<'dbf:preview', FilePayload & { options: DbfReadOptions }>
  | RequestEnvelope<'dbf:import', FilePayload & ImportOptions<DbfReadOptions>>
  | RequestEnvelope<'xlsx:preview', FilePayload & { options: XlsxReadOptions }>
  | RequestEnvelope<'xlsx:import', FilePayload & ImportOptions<XlsxReadOptions>>
  | RequestEnvelope<'csv:preview', FilePayload & { options: CsvReadOptions }>
  | RequestEnvelope<'csv:import', FilePayload & ImportOptions<CsvReadOptions>>
  | RequestEnvelope<'sqlite:open', { bytes: Uint8Array }>
  | RequestEnvelope<'sqlite:execute', { sql: string }>
  | RequestEnvelope<'sqlite:page', ResultPageRequest>
  | RequestEnvelope<'sqlite:schema', Record<string, never>>
  | RequestEnvelope<'export:start', { options: ExportOptions }>

export type WorkerRequestType = WorkerRequest['type']
export type WorkerPayload<TType extends WorkerRequestType> = Extract<
  WorkerRequest,
  { type: TType }
>['payload']

export interface WorkerResultMap {
  'workspace:reset': { reset: true }
  'dbf:preview': TablePreview
  'dbf:import': WorkspaceImportResult
  'xlsx:preview': TablePreview
  'xlsx:import': WorkspaceImportResult
  'csv:preview': TablePreview
  'csv:import': WorkspaceImportResult
  'sqlite:open': DatabaseSchema
  'sqlite:execute': SqlExecutionResult
  'sqlite:page': QueryResultPage
  'sqlite:schema': DatabaseSchema
  'export:start': ExportFileResult
}

export interface WorkerProgress {
  id: string
  type: 'progress'
  progress: {
    current: number
    total?: number
    message?: string
  }
}

export interface WorkerResult<TData = unknown> {
  id: string
  type: 'result'
  data: TData
}

export interface WorkerError {
  id: string
  type: 'error'
  error: {
    code: string
    message: string
    details?: Readonly<Record<string, unknown>>
  }
}

export type WorkerResponse = WorkerProgress | WorkerResult | WorkerError
