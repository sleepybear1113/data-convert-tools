export interface SqliteColumnInfo {
  name: string
  declaredType: string
  nullable: boolean
  primaryKey: boolean
}

export interface SqliteTableInfo {
  name: string
  columns: readonly SqliteColumnInfo[]
  /** 表（或视图）的行数；由 getSchema 通过 COUNT(*) 填充。 */
  rowCount?: number
  /** 导入来源文件名（如 `people.xlsx`）；SQL 创建的表没有该信息。 */
  sourceFileName?: string
}

export interface DatabaseSchema {
  tables: readonly SqliteTableInfo[]
}

export type SqlCompletionSchema = Readonly<Record<string, readonly string[]>>
