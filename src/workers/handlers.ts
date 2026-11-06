import type { DatabaseEngine } from '../core/database/engine'
import type { ImportMapping } from '../core/model/conversion'
import { uniqueName } from '../core/utils/identifiers'
import type { WorkerHandlers } from './dispatch'
import { importDbfIntoSqlite, previewDbf } from './dbf-source'
import { exportWorkspace } from './export'
import type { RuntimeExportOptions } from './export'
import {
  importCsvIntoSqlite,
  importXlsxIntoSqlite,
  previewCsv,
  previewXlsx,
} from './format-source'
import { createSqliteHandlers } from './sqlite-handlers'

export function createWorkerHandlers(
  engine: DatabaseEngine,
  createEngine: () => DatabaseEngine,
): WorkerHandlers {
  const sqlite = createSqliteHandlers(engine)

  return {
    ...sqlite,
    'dbf:preview': ({ buffer, options, fileName }) => previewDbf(buffer, options, fileName),
    'dbf:import': async ({ buffer, options, tableName, mapping, fileName }) => {
      const target = await resolveTargetTable(engine, tableName, mapping)
      return importDbfIntoSqlite(engine, buffer, options, target, fileName, mapping)
    },
    'xlsx:preview': ({ buffer, options, fileName }) => previewXlsx(buffer, options, fileName),
    'xlsx:import': async ({ buffer, options, tableName, mapping, fileName }) => {
      const target = await resolveTargetTable(engine, tableName, mapping)
      return importXlsxIntoSqlite(engine, buffer, options, target, mapping, fileName)
    },
    'csv:preview': ({ buffer, options, fileName }) => previewCsv(buffer, options, fileName),
    'csv:import': async ({ buffer, options, tableName, mapping, fileName }) => {
      const target = await resolveTargetTable(engine, tableName, mapping)
      return importCsvIntoSqlite(engine, buffer, options, target, mapping, fileName)
    },
    'export:start': ({ options }) => exportWorkspace(
      engine,
      createEngine,
      options as RuntimeExportOptions,
    ),
  }
}

async function resolveTargetTable(
  engine: DatabaseEngine,
  requested: string | undefined,
  mapping: ImportMapping | undefined,
): Promise<string> {
  const schema = await engine.getSchema()
  const used = new Set(schema.tables.map((table) => table.name.toLowerCase()))
  const candidate = mapping?.targetTableName.trim() || requested?.trim()

  if (!candidate) return uniqueName('imported_data', used)
  if (used.has(candidate.toLowerCase())) throw new Error(`Target table already exists: ${candidate}`)
  return candidate
}
