export interface TableInferenceOptions {
  mode: 'sample' | 'full'
  sampleSize: number
  preserveLeadingZeros: boolean
  emptyStringIsNull: boolean
  trueValues: readonly string[]
  falseValues: readonly string[]
  dateFormats: readonly string[]
}

export const DEFAULT_INFERENCE_OPTIONS: TableInferenceOptions = {
  mode: 'sample',
  sampleSize: 1000,
  preserveLeadingZeros: true,
  emptyStringIsNull: false,
  trueValues: ['true', 'yes', 'y'],
  falseValues: ['false', 'no', 'n'],
  dateFormats: ['YYYY-MM-DD', 'YYYY/MM/DD'],
}

export function resolveInferenceOptions(
  options: Partial<TableInferenceOptions> = {},
): TableInferenceOptions {
  const resolved: TableInferenceOptions = {
    ...DEFAULT_INFERENCE_OPTIONS,
    ...options,
    trueValues: options.trueValues ?? DEFAULT_INFERENCE_OPTIONS.trueValues,
    falseValues: options.falseValues ?? DEFAULT_INFERENCE_OPTIONS.falseValues,
    dateFormats: options.dateFormats ?? DEFAULT_INFERENCE_OPTIONS.dateFormats,
  }
  if (!Number.isInteger(resolved.sampleSize) || resolved.sampleSize < 1) {
    throw new RangeError('Inference sampleSize must be a positive integer')
  }
  if (resolved.mode !== 'sample' && resolved.mode !== 'full') {
    throw new RangeError(`Unsupported inference mode: ${String(resolved.mode)}`)
  }
  const supportedDateFormats = new Set(['YYYY-MM-DD', 'YYYY/MM/DD'])
  const unsupported = resolved.dateFormats.find((format) => !supportedDateFormats.has(format))
  if (unsupported) {
    throw new RangeError(`Unsupported inference date format: ${unsupported}`)
  }
  return resolved
}
