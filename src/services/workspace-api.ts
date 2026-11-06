import type {
  QueryResultPage,
  ResultPageRequest,
  SqlExecutionResult,
} from '../core/database/query'
import type { DatabaseSchema } from '../core/database/schema'
import type { DbfReadOptions } from '../core/dbf/types'
import type { CsvReadOptions } from '../core/formats/csv'
import type { XlsxReadOptions } from '../core/formats/xlsx'
import type { ImportMapping } from '../core/model/conversion'
import type { ExportFileResult, TablePreview, WorkspaceImportResult } from '../core/model/work'
import { DataWorkerClient } from '../workers/worker-client'
import type { RuntimeExportOptions } from '../workers/export'

interface ImportRequestOptions {
  tableName?: string
  mapping?: ImportMapping
}

export interface WorkspaceApi {
  previewDbf(buffer: ArrayBuffer, options: DbfReadOptions, fileName?: string): Promise<TablePreview>
  importDbf(
    buffer: ArrayBuffer,
    options: DbfReadOptions,
    importOptions?: ImportRequestOptions,
    fileName?: string,
  ): Promise<WorkspaceImportResult>
  previewXlsx(buffer: ArrayBuffer, options: XlsxReadOptions, fileName?: string): Promise<TablePreview>
  importXlsx(
    buffer: ArrayBuffer,
    options: XlsxReadOptions,
    importOptions?: ImportRequestOptions,
    fileName?: string,
  ): Promise<WorkspaceImportResult>
  previewCsv(buffer: ArrayBuffer, options: CsvReadOptions, fileName?: string): Promise<TablePreview>
  importCsv(
    buffer: ArrayBuffer,
    options: CsvReadOptions,
    importOptions?: ImportRequestOptions,
    fileName?: string,
  ): Promise<WorkspaceImportResult>
  openSqlite(bytes: Uint8Array): Promise<DatabaseSchema>
  executeSql(sql: string): Promise<SqlExecutionResult>
  getResultPage(request: ResultPageRequest): Promise<QueryResultPage>
  getSchema(): Promise<DatabaseSchema>
  export(options: RuntimeExportOptions): Promise<ExportFileResult>
  exportSqlite(): Promise<Uint8Array>
  reset(): Promise<void>
  terminate(): void
}

export class WorkerWorkspaceApi implements WorkspaceApi {
  constructor(private readonly client = new DataWorkerClient()) {}

  previewDbf(buffer: ArrayBuffer, options: DbfReadOptions, fileName?: string): Promise<TablePreview> {
    return this.client.request('dbf:preview', { buffer, options: { ...options }, fileName })
  }

  importDbf(
    buffer: ArrayBuffer,
    options: DbfReadOptions,
    importOptions: ImportRequestOptions = {},
    fileName?: string,
  ): Promise<WorkspaceImportResult> {
    return this.client.request('dbf:import', {
      buffer,
      options: { ...options },
      ...cloneImportOptions(importOptions),
      fileName,
    })
  }

  previewXlsx(buffer: ArrayBuffer, options: XlsxReadOptions, fileName?: string): Promise<TablePreview> {
    return this.client.request('xlsx:preview', { buffer, options: cloneXlsxOptions(options), fileName })
  }

  importXlsx(
    buffer: ArrayBuffer,
    options: XlsxReadOptions,
    importOptions: ImportRequestOptions = {},
    fileName?: string,
  ): Promise<WorkspaceImportResult> {
    return this.client.request('xlsx:import', {
      buffer,
      options: cloneXlsxOptions(options),
      ...cloneImportOptions(importOptions),
      fileName,
    })
  }

  previewCsv(buffer: ArrayBuffer, options: CsvReadOptions, fileName?: string): Promise<TablePreview> {
    return this.client.request('csv:preview', { buffer, options: { ...options }, fileName })
  }

  importCsv(
    buffer: ArrayBuffer,
    options: CsvReadOptions,
    importOptions: ImportRequestOptions = {},
    fileName?: string,
  ): Promise<WorkspaceImportResult> {
    return this.client.request('csv:import', {
      buffer,
      options: { ...options },
      ...cloneImportOptions(importOptions),
      fileName,
    })
  }

  openSqlite(bytes: Uint8Array): Promise<DatabaseSchema> {
    return this.client.request('sqlite:open', { bytes })
  }

  executeSql(sql: string): Promise<SqlExecutionResult> {
    return this.client.request('sqlite:execute', { sql })
  }

  getResultPage(request: ResultPageRequest): Promise<QueryResultPage> {
    return this.client.request('sqlite:page', { ...request })
  }

  getSchema(): Promise<DatabaseSchema> {
    return this.client.request('sqlite:schema', {})
  }

  export(options: RuntimeExportOptions): Promise<ExportFileResult> {
    return this.client.request('export:start', { options: sanitizeExportOptions(options) })
  }

  async exportSqlite(): Promise<Uint8Array> {
    const result = await this.export({
      format: 'sqlite',
      selection: { kind: 'workspace' },
      fileName: 'workspace.sqlite',
      strict: true,
      includeMetadata: true,
    })
    return result.bytes
  }

  async reset(): Promise<void> {
    await this.client.request('workspace:reset', {})
  }

  terminate(): void {
    this.client.terminate()
  }
}

function cloneImportOptions(options: ImportRequestOptions): ImportRequestOptions {
  return {
    tableName: options.tableName,
    mapping: options.mapping
      ? {
          targetTableName: options.mapping.targetTableName,
          columns: options.mapping.columns.map((column) => ({ ...column })),
        }
      : undefined,
  }
}

function cloneXlsxOptions(options: XlsxReadOptions): XlsxReadOptions {
  return {
    ...options,
    columns: options.columns ? [...options.columns] : undefined,
  }
}

function sanitizeExportOptions(options: RuntimeExportOptions): RuntimeExportOptions {
  return {
    ...options,
    selection: { ...options.selection },
    columns: options.columns?.map((column) => ({ ...column })),
    csv: options.csv ? { ...options.csv } : undefined,
    xlsx: options.xlsx ? { ...options.xlsx } : undefined,
  }
}
