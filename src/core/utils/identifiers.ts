export function quoteSqliteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`
}

export function quoteSqliteString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

export interface UniqueNameOptions {
  /** 首个冲突后缀编号；默认 2（name、name_2、name_3…），表名场景传 1。 */
  startSuffix?: number
  /**
   * 按大小写不敏感比较（SQLite 标识符默认不区分大小写）。
   * 此时传入的 usedNames 需已按小写归一化（见 resolveTargetTable 等调用方）。
   */
  caseInsensitive?: boolean
}

export function uniqueName(
  base: string,
  usedNames: ReadonlySet<string>,
  options: UniqueNameOptions = {},
): string {
  const normalizedBase = base.trim() || 'column'
  const keyOf = options.caseInsensitive
    ? (name: string) => name.toLowerCase()
    : (name: string) => name
  let candidate = normalizedBase
  let suffix = options.startSuffix ?? 2

  while (usedNames.has(keyOf(candidate))) {
    candidate = `${normalizedBase}_${suffix}`
    suffix += 1
  }

  return candidate
}

/**
 * 从导入文件名推导默认表名：去掉扩展名、替换文件系统保留字符。
 * 例如 `2024年销售明细.csv` → `2024年销售明细`；无效结果回退为 `imported_data`。
 */
export function baseTableNameFromFile(fileName: string): string {
  const withoutExtension = fileName.replace(/\.[^.]+$/, '')
  const sanitized = withoutExtension
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 64)

  return sanitized || 'imported_data'
}
