import type { Diagnostic } from '../model/diagnostic'
import type { ColumnMapping } from '../model/conversion'
import type { ColumnDataType, TableRow, TableSchema } from '../model/table'

export interface NameCollision {
  sourceName: string
  resolvedName: string
  reason: 'duplicate' | 'empty' | 'length' | 'invalid'
  sourceIndex?: number
}

export interface MappingValidation {
  valid: boolean
  collisions: readonly NameCollision[]
  diagnostics: readonly Diagnostic[]
}

export interface ColumnMappingOptions {
  /** Included source indexes. All columns are included by default. */
  includedColumns?: readonly number[]
  /** Overrides keyed by source index. */
  targetNames?: Readonly<Record<number, string>>
  targetTypes?: Readonly<Record<number, ColumnDataType>>
  caseInsensitive?: boolean
  maxLength?: number
}

export interface ColumnMappingResult {
  columns: readonly ColumnMapping[]
  collisions: readonly NameCollision[]
}

export interface ResolvedColumnNames {
  names: readonly string[]
  collisions: readonly NameCollision[]
}

export class ColumnMappingError extends Error {
  readonly validation: MappingValidation

  constructor(validation: MappingValidation) {
    super(validation.diagnostics[0]?.message ?? 'Invalid column mapping')
    this.name = 'ColumnMappingError'
    this.validation = validation
  }
}

function normalizedName(name: string, caseInsensitive: boolean): string {
  return caseInsensitive ? name.toLowerCase() : name
}

function truncateName(name: string, maxLength: number | undefined): string {
  if (maxLength === undefined) return name
  return [...name].slice(0, maxLength).join('')
}

/** Resolve empty/duplicate names in input order with deterministic _2/_3 suffixes. */
export function resolveColumnNames(
  sourceNames: readonly string[],
  options: Pick<ColumnMappingOptions, 'caseInsensitive' | 'maxLength'> = {},
): ResolvedColumnNames {
  const caseInsensitive = options.caseInsensitive ?? true
  if (options.maxLength !== undefined && (!Number.isInteger(options.maxLength) || options.maxLength < 1)) {
    throw new RangeError('Column maxLength must be a positive integer')
  }

  const used = new Set<string>()
  const collisions: NameCollision[] = []
  const names = sourceNames.map((sourceName, sourceIndex) => {
    const trimmed = sourceName.trim()
    const withoutControls = trimmed.replace(/[\u0000-\u001f\u007f]/gu, '_')
    const shortened = truncateName(withoutControls, options.maxLength)
    const base = shortened || 'column'
    let candidate = base
    let suffix = 2
    while (used.has(normalizedName(candidate, caseInsensitive))) {
      let suffixText = `_${suffix}`
      if (options.maxLength !== undefined && suffixText.length >= options.maxLength) {
        suffixText = suffix.toString(36)
      }
      if (options.maxLength !== undefined && suffixText.length > options.maxLength) {
        throw new RangeError('Column maxLength is too small to generate another unique name')
      }
      const available = options.maxLength === undefined ? undefined : options.maxLength - suffixText.length
      candidate = `${truncateName(base, available)}${suffixText}`
      suffix += 1
    }
    used.add(normalizedName(candidate, caseInsensitive))

    let reason: NameCollision['reason'] | undefined
    if (!trimmed) reason = 'empty'
    else if (withoutControls !== trimmed) reason = 'invalid'
    else if (shortened !== withoutControls) reason = 'length'
    else if (candidate !== shortened) reason = 'duplicate'
    if (reason) collisions.push({ sourceName, resolvedName: candidate, reason, sourceIndex })
    return candidate
  })
  return { names, collisions }
}

export function buildColumnMapping(
  schema: TableSchema,
  options: ColumnMappingOptions = {},
): ColumnMappingResult {
  const included = options.includedColumns ? new Set(options.includedColumns) : undefined
  const overriddenNames = schema.columns.map((column, index) => options.targetNames?.[index] ?? column.name)
  const resolved = resolveColumnNames(overriddenNames, options)
  return {
    columns: schema.columns.map((column, sourceIndex) => ({
      sourceIndex,
      included: included?.has(sourceIndex) ?? true,
      targetName: resolved.names[sourceIndex],
      targetType: options.targetTypes?.[sourceIndex] ?? column.dataType,
    })),
    collisions: resolved.collisions,
  }
}

/** Convenience form for callers that only need ImportMapping.columns. */
export function createColumnMapping(
  schema: TableSchema,
  options: ColumnMappingOptions = {},
): readonly ColumnMapping[] {
  return buildColumnMapping(schema, options).columns
}

export function validateColumnMapping(
  schema: TableSchema,
  mappings: readonly ColumnMapping[],
  options: { caseInsensitive?: boolean; requireIncludedColumn?: boolean } = {},
): MappingValidation {
  const caseInsensitive = options.caseInsensitive ?? true
  const diagnostics: Diagnostic[] = []
  const collisions: NameCollision[] = []
  const seenIndexes = new Set<number>()
  const seenNames = new Set<string>()
  let includedCount = 0

  for (const mapping of mappings) {
    const source = schema.columns[mapping.sourceIndex]
    if (!source || !Number.isInteger(mapping.sourceIndex)) {
      diagnostics.push({
        code: 'MAPPING_SOURCE_INDEX',
        severity: 'error',
        message: `映射的源列索引越界：${mapping.sourceIndex}`,
        location: { columnIndex: mapping.sourceIndex },
      })
      continue
    }
    if (seenIndexes.has(mapping.sourceIndex)) {
      diagnostics.push({
        code: 'MAPPING_DUPLICATE_SOURCE',
        severity: 'error',
        message: `源列被映射了多次：${source.name}`,
        location: { columnIndex: mapping.sourceIndex, columnName: source.name },
      })
    }
    seenIndexes.add(mapping.sourceIndex)
    if (!mapping.included) continue
    includedCount += 1

    const targetName = mapping.targetName.trim()
    const normalized = normalizedName(targetName, caseInsensitive)
    if (!targetName) {
      collisions.push({
        sourceName: source.name,
        resolvedName: mapping.targetName,
        reason: 'empty',
        sourceIndex: mapping.sourceIndex,
      })
      diagnostics.push({
        code: 'MAPPING_EMPTY_NAME',
        severity: 'error',
        message: `源列 ${source.name} 的目标列名为空`,
        location: { columnIndex: mapping.sourceIndex, columnName: source.name },
      })
    } else if (seenNames.has(normalized)) {
      collisions.push({
        sourceName: source.name,
        resolvedName: mapping.targetName,
        reason: 'duplicate',
        sourceIndex: mapping.sourceIndex,
      })
      diagnostics.push({
        code: 'MAPPING_DUPLICATE_NAME',
        severity: 'error',
        message: `目标列名重复：${mapping.targetName}`,
        location: { columnIndex: mapping.sourceIndex, columnName: source.name },
      })
    }
    seenNames.add(normalized)
  }

  if ((options.requireIncludedColumn ?? false) && includedCount === 0) {
    diagnostics.push({
      code: 'MAPPING_NO_COLUMNS',
      severity: 'error',
      message: '至少需要选择一列',
    })
  }

  return { valid: diagnostics.every((diagnostic) => diagnostic.severity !== 'error'), collisions, diagnostics }
}

/** Apply inclusion, order, renames and target-type suggestions without coercing values. */
export function applyColumnMapping(
  sourceSchema: TableSchema,
  rows: readonly TableRow[],
  mappings: readonly ColumnMapping[],
  targetTableName = sourceSchema.name,
): { schema: TableSchema; rows: readonly TableRow[] } {
  const validation = validateColumnMapping(sourceSchema, mappings, { requireIncludedColumn: true })
  if (!validation.valid) throw new ColumnMappingError(validation)
  const included = mappings.filter((mapping) => mapping.included)

  return {
    schema: {
      id: `${sourceSchema.id}:mapped`,
      name: targetTableName,
      columns: included.map((mapping) => {
        const source = sourceSchema.columns[mapping.sourceIndex]
        return {
          ...source,
          name: mapping.targetName.trim(),
          dataType: mapping.targetType ?? source.dataType,
        }
      }),
    },
    rows: rows.map((row) => included.map((mapping) => row[mapping.sourceIndex] ?? null)),
  }
}
