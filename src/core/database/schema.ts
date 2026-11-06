export interface SqliteColumnInfo {
  name: string
  declaredType: string
  nullable: boolean
  primaryKey: boolean
}

export interface SqliteTableInfo {
  name: string
  columns: readonly SqliteColumnInfo[]
}

export interface DatabaseSchema {
  tables: readonly SqliteTableInfo[]
}

export type SqlCompletionSchema = Readonly<Record<string, readonly string[]>>
