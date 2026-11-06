<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue'

import WorkspaceView from './views/WorkspaceView.vue'
import { createWorkspaceIntegration } from './services/workspace-integration'
import { WorkerWorkspaceApi } from './services/workspace-api'
import { useWorkspaceStore } from './stores/workspace'

const workspaceApi = new WorkerWorkspaceApi()
const integration = createWorkspaceIntegration(workspaceApi)
const workspace = useWorkspaceStore()

function warnUnsavedChanges(event: BeforeUnloadEvent): void {
  if (!workspace.dirty) return
  event.preventDefault()
  event.returnValue = ''
}

onMounted(() => window.addEventListener('beforeunload', warnUnsavedChanges))
onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', warnUnsavedChanges)
  workspaceApi.terminate()
})
</script>

<template>
  <WorkspaceView :api="integration" />
</template>
