export type DiagnosticSeverity = 'info' | 'warning' | 'error'

export interface DiagnosticLocation {
  tableName?: string
  columnIndex?: number
  columnName?: string
  rowIndex?: number
  byteOffset?: number
}

export interface Diagnostic {
  code: string
  severity: DiagnosticSeverity
  message: string
  location?: DiagnosticLocation
  details?: Readonly<Record<string, unknown>>
}

export interface DiagnosticReport {
  items: readonly Diagnostic[]
  hasErrors: boolean
  hasWarnings: boolean
}
