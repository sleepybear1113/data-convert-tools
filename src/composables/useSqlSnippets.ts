import { ref } from 'vue'

import { readJsonStorage, writeJsonStorage } from '../core/utils/local-storage'

export interface SqlSnippet {
  /** 按钮上显示的文字。 */
  label: string
  /** 点击后插入编辑器的文本。 */
  insert: string
  /** 相对插入文本末尾的光标偏移（负数向左），用于成对符号。 */
  cursorOffset?: number
}

const SNIPPETS_STORAGE_KEY = 'dct.sql-snippets'

export const DEFAULT_SQL_SNIPPETS: readonly SqlSnippet[] = [
  { label: 'SELECT', insert: 'SELECT ' },
  { label: 'FROM', insert: 'FROM ' },
  { label: 'WHERE', insert: 'WHERE ' },
  { label: 'GROUP BY', insert: 'GROUP BY ' },
  { label: 'ORDER BY', insert: 'ORDER BY ' },
  { label: 'LIMIT', insert: 'LIMIT ' },
  { label: 'DISTINCT', insert: 'DISTINCT ' },
  { label: 'AND', insert: 'AND ' },
  { label: 'OR', insert: 'OR ' },
  { label: 'IN', insert: 'IN ' },
  { label: 'JOIN', insert: 'JOIN ' },
  { label: 'ON', insert: 'ON ' },
  { label: "'", insert: "''", cursorOffset: -1 },
  { label: '"', insert: '""', cursorOffset: -1 },
  { label: ',', insert: ', ' },
  { label: '()', insert: '()', cursorOffset: -1 },
]

function isValidSnippetList(value: unknown): value is SqlSnippet[] {
  return Array.isArray(value) && value.every((item) =>
    typeof item === 'object' && item !== null
    && typeof (item as SqlSnippet).label === 'string'
    && typeof (item as SqlSnippet).insert === 'string'
  )
}

/** SQL 编辑器常用片段：localStorage 持久化，可编辑 / 添加 / 调整顺序。 */
export function useSqlSnippets() {
  const stored = readJsonStorage<unknown>(SNIPPETS_STORAGE_KEY, [])
  const snippets = ref<SqlSnippet[]>(
    isValidSnippetList(stored) && stored.length ? stored.map((item) => ({ ...item })) : [...DEFAULT_SQL_SNIPPETS],
  )

  function save(next: readonly SqlSnippet[]): void {
    snippets.value = next.map((item) => ({ ...item }))
    writeJsonStorage(SNIPPETS_STORAGE_KEY, snippets.value)
  }

  function resetToDefaults(): void {
    save(DEFAULT_SQL_SNIPPETS)
  }

  return { snippets, save, resetToDefaults }
}
