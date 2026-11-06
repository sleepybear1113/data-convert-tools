import type { FileImportRequest } from '../components/contracts'
import type { DbfReadOptions } from '../core/dbf/types'
import type { CsvReadOptions } from '../core/formats/csv'
import type { TablePreview } from '../core/model/work'
import { uniqueName } from '../core/utils/identifiers'
import type { WorkspaceImportPreparation, WorkspaceIntegration } from '../views/workspace-integration'
import type { WorkspaceApi } from './workspace-api'
import { downloadExport } from './file-save'
import { readFileBuffer } from './file-open'

interface PendingImportContext {
  request: FileImportRequest
  buffer: ArrayBuffer
  preview: TablePreview
}

export function createWorkspaceIntegration(api: WorkspaceApi): WorkspaceIntegration {
  async function defaultTableName(): Promise<string> {
    const schema = await api.getSchema()
    return uniqueName('imported_data', new Set(schema.tables.map((table) => table.name)))
  }

  async function prepareImport(request: FileImportRequest): Promise<WorkspaceImportPreparation> {
    if (request.format === 'sqlite') throw new Error('SQLite files do not use column mapping')
    const buffer = await readFileBuffer(request.file)
    const fileName = request.file.name
    let preview: TablePreview

    switch (request.format) {
      case 'dbf':
        preview = await api.previewDbf(buffer, dbfOptions(request.options), fileName)
        break
      case 'xlsx':
        preview = await api.previewXlsx(buffer, request.options, fileName)
        break
      case 'csv':
        preview = await api.previewCsv(buffer, csvOptions(request.options), fileName)
        break
    }

    return {
      sourceSchema: preview.schema,
      targetTableName: await defaultTableName(),
      context: { request, buffer, preview } satisfies PendingImportContext,
    }
  }

  return {
    prepareImport,
    async importFile(request, mapping, context) {
      if (request.format === 'sqlite') {
        const schema = await api.openSqlite(new Uint8Array(await readFileBuffer(request.file)))
        return {
          schema,
          activeTableName: schema.tables[0]?.name,
        }
      }

      const pending = isPendingContext(context) && context.request.file === request.file
        ? context
        : undefined
      const buffer = pending?.buffer ?? await readFileBuffer(request.file)
      const importOptions = {
        tableName: mapping?.targetTableName ?? await defaultTableName(),
        mapping,
      }
      const fileName = request.file.name
      const result = request.format === 'dbf'
        ? await api.importDbf(buffer, dbfOptions(request.options), importOptions, fileName)
        : request.format === 'xlsx'
          ? await api.importXlsx(buffer, request.options, importOptions, fileName)
          : await api.importCsv(buffer, csvOptions(request.options), importOptions, fileName)

      return {
        schema: await api.getSchema(),
        table: result.table,
        recordCount: result.recordCount,
        diagnostics: result.diagnostics,
        activeTableName: result.table.name,
      }
    },
    async createWorkspace() {
      await api.reset()
      return { schema: { tables: [] } }
    },
    executeSql: (sql) => api.executeSql(sql),
    getResultPage: (request) => api.getResultPage(request),
    getSchema: () => api.getSchema(),
    async exportData(options) {
      const result = await api.export(options)
      downloadExport(result)
    },
  }
}

function dbfOptions(options: DbfReadOptions): DbfReadOptions {
  return {
    ...options,
    encoding: options.encoding === 'auto' ? undefined : options.encoding,
  }
}

function csvOptions(options: CsvReadOptions): CsvReadOptions {
  return {
    ...options,
    encoding: !options.encoding || options.encoding === 'auto' ? 'utf-8' : options.encoding,
  }
}

function isPendingContext(context: unknown): context is PendingImportContext {
  if (!context || typeof context !== 'object') return false
  const candidate = context as Partial<PendingImportContext>
  return candidate.buffer instanceof ArrayBuffer
    && typeof candidate.request === 'object'
    && typeof candidate.preview === 'object'
}
