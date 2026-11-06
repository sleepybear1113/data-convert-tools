import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import type { DatabaseSchema } from '../core/database/schema'
import type { Diagnostic } from '../core/model/diagnostic'

export type WorkspaceStatus = 'empty' | 'ready' | 'busy' | 'error'

export const useWorkspaceStore = defineStore('workspace', () => {
  const status = ref<WorkspaceStatus>('empty')
  const schema = ref<DatabaseSchema>({ tables: [] })
  const activeTableName = ref<string | null>(null)
  const activeResultId = ref<string | null>(null)
  const diagnostics = ref<readonly Diagnostic[]>([])
  const dirty = ref(false)

  const isBusy = computed(() => status.value === 'busy')

  function reset(): void {
    status.value = 'empty'
    schema.value = { tables: [] }
    activeTableName.value = null
    activeResultId.value = null
    diagnostics.value = []
    dirty.value = false
  }

  return {
    status,
    schema,
    activeTableName,
    activeResultId,
    diagnostics,
    dirty,
    isBusy,
    reset,
  }
})
