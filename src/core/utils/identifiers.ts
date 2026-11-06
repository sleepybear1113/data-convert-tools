export function quoteSqliteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`
}

export function quoteSqliteString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

export function uniqueName(base: string, usedNames: ReadonlySet<string>): string {
  const normalizedBase = base.trim() || 'column'
  let candidate = normalizedBase
  let suffix = 2

  while (usedNames.has(candidate)) {
    candidate = `${normalizedBase}_${suffix}`
    suffix += 1
  }

  return candidate
}
