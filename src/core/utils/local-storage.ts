/** localStorage 的安全读写：隐私模式 / 超额 / 损坏数据时静默回退。 */
export function readJsonStorage<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key)
    if (raw === null) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function writeJsonStorage(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // 写入失败（隐私模式 / 配额超限）时保持内存态即可。
  }
}

export function removeJsonStorage(key: string): void {
  try {
    window.localStorage.removeItem(key)
  } catch {
    // 忽略。
  }
}
