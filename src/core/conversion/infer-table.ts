import type { Diagnostic } from '../model/diagnostic'
import type { TableRow, TableSchema } from '../model/table'
import { inferColumn } from './infer-column'
import type { ColumnInference } from './infer-column'
import { resolveInferenceOptions } from './options'
import type { TableInferenceOptions } from './options'

export { DEFAULT_INFERENCE_OPTIONS } from './options'
export type { TableInferenceOptions } from './options'

export interface TableColumnInference extends ColumnInference {
  sourceIndex: number
  columnId: string
  columnName: string
  nullable: boolean
}

export interface TableInferenceResult {
  schema: TableSchema
  columns: readonly TableColumnInference[]
  diagnostics: readonly Diagnostic[]
  options: TableInferenceOptions
}

function withColumnLocation(diagnostic: Diagnostic, sourceIndex: number, columnName: string): Diagnostic {
  return {
    ...diagnostic,
    location: {
      ...diagnostic.location,
      columnIndex: sourceIndex,
      columnName,
    },
  }
}

/** Infer all columns from the same row window, preserving source metadata and IDs. */
export function inferTable(
  sourceSchema: TableSchema,
  rows: readonly TableRow[],
  options: Partial<TableInferenceOptions> = {},
): TableInferenceResult {
  const resolvedOptions = resolveInferenceOptions(options)
  const limit = resolvedOptions.mode === 'full' ? rows.length : Math.min(rows.length, resolvedOptions.sampleSize)
  const diagnostics: Diagnostic[] = []

  const columns = sourceSchema.columns.map((column, sourceIndex): TableColumnInference => {
    const values = rows.map((row) => row[sourceIndex] ?? null)
    const inferred = inferColumn(values, resolvedOptions)
    const nullable = rows.slice(0, limit).some((row) => {
      const value = row[sourceIndex]
      return value === null || value === undefined || (resolvedOptions.emptyStringIsNull && value === '')
    }) || column.nullable
    const columnDiagnostics = inferred.diagnostics.map((diagnostic) =>
      withColumnLocation(diagnostic, sourceIndex, column.name),
    )
    diagnostics.push(...columnDiagnostics)
    return {
      ...inferred,
      diagnostics: columnDiagnostics,
      sourceIndex,
      columnId: column.id,
      columnName: column.name,
      nullable,
    }
  })

  return {
    schema: {
      ...sourceSchema,
      columns: sourceSchema.columns.map((column, index) => ({
        ...column,
        dataType: columns[index].dataType,
        nullable: columns[index].nullable,
      })),
    },
    columns,
    diagnostics,
    options: resolvedOptions,
  }
}
