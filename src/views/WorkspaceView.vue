<script setup lang="ts">
import { computed, inject, nextTick, onMounted, ref, watch } from 'vue'
import {
  NAlert,
  NButton,
  NConfigProvider,
  NModal,
  NTag,
  zhCN,
} from 'naive-ui'

import ColumnMappingEditor from '../components/ColumnMappingEditor.vue'
import DiagnosticList from '../components/DiagnosticList.vue'
import ExportDialog from '../components/ExportDialog.vue'
import FileImportPanel from '../components/FileImportPanel.vue'
import ResultGrid from '../components/ResultGrid.vue'
import SchemaNavigator from '../components/SchemaNavigator.vue'
import SqlEditor from '../components/SqlEditor.vue'
import type {
  FileImportRequest,
  ResultPageChange,
  WorkspaceExportOptions,
} from '../components/contracts'
import type {
  QueryResultPage,
  ResultPageRequest,
  SqlExecutionResult,
} from '../core/database/query'
import type { DatabaseSchema } from '../core/database/schema'
import type { ColumnMapping, ImportMapping } from '../core/model/conversion'
import type { Diagnostic } from '../core/model/diagnostic'
import type { TableRow, TableSchema } from '../core/model/table'
import { quoteSqliteIdentifier } from '../core/utils/identifiers'
import { simpleSelectSourceTable } from '../core/utils/sql-select'
import { usePointerDrag } from '../composables/usePointerDrag'
import { useSettingsStore } from '../stores/settings'
import { useWorkspaceStore } from '../stores/workspace'
import {
  workspaceIntegrationKey,
} from './workspace-integration'
import type {
  WorkspaceIntegration,
  WorkspaceOperationResult,
} from './workspace-integration'

const props = withDefaults(
  defineProps<{
    /** 优先级高于 provide(workspaceIntegrationKey)。 */
    api?: WorkspaceIntegration
    initialSql?: string
    pageSize?: number
  }>(),
  {
    api: undefined,
    initialSql: 'SELECT * FROM imported_data LIMIT 500;',
    pageSize: undefined,
  },
)

const emit = defineEmits<{
  'import-request': [request: FileImportRequest]
  'new-workspace': []
  'execute-sql': [sql: string]
  'page-request': [request: ResultPageRequest]
  'export-request': [options: WorkspaceExportOptions]
  'mapping-submit': [mapping: ImportMapping]
  'schema-change': [schema: DatabaseSchema]
  'select-table': [tableName: string]
  error: [error: Error]
}>()

const workspace = useWorkspaceStore()
const settings = useSettingsStore()
const injectedApi = inject(workspaceIntegrationKey, null)
const integration = computed<WorkspaceIntegration | null>(
  () => props.api ?? injectedApi,
)

const sqlEditor = ref<InstanceType<typeof SqlEditor> | null>(null)
const importPanel = ref<InstanceType<typeof FileImportPanel> | null>(null)
const mappingEditor = ref<InstanceType<typeof ColumnMappingEditor> | null>(null)

/** 侧边栏宽度（px）。仅内存态，刷新后回到默认值。 */
const SIDEBAR_DEFAULT_WIDTH = 286
const SIDEBAR_MIN_WIDTH = 220
const SIDEBAR_MAX_WIDTH = 600
const sidebarWidth = ref(SIDEBAR_DEFAULT_WIDTH)
const sidebarAside = ref<HTMLElement | null>(null)

const layoutStyle = computed(() => ({
  '--sidebar-width': `${sidebarWidth.value}px`,
}))

function clampSidebarWidth(width: number): number {
  const viewportMax = Math.floor(window.innerWidth * 0.55)
  const max = Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, viewportMax))
  return Math.round(Math.min(Math.max(width, SIDEBAR_MIN_WIDTH), max))
}

const dragSidebar = usePointerDrag<number>({
  onStart: () => sidebarAside.value?.getBoundingClientRect().width ?? sidebarWidth.value,
  onMove: (event, state) => {
    sidebarWidth.value = clampSidebarWidth(state.context + event.clientX - state.startX)
  },
})

function resetSidebarWidth(): void {
  sidebarWidth.value = SIDEBAR_DEFAULT_WIDTH
}

function onSidebarResizerKeydown(event: KeyboardEvent): void {
  const step = event.shiftKey ? 48 : 16
  if (event.key === 'ArrowLeft') {
    sidebarWidth.value = clampSidebarWidth(sidebarWidth.value - step)
    event.preventDefault()
  } else if (event.key === 'ArrowRight') {
    sidebarWidth.value = clampSidebarWidth(sidebarWidth.value + step)
    event.preventDefault()
  }
}

const sql = ref(props.initialSql)
const executedSql = ref('')
const hasExecuted = ref(false)
const hasQueryResult = ref(false)
const resultColumns = ref<readonly string[]>([])
const resultRows = ref<readonly TableRow[]>([])
const resultOffset = ref(0)
const resultTotalRows = ref<number | undefined>(undefined)
const resultPageSize = ref(props.pageSize ?? settings.pageSize)
const resultDuration = ref<number | null>(null)
const rowsAffected = ref<number | null>(null)
const executing = ref(false)
const resultLoading = ref(false)
const resultError = ref('')
const sqlError = ref('')
let pageRequestSequence = 0

const schemaLoading = ref(false)
const schemaError = ref('')
let schemaRequestSequence = 0
const importVisible = ref(false)
const importLoading = ref(false)
const importError = ref('')
const mappingVisible = ref(false)
const mappingError = ref('')
const pendingImport = ref<FileImportRequest | null>(null)
const pendingImportContext = ref<unknown>(undefined)
const pendingSourceSchema = ref<TableSchema | null>(null)
const mappingColumns = ref<readonly ColumnMapping[]>([])
const mappingTargetName = ref('')
const exportVisible = ref(false)
const exportLoading = ref(false)
const exportError = ref('')
const newVisible = ref(false)
const newLoading = ref(false)
const newError = ref('')
const pendingDeleteTable = ref<string | null>(null)
const deleteLoading = ref(false)
const renameLoading = ref(false)
const resultGroupColumns = ref<readonly string[]>([])
const detectingTypes = ref(false)
const notice = ref('')

/** 当前 SQL 是简单单表读取时对应的表名（「选中的数据表」来源可按该表分组导出）。 */
const groupableTableName = computed<string | null>(() => {
  if (!hasExecuted.value) return null
  const tableName = simpleSelectSourceTable(executedSql.value)
  if (!tableName) return null
  const exists = workspace.schema.tables.some(
    (table) => table.name.toLowerCase() === tableName.toLowerCase(),
  )
  return exists ? tableName : null
})

let busyOperations = 0

const working = computed(
  () =>
    executing.value ||
    resultLoading.value ||
    schemaLoading.value ||
    importLoading.value ||
    exportLoading.value ||
    newLoading.value ||
    deleteLoading.value ||
    renameLoading.value,
)
const hasAnyError = computed(() =>
  Boolean(
    sqlError.value ||
      resultError.value ||
      schemaError.value ||
      importError.value ||
      mappingError.value ||
      exportError.value ||
      newError.value,
  ),
)
const statusText = computed(() => {
  if (working.value) return '正在处理'
  if (hasAnyError.value) return '需要处理'
  if (!workspace.schema.tables.length) return '空工作区'
  return workspace.dirty ? '有未导出修改' : '工作区就绪'
})
const statusType = computed<'default' | 'success' | 'warning' | 'error'>(() => {
  if (hasAnyError.value) return 'error'
  if (working.value || workspace.dirty) return 'warning'
  return workspace.schema.tables.length ? 'success' : 'default'
})
const canExport = computed(
  () => workspace.schema.tables.length > 0 || hasQueryResult.value,
)

const themeOverrides = {
  common: {
    primaryColor: '#4c70c9',
    primaryColorHover: '#5d80d5',
    primaryColorPressed: '#3e60b2',
    primaryColorSuppl: '#4c70c9',
    borderRadius: '7px',
    fontFamily: 'Inter, "Microsoft YaHei", system-ui, sans-serif',
  },
}

function beginBusy(): void {
  busyOperations += 1
  workspace.status = 'busy'
}

function endBusy(): void {
  busyOperations = Math.max(0, busyOperations - 1)
  if (busyOperations === 0) {
    workspace.status = workspace.schema.tables.length ? 'ready' : 'empty'
  }
}

function errorMessage(reason: unknown): string {
  if (reason instanceof Error) return reason.message
  if (typeof reason === 'string') return reason
  return '操作失败，请检查数据适配器返回的信息。'
}

function reportError(reason: unknown): string {
  const message = errorMessage(reason)
  emit('error', reason instanceof Error ? reason : new Error(message))
  return message
}

function missingIntegration(method: string): string {
  return reportError(new Error(`尚未接入 WorkspaceIntegration.${method}，请由父层提供数据适配器。`))
}

function applySchema(schema: DatabaseSchema, preferredTable?: string): void {
  workspace.schema = schema
  const current = workspace.activeTableName
  const hasCurrent = current && schema.tables.some((table) => table.name === current)
  const hasPreferred = preferredTable && schema.tables.some((table) => table.name === preferredTable)
  workspace.activeTableName = hasCurrent
    ? current
    : hasPreferred
      ? (preferredTable ?? null)
      : (schema.tables[0]?.name ?? null)
  schemaError.value = ''
  emit('schema-change', schema)
}

async function refreshSchema(showError = true): Promise<void> {
  const api = integration.value
  const getSchema = api?.getSchema?.bind(api)
  if (!getSchema) return
  const sequence = ++schemaRequestSequence
  schemaLoading.value = true
  beginBusy()
  try {
    const schema = await getSchema()
    if (sequence === schemaRequestSequence) applySchema(schema)
  } catch (reason) {
    if (showError && sequence === schemaRequestSequence) {
      schemaError.value = reportError(reason)
    }
  } finally {
    if (sequence === schemaRequestSequence) schemaLoading.value = false
    endBusy()
  }
}

function tableAsSqlite(table: TableSchema): DatabaseSchema['tables'][number] {
  return {
    name: table.name,
    columns: table.columns.map((column) => ({
      name: column.name,
      declaredType: column.source?.type ?? column.dataType.toUpperCase(),
      nullable: column.nullable,
      primaryKey: false,
    })),
  }
}

async function applyMutationResult(
  result: WorkspaceOperationResult | void,
  preferredTable?: string,
): Promise<void> {
  if (result?.diagnostics?.length) {
    workspace.diagnostics = [...workspace.diagnostics, ...result.diagnostics]
  }

  if (result?.schema) {
    applySchema(result.schema, result.activeTableName ?? preferredTable)
  } else if (result?.table) {
    const converted = tableAsSqlite(result.table)
    workspace.schema = {
      tables: [
        ...workspace.schema.tables.filter((table) => table.name !== converted.name),
        converted,
      ],
    }
    applySchema(workspace.schema, result.activeTableName ?? converted.name)
  } else {
    await refreshSchema(false)
    if (result?.activeTableName) workspace.activeTableName = result.activeTableName
  }
}

async function loadResultPage(request: ResultPageRequest): Promise<void> {
  emit('page-request', request)
  const api = integration.value
  const getResultPage = api?.getResultPage?.bind(api)
  if (!getResultPage) {
    resultError.value = missingIntegration('getResultPage')
    return
  }

  const sequence = ++pageRequestSequence
  resultLoading.value = true
  resultError.value = ''
  beginBusy()
  try {
    const page: QueryResultPage = await getResultPage(request)
    if (
      sequence !== pageRequestSequence ||
      workspace.activeResultId !== page.resultId
    ) return
    // 全量结果由父层/Worker 持有；这里仅保留当前页，且不会写入 Pinia。
    resultColumns.value = page.columns
    resultRows.value = page.rows
    resultOffset.value = page.offset
    resultTotalRows.value = page.totalRows
    resultPageSize.value = request.limit
  } catch (reason) {
    if (sequence === pageRequestSequence) resultError.value = reportError(reason)
  } finally {
    if (sequence === pageRequestSequence) resultLoading.value = false
    endBusy()
  }
}

async function executeSql(value: string): Promise<void> {
  emit('execute-sql', value)
  const api = integration.value
  const execute = api?.executeSql?.bind(api)
  if (!execute) {
    sqlError.value = missingIntegration('executeSql')
    return
  }
  if (!value.trim()) {
    sqlError.value = '请输入需要执行的 SQL。'
    return
  }

  executing.value = true
  sqlError.value = ''
  resultError.value = ''
  notice.value = ''
  beginBusy()
  try {
    const result: SqlExecutionResult = await execute(value)
    const reversed = [...result.statements].reverse()
    const statement = reversed.find((item) => item.resultId) ?? result.statements.at(-1)

    executedSql.value = value
    hasExecuted.value = true
    hasQueryResult.value = Boolean(statement?.resultId)
    resultDuration.value = result.durationMs
    rowsAffected.value = statement?.rowsAffected ?? null
    resultColumns.value = statement?.columns ?? []
    resultRows.value = []
    resultOffset.value = 0
    resultTotalRows.value = statement?.totalRows
    workspace.activeResultId = statement?.resultId ?? null
    if (result.diagnostics.length) {
      workspace.diagnostics = [...workspace.diagnostics, ...result.diagnostics]
    }
    if (result.statements.some((item) =>
      (item.rowsAffected ?? 0) > 0 || !item.resultId
    )) {
      workspace.dirty = true
    }

    if (statement?.resultId) {
      await loadResultPage({
        resultId: statement.resultId,
        offset: 0,
        limit: resultPageSize.value,
      })
    }

    // DDL/DML 后同步表名与列名补全；SELECT 刷新也只是元数据操作。
    await refreshSchema(false)
    // 执行成功后记录到查询历史（由保存设置决定是否持久化）。
    sqlEditor.value?.recordHistory(value)
  } catch (reason) {
    sqlError.value = reportError(reason)
  } finally {
    executing.value = false
    endBusy()
  }
}

function handlePageChange(change: ResultPageChange): void {
  if (!workspace.activeResultId) {
    resultError.value = '当前结果没有可分页的结果句柄，请重新执行查询。'
    return
  }
  void loadResultPage({
    resultId: workspace.activeResultId,
    offset: change.offset,
    limit: change.limit,
  })
}

function refreshResult(): void {
  if (workspace.activeResultId) {
    void loadResultPage({
      resultId: workspace.activeResultId,
      offset: resultOffset.value,
      limit: resultPageSize.value,
    })
  } else if (executedSql.value) {
    void executeSql(executedSql.value)
  }
}

function selectTable(tableName: string): void {
  workspace.activeTableName = tableName
  emit('select-table', tableName)
}

async function previewTable(tableName: string): Promise<void> {
  selectTable(tableName)
  const query = `SELECT *\nFROM ${quoteSqliteIdentifier(tableName)}\nLIMIT ${resultPageSize.value};`
  // 编辑器有用户内容（非空、非默认模板、非同一查询）时，先提示「查询会清空编辑器」。
  const editorUnused = !sql.value.trim() || sql.value === props.initialSql
  if (!editorUnused && sql.value !== query) {
    pendingPreview.value = { tableName, query }
    previewConfirmVisible.value = true
    return
  }
  await runPreview(query)
}

const pendingPreview = ref<{ tableName: string; query: string } | null>(null)
const previewConfirmVisible = ref(false)

async function confirmPreview(): Promise<boolean> {
  const pending = pendingPreview.value
  previewConfirmVisible.value = false
  pendingPreview.value = null
  if (!pending) return true
  await runPreview(pending.query)
  return true
}

function cancelPreview(): void {
  pendingPreview.value = null
  previewConfirmVisible.value = false
}

async function runPreview(query: string): Promise<void> {
  sql.value = query
  await nextTick()
  sqlEditor.value?.focus()
  await executeSql(query)
}

function openImport(): void {
  importError.value = ''
  notice.value = ''
  importVisible.value = true
}

async function finishImport(
  result: WorkspaceOperationResult | void,
  fallbackName?: string,
): Promise<void> {
  await applyMutationResult(result, fallbackName)
  workspace.dirty = true
  const tableName = result?.activeTableName ?? result?.table?.name ?? fallbackName
  const count = result?.recordCount
  notice.value = `导入完成${tableName ? `：${tableName}` : ''}${count === undefined ? '' : `，共 ${count} 行`}。`
}

async function handleImport(request: FileImportRequest): Promise<void> {
  emit('import-request', request)
  const api = integration.value
  if (!api?.importFile) {
    importError.value = missingIntegration('importFile')
    return
  }

  importLoading.value = true
  importError.value = ''
  notice.value = ''
  beginBusy()
  try {
    if (api.prepareImport && request.format !== 'sqlite') {
      const preparation = await api.prepareImport(request)
      pendingImport.value = request
      pendingImportContext.value = preparation.context
      pendingSourceSchema.value = preparation.sourceSchema
      mappingTargetName.value = preparation.targetTableName
      mappingColumns.value = []
      mappingError.value = ''
      importVisible.value = false
      mappingVisible.value = true
    } else {
      const result = await api.importFile(request)
      await finishImport(result, result?.table?.name)
      importVisible.value = false
      importPanel.value?.reset()
    }
  } catch (reason) {
    importError.value = reportError(reason)
  } finally {
    importLoading.value = false
    endBusy()
  }
}

function clearPendingImport(): void {
  pendingImport.value = null
  pendingImportContext.value = undefined
  pendingSourceSchema.value = null
  mappingColumns.value = []
  mappingTargetName.value = ''
}

async function handleMappingSubmit(mapping: ImportMapping): Promise<void> {
  emit('mapping-submit', mapping)
  const request = pendingImport.value
  const api = integration.value
  const importFile = api?.importFile?.bind(api)
  if (!request || !importFile) {
    mappingError.value = missingIntegration('importFile')
    return
  }

  importLoading.value = true
  mappingError.value = ''
  beginBusy()
  try {
    const result = await importFile(request, mapping, pendingImportContext.value)
    await finishImport(result, mapping.targetTableName)
    mappingVisible.value = false
    importPanel.value?.reset()
    clearPendingImport()
  } catch (reason) {
    mappingError.value = reportError(reason)
  } finally {
    importLoading.value = false
    endBusy()
  }
}

function cancelMapping(): void {
  if (importLoading.value) return
  mappingVisible.value = false
  mappingError.value = ''
  clearPendingImport()
}

/** 深度类型检测：按行数上限重新推断，并同步映射表与源 schema 的显示。 */
async function handleDetectTypes(limit: number | null): Promise<void> {
  const request = pendingImport.value
  const api = integration.value
  const infer = api?.inferSourceTypes?.bind(api)
  if (!request || !infer) {
    mappingError.value = missingIntegration('inferSourceTypes')
    return
  }

  detectingTypes.value = true
  try {
    const { dataTypes } = await infer(request, pendingImportContext.value, limit)
    mappingEditor.value?.applyInferredTypes(dataTypes)
    if (pendingSourceSchema.value) {
      pendingSourceSchema.value = {
        ...pendingSourceSchema.value,
        columns: pendingSourceSchema.value.columns.map((column, index) => ({
          ...column,
          dataType: dataTypes[index] ?? column.dataType,
        })),
      }
    }
  } catch (reason) {
    mappingError.value = reportError(reason)
  } finally {
    detectingTypes.value = false
  }
}

function clearLocalResult(): void {
  pageRequestSequence += 1
  workspace.activeResultId = null
  resultColumns.value = []
  resultRows.value = []
  resultOffset.value = 0
  resultTotalRows.value = undefined
  resultDuration.value = null
  rowsAffected.value = null
  resultError.value = ''
  sqlError.value = ''
  hasExecuted.value = false
  hasQueryResult.value = false
  executedSql.value = ''
}

async function createWorkspace(): Promise<boolean> {
  emit('new-workspace')
  const api = integration.value
  const create = api?.createWorkspace?.bind(api)
  if (!create) {
    newError.value = missingIntegration('createWorkspace')
    return false
  }

  newLoading.value = true
  newError.value = ''
  beginBusy()
  try {
    const result = await create()
    workspace.reset()
    clearLocalResult()
    sql.value = props.initialSql
    await applyMutationResult(result)
    workspace.dirty = false
    newVisible.value = false
    notice.value = '已新建空白工作区。'
    return true
  } catch (reason) {
    newError.value = reportError(reason)
    return false
  } finally {
    newLoading.value = false
    endBusy()
  }
}

function openExport(): void {
  exportError.value = ''
  exportVisible.value = true
}

async function handleExport(options: WorkspaceExportOptions): Promise<void> {
  if (options.selection.kind === 'query' && workspace.activeResultId) {
    options = {
      ...options,
      selection: { ...options.selection, resultId: workspace.activeResultId },
    }
  }
  emit('export-request', options)
  const api = integration.value
  const exportData = api?.exportData?.bind(api)
  if (!exportData) {
    exportError.value = missingIntegration('exportData')
    return
  }

  exportLoading.value = true
  exportError.value = ''
  beginBusy()
  try {
    await exportData(options)
    if (options.format === 'sqlite' && options.selection.kind === 'workspace') {
      workspace.dirty = false
    }
    exportVisible.value = false
    notice.value = `导出任务已完成：${options.fileName}。`
  } catch (reason) {
    exportError.value = reportError(reason)
  } finally {
    exportLoading.value = false
    endBusy()
  }
}

function locateDiagnostic(diagnostic: Diagnostic): void {
  if (diagnostic.location?.tableName) selectTable(diagnostic.location.tableName)
}

/** 侧边栏操作（改名/删除）没有专属弹窗，错误统一进入诊断列表。 */
function pushSidebarError(code: string, message: string): void {
  workspace.diagnostics = [
    ...workspace.diagnostics,
    { code, severity: 'error', message },
  ]
}

async function handleTableRename(payload: { tableName: string; newName: string }): Promise<void> {
  const api = integration.value
  const rename = api?.renameTable?.bind(api)
  if (!rename) {
    pushSidebarError('RENAME_NOT_AVAILABLE', missingIntegration('renameTable'))
    return
  }

  renameLoading.value = true
  beginBusy()
  try {
    const result = await rename(payload.tableName, payload.newName)
    await applyMutationResult(result, payload.newName)
    workspace.dirty = true
    notice.value = `已重命名数据表：${payload.tableName} → ${payload.newName}。`
  } catch (reason) {
    pushSidebarError('TABLE_RENAME_FAILED', reportError(reason))
  } finally {
    renameLoading.value = false
    endBusy()
  }
}

async function confirmDeleteTable(): Promise<boolean> {
  const tableName = pendingDeleteTable.value
  const api = integration.value
  const deleteTable = api?.deleteTable?.bind(api)
  if (!tableName || !deleteTable) {
    pushSidebarError('DELETE_NOT_AVAILABLE', missingIntegration('deleteTable'))
    return false
  }

  deleteLoading.value = true
  beginBusy()
  try {
    const result = await deleteTable(tableName)
    // 删除的是当前激活表时，同步清空遗留的查询结果，避免展示失效数据。
    if (workspace.activeTableName === tableName) clearLocalResult()
    await applyMutationResult(result)
    workspace.dirty = true
    notice.value = `已删除数据表：${tableName}。`
    pendingDeleteTable.value = null
    return true
  } catch (reason) {
    pushSidebarError('TABLE_DELETE_FAILED', reportError(reason))
    return false
  } finally {
    deleteLoading.value = false
    endBusy()
  }
}

/** 侧边栏拖入文件：自动打开导入弹窗并预选该文件。 */
const sidebarDropActive = ref(false)

function containsFiles(event: DragEvent): boolean {
  return [...(event.dataTransfer?.types ?? [])].includes('Files')
}

function onSidebarDragOver(event: DragEvent): void {
  if (!containsFiles(event)) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
  sidebarDropActive.value = true
}

function onSidebarDragLeave(event: DragEvent): void {
  const aside = event.currentTarget as HTMLElement | null
  if (event.relatedTarget && aside?.contains(event.relatedTarget as Node)) return
  sidebarDropActive.value = false
}

async function onSidebarDrop(event: DragEvent): Promise<void> {
  event.preventDefault()
  sidebarDropActive.value = false
  const files = [...(event.dataTransfer?.files ?? [])]
  if (!files.length) return

  openImport()
  if (files.length > 1) {
    importError.value = '每次只能导入一个文件，已载入第一个文件，其余已忽略。'
  }
  await nextTick()
  importPanel.value?.setFile(files[0] ?? null)
}

watch(
  () => props.initialSql,
  (value) => {
    sql.value = value
  },
)
watch(integration, (api, previous) => {
  if (api && api !== previous) void refreshSchema(false)
})

onMounted(() => {
  void refreshSchema(false)
})
</script>

<template>
  <n-config-provider :locale="zhCN" :theme-overrides="themeOverrides">
    <main class="workspace" @dragover.prevent @drop.prevent>
      <header class="workspace__header">
        <div class="workspace__brand">
          <div>
            <h1>数据转换工具</h1>
            <p>DBF · SQLite · XLSX · CSV</p>
          </div>
        </div>
        <div class="workspace__toolbar" aria-label="工作区工具栏">
          <n-tag :type="statusType" size="small" :bordered="false" class="workspace__status">
            {{ statusText }}
          </n-tag>
          <n-button type="primary" :disabled="working" @click="openImport">
            导入文件
          </n-button>
          <n-button :disabled="working" @click="newVisible = true; newError = ''">
            新建工作区
          </n-button>
          <n-button :disabled="working || !canExport" @click="openExport">
            导出
          </n-button>
        </div>
      </header>

      <n-alert v-if="notice" type="success" closable class="workspace__notice" @close="notice = ''">
        {{ notice }}
      </n-alert>

      <div class="workspace__layout" :style="layoutStyle">
        <aside
          ref="sidebarAside"
          class="workspace__sidebar"
          :class="{ 'workspace__sidebar--drop': sidebarDropActive }"
          @dragover="onSidebarDragOver"
          @dragleave="onSidebarDragLeave"
          @drop="onSidebarDrop"
        >
          <SchemaNavigator
            :schema="workspace.schema"
            :active-table-name="workspace.activeTableName"
            :loading="schemaLoading || renameLoading"
            :error="schemaError"
            @select="selectTable"
            @preview="previewTable"
            @insert="sqlEditor?.insertText($event)"
            @insert-table="sqlEditor?.insertText(quoteSqliteIdentifier($event))"
            @refresh="refreshSchema()"
            @remove="pendingDeleteTable = $event"
            @rename="handleTableRename"
          />
          <section class="workspace__storage-note">
            <strong>本地会话</strong>
            <p>数据保留在浏览器内存中。刷新或关闭页面前，请导出需要保留的成果。</p>
          </section>
        </aside>

        <div
          class="workspace__resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="调整侧边栏宽度"
          :aria-valuenow="sidebarWidth"
          :aria-valuemin="SIDEBAR_MIN_WIDTH"
          :aria-valuemax="SIDEBAR_MAX_WIDTH"
          tabindex="0"
          title="拖动或用 ←/→ 调整宽度（Shift 加速），双击恢复默认"
          @pointerdown="dragSidebar"
          @dblclick="resetSidebarWidth"
          @keydown="onSidebarResizerKeydown"
        />

        <div class="workspace__content">
          <SqlEditor
            ref="sqlEditor"
            v-model="sql"
            :schema="workspace.schema"
            :loading="executing"
            :disabled="importLoading || newLoading"
            :error="sqlError"
            @execute="executeSql"
          />
          <ResultGrid
            :columns="resultColumns"
            :rows="resultRows"
            :offset="resultOffset"
            :total-rows="resultTotalRows"
            :page-size="resultPageSize"
            :loading="resultLoading || executing"
            :executed="hasExecuted"
            :error="resultError"
            :duration-ms="resultDuration"
            :rows-affected="rowsAffected"
            @page-change="handlePageChange"
            @refresh="refreshResult"
            @group-columns-change="resultGroupColumns = $event"
          />
          <DiagnosticList
            :diagnostics="workspace.diagnostics"
            @clear="workspace.diagnostics = []"
            @locate="locateDiagnostic"
          />
        </div>
      </div>

      <n-modal
        v-model:show="importVisible"
        preset="card"
        title="导入到工作区"
        :style="{ width: 'min(760px, calc(100vw - 32px))' }"
        :mask-closable="!importLoading"
        :close-on-esc="!importLoading"
        :closable="!importLoading"
      >
        <FileImportPanel
          ref="importPanel"
          :loading="importLoading"
          :error="importError"
          :default-encoding="settings.defaultEncoding"
          :default-strict="settings.strictDbfImport"
          @submit="handleImport"
          @cancel="importVisible = false"
          @clear-error="importError = ''"
        />
      </n-modal>

      <n-modal
        v-model:show="mappingVisible"
        preset="card"
        title="确认导入映射"
        :style="{ width: 'min(1220px, calc(100vw - 32px))' }"
        :mask-closable="!importLoading"
        :close-on-esc="!importLoading"
        :closable="!importLoading"
        @update:show="!$event && cancelMapping()"
      >
        <ColumnMappingEditor
          v-if="pendingSourceSchema"
          ref="mappingEditor"
          v-model="mappingColumns"
          v-model:target-table-name="mappingTargetName"
          :source-schema="pendingSourceSchema"
          :loading="importLoading"
          :error="mappingError"
          :supports-type-inference="pendingImport?.format === 'csv' || pendingImport?.format === 'xlsx'"
          :detecting="detectingTypes"
          @submit="handleMappingSubmit"
          @cancel="cancelMapping"
          @detect-types="handleDetectTypes"
        />
      </n-modal>

      <ExportDialog
        v-model:show="exportVisible"
        :tables="workspace.schema.tables"
        :active-table-name="workspace.activeTableName"
        :query-sql="executedSql"
        :has-query-result="hasQueryResult"
        :group-columns="resultGroupColumns"
        :groupable-table-name="groupableTableName"
        :loading="exportLoading"
        :error="exportError"
        :default-strict="settings.strictDbfExport"
        :default-include-metadata="settings.includeSqliteMetadata"
        @submit="handleExport"
        @clear-error="exportError = ''"
      />

      <n-modal
        v-model:show="newVisible"
        preset="dialog"
        title="新建空白工作区？"
        positive-text="新建工作区"
        negative-text="取消"
        :positive-button-props="{ type: 'primary', loading: newLoading }"
        :negative-button-props="{ disabled: newLoading }"
        :mask-closable="!newLoading"
        :close-on-esc="!newLoading"
        :closable="!newLoading"
        @positive-click="createWorkspace"
        @negative-click="newVisible = false"
      >
        <div class="workspace__new-dialog">
          <p>当前内存工作区将被清空。此操作无法撤销，请先导出需要保留的数据。</p>
          <n-alert v-if="newError" type="error">{{ newError }}</n-alert>
        </div>
      </n-modal>

      <n-modal
        :show="previewConfirmVisible"
        preset="dialog"
        title="清空 SQL 编辑器？"
        positive-text="继续并执行查询"
        negative-text="取消"
        @positive-click="confirmPreview"
        @negative-click="cancelPreview"
        @update:show="(show: boolean) => { if (!show) cancelPreview() }"
      >
        <div class="workspace__new-dialog">
          <p>
            SQL 编辑器中已有内容。点击数据表旁的「查询」会
            <strong>清空当前内容</strong>
            并替换为「{{ pendingPreview?.tableName }}」的预览查询，是否继续？
          </p>
        </div>
      </n-modal>

      <n-modal
        :show="pendingDeleteTable !== null"
        preset="dialog"
        title="删除数据表？"
        positive-text="删除数据表"
        negative-text="取消"
        :positive-button-props="{ type: 'error', loading: deleteLoading }"
        :negative-button-props="{ disabled: deleteLoading }"
        :mask-closable="!deleteLoading"
        :close-on-esc="!deleteLoading"
        :closable="!deleteLoading"
        @positive-click="confirmDeleteTable"
        @negative-click="pendingDeleteTable = null"
        @update:show="(show: boolean) => { if (!show) pendingDeleteTable = null }"
      >
        <div class="workspace__new-dialog">
          <p>
            将删除数据表
            <strong>{{ pendingDeleteTable }}</strong>
            及其全部数据，此操作无法撤销。请先导出需要保留的数据。
          </p>
        </div>
      </n-modal>
    </main>
  </n-config-provider>
</template>
