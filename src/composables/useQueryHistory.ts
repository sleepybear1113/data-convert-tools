import { ref, watch } from 'vue'

import { readJsonStorage, writeJsonStorage } from '../core/utils/local-storage'

export type QueryHistoryMode = 'persistent' | 'session' | 'off'

export interface QueryHistoryConfig {
  /** persistent: localStorage 持久保存；session: 仅当前窗口；off: 不保存。 */
  mode: QueryHistoryMode
  /** 最多保留的条数（1–500）。 */
  limit: number
}

export interface QueryHistoryEntry {
  sql: string
  /** 执行时间（ISO 字符串）。 */
  executedAt: string
}

const HISTORY_STORAGE_KEY = 'dct.query-history'
const HISTORY_CONFIG_STORAGE_KEY = 'dct.query-history-config'

export const DEFAULT_QUERY_HISTORY_CONFIG: QueryHistoryConfig = {
  mode: 'session',
  limit: 50,
}

const HISTORY_MODES: readonly QueryHistoryMode[] = ['persistent', 'session', 'off']

function clampLimit(limit: number): number {
  return Math.min(500, Math.max(1, Math.round(limit) || DEFAULT_QUERY_HISTORY_CONFIG.limit))
}

function normalizeConfig(value: unknown): QueryHistoryConfig {
  if (typeof value !== 'object' || value === null) return { ...DEFAULT_QUERY_HISTORY_CONFIG }
  const candidate = value as Partial<QueryHistoryConfig>
  return {
    mode: HISTORY_MODES.includes(candidate.mode as QueryHistoryMode)
      ? candidate.mode as QueryHistoryMode
      : DEFAULT_QUERY_HISTORY_CONFIG.mode,
    limit: clampLimit(Number(candidate.limit)),
  }
}

function isValidEntries(value: unknown): value is QueryHistoryEntry[] {
  return Array.isArray(value) && value.every((item) =>
    typeof item === 'object' && item !== null
    && typeof (item as QueryHistoryEntry).sql === 'string'
    && typeof (item as QueryHistoryEntry).executedAt === 'string'
  )
}

/**
 * 查询历史：三种保存模式（持久 / 仅当前窗口 / 不保存），最新在最前，
 * 相同 SQL 去重（移到顶部并更新时间）。
 */
export function useQueryHistory() {
  const config = ref<QueryHistoryConfig>(
    normalizeConfig(readJsonStorage<unknown>(HISTORY_CONFIG_STORAGE_KEY, DEFAULT_QUERY_HISTORY_CONFIG)),
  )
  const entries = ref<QueryHistoryEntry[]>(
    config.value.mode === 'persistent'
      ? readJsonStorage<QueryHistoryEntry[]>(HISTORY_STORAGE_KEY, []).filter(isValidEntries)
      : [],
  )

  function persistEntries(): void {
    if (config.value.mode === 'persistent') {
      writeJsonStorage(HISTORY_STORAGE_KEY, entries.value)
    }
  }

  function trimEntries(): void {
    entries.value = entries.value.slice(0, config.value.limit)
  }

  function setConfig(next: Partial<QueryHistoryConfig>): void {
    const previous = config.value
    const mode = next.mode ?? previous.mode
    const limit = clampLimit(next.limit ?? previous.limit)
    config.value = { mode, limit }
    writeJsonStorage(HISTORY_CONFIG_STORAGE_KEY, config.value)
    // 切换到持久模式时，把当前窗口内已有的历史一并保存。
    if (previous.mode !== 'persistent' && mode === 'persistent') {
      persistEntries()
    }
    trimEntries()
    persistEntries()
  }

  function record(sql: string): void {
    if (config.value.mode === 'off') return
    const trimmed = sql.trim()
    if (!trimmed) return
    entries.value = [
      { sql: trimmed, executedAt: new Date().toISOString() },
      ...entries.value.filter((entry) => entry.sql !== trimmed),
    ].slice(0, config.value.limit)
    persistEntries()
  }

  function clear(): void {
    entries.value = []
    writeJsonStorage(HISTORY_STORAGE_KEY, [])
  }

  // 条数上限变化时立即截断。
  watch(() => config.value.limit, () => {
    trimEntries()
    persistEntries()
  })

  return { config, entries, setConfig, record, clear }
}
