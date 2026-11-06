import { ref } from 'vue'
import { defineStore } from 'pinia'

export const useSettingsStore = defineStore('settings', () => {
  const pageSize = ref(200)
  const defaultEncoding = ref('auto')
  const strictDbfImport = ref(true)
  const strictDbfExport = ref(true)
  const includeSqliteMetadata = ref(true)
  const theme = ref<'light' | 'dark'>('light')

  return {
    pageSize,
    defaultEncoding,
    strictDbfImport,
    strictDbfExport,
    includeSqliteMetadata,
    theme,
  }
})
