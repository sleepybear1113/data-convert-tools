<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  NAlert,
  NButton,
  NCheckbox,
  NInput,
  NModal,
  NRadioButton,
  NRadioGroup,
  NSelect,
} from 'naive-ui'

import type { SqliteTableInfo } from '../core/database/schema'
import type { DataSelection, ExportFormat } from '../core/model/conversion'
import { exportFileTimestamp } from '../core/utils/timestamp'
import type { WorkspaceExportOptions } from './contracts'

type SourceKind = DataSelection['kind']

const props = withDefaults(
  defineProps<{
    show?: boolean
    tables?: readonly SqliteTableInfo[]
    activeTableName?: string | null
    querySql?: string
    hasQueryResult?: boolean
    /** 结果表格中勾选的分组依据列；非空时展示「按勾选列分组导出」选项。 */
    groupColumns?: readonly string[]
    /**
     * 当前查询对应的单表（SQL 为简单 SELECT/LIMIT 时）。
     * 此时「选中的数据表」来源也可按勾选列对整表分组导出。
     */
    groupableTableName?: string | null
    loading?: boolean
    error?: string | null
    defaultStrict?: boolean
    defaultIncludeMetadata?: boolean
  }>(),
  {
    show: false,
    tables: () => [],
    activeTableName: null,
    querySql: '',
    hasQueryResult: false,
    groupColumns: () => [],
    groupableTableName: null,
    loading: false,
    error: null,
    defaultStrict: true,
    defaultIncludeMetadata: true,
  },
)

const emit = defineEmits<{
  'update:show': [show: boolean]
  submit: [options: WorkspaceExportOptions]
  cancel: []
  'clear-error': []
}>()

const source = ref<SourceKind>('table')
const tableName = ref('')
const format = ref<ExportFormat>('xlsx')
const fileName = ref('')
const fileNameTouched = ref(false)
const grouped = ref(false)
const exportTimestamp = ref(new Date())
const strict = ref(props.defaultStrict)
const includeMetadata = ref(props.defaultIncludeMetadata)
const encoding = ref<'utf-8' | 'gbk' | 'gb18030'>('gbk')
const bom = ref(true)
const delimiter = ref(',')
const lineEnding = ref<'\n' | '\r\n'>('\r\n')
const includeHeader = ref(true)
const sheetName = ref('Sheet1')
const localError = ref('')

const tableOptions = computed(() =>
  props.tables.map((table) => ({ label: table.name, value: table.name })),
)
// 次序：Excel、SQLite、DBF、CSV。
const formatOptions: Array<{ label: string; value: ExportFormat }> = [
  { label: 'Excel (.xlsx)', value: 'xlsx' },
  { label: 'SQLite', value: 'sqlite' },
  { label: 'DBF', value: 'dbf' },
  { label: 'CSV', value: 'csv' },
]
const encodingOptions = computed(() => {
  const options = [
    { label: 'UTF-8', value: 'utf-8' },
    { label: 'GBK', value: 'gbk' },
    { label: 'GB18030', value: 'gb18030' },
  ]
  return format.value === 'csv' ? options.slice(0, 2) : options
})
const delimiterOptions = [
  { label: '逗号（,）', value: ',' },
  { label: '分号（;）', value: ';' },
  { label: '制表符（Tab）', value: '\t' },
  { label: '竖线（|）', value: '|' },
]
const lineEndingOptions = [
  { label: 'CRLF（Windows）', value: '\r\n' },
  { label: 'LF（Unix）', value: '\n' },
]
const extension = computed(() => (grouped.value ? '.zip' : `.${format.value}`))
const displayError = computed(() => localError.value || props.error || '')
/** 当前来源是否可分组导出：查询来源始终可；表来源仅当该表就是当前简单查询读取的表。 */
const canGroupExport = computed(() => {
  if (!props.groupColumns.length) return false
  if (source.value === 'query') return true
  if (source.value === 'table') {
    const groupable = props.groupableTableName?.toLowerCase()
    return Boolean(groupable) && tableName.value.toLowerCase() === groupable
  }
  return false
})
/** 分组导出的数据范围说明。 */
const groupedScopeText = computed(() => {
  if (source.value === 'query') return '按列值拆分当前查询结果'
  return `按列值拆分数据表「${tableName.value}」的全部数据`
})
const canSubmit = computed(() => {
  if (!fileName.value.trim() || props.loading) return false
  if (source.value === 'table' && !tableName.value) return false
  if (source.value === 'query' && (!props.hasQueryResult || !props.querySql.trim())) return false
  if (format.value === 'xlsx' && !sheetName.value.trim()) return false
  if (grouped.value && !canGroupExport.value) return false
  return true
})

function stripExtension(fileName: string | undefined): string | undefined {
  if (!fileName) return undefined
  const base = fileName.replace(/\.[^.]+$/, '').trim()
  return base || undefined
}

/** 「原文件名」：优先导入源文件名；SQL 建表回退为表名。 */
function suggestedBaseName(): string {
  if (source.value === 'table') {
    const info = props.tables.find((table) => table.name === tableName.value)
    return stripExtension(info?.sourceFileName) || tableName.value || 'table_export'
  }
  if (source.value === 'query') {
    if (props.tables.length === 1) {
      const only = props.tables[0]
      return stripExtension(only.sourceFileName) || only.name
    }
    return 'query_result'
  }
  return 'workspace'
}

function updateSuggestedFileName(): void {
  if (fileNameTouched.value) return
  const marker = grouped.value ? '分组导出' : '导出'
  fileName.value = `${suggestedBaseName()}_${marker}_${exportFileTimestamp(exportTimestamp.value)}${extension.value}`
}

watch(
  () => props.show,
  (show) => {
    if (!show) return
    localError.value = ''
    exportTimestamp.value = new Date()
    grouped.value = false
    tableName.value = props.activeTableName || props.tables[0]?.name || ''
    source.value = tableName.value
      ? 'table'
      : props.hasQueryResult
        ? 'query'
        : 'workspace'
    format.value = source.value === 'workspace' ? 'sqlite' : 'xlsx'
    strict.value = props.defaultStrict
    includeMetadata.value = props.defaultIncludeMetadata
    fileNameTouched.value = false
    updateSuggestedFileName()
  },
)

watch(source, (value) => {
  localError.value = ''
  emit('clear-error')
  if (value === 'workspace') format.value = 'sqlite'
  if (value === 'table' && !tableName.value) tableName.value = props.tables[0]?.name || ''
  updateSuggestedFileName()
})
watch(tableName, updateSuggestedFileName)
watch(format, (value, previous) => {
  if (value === 'csv' && previous !== 'csv') encoding.value = 'utf-8'
  if (value === 'dbf' && previous !== 'dbf') encoding.value = 'gbk'
  if (value === 'csv' && encoding.value === 'gb18030') encoding.value = 'utf-8'
  updateSuggestedFileName()
})
watch(grouped, () => {
  localError.value = ''
  updateSuggestedFileName()
})
// 当前来源不再支持分组时（切换来源/表名），自动取消勾选。
watch(canGroupExport, (supported) => {
  if (grouped.value && !supported) grouped.value = false
})
watch(
  () => props.groupColumns,
  (columns) => {
    if (grouped.value && !columns.length) grouped.value = false
  },
)

function updateFileName(value: string): void {
  fileName.value = value
  fileNameTouched.value = true
}

function normalizedFileName(): string {
  const base = fileName.value
    .trim()
    .replace(/\.(dbf|csv|xlsx|sqlite|sqlite3|db|zip)$/i, '')
  return `${base || suggestedBaseName()}${extension.value}`
}

function close(): void {
  if (props.loading) return
  emit('update:show', false)
  emit('cancel')
}

function onVisibilityChange(show: boolean): void {
  if (!show) close()
  else emit('update:show', true)
}

function submit(): void {
  localError.value = ''
  if (!canSubmit.value) {
    localError.value = '请完整填写来源、文件名和目标格式选项。'
    return
  }

  let selection: DataSelection
  if (source.value === 'table') selection = { kind: 'table', tableName: tableName.value }
  else if (source.value === 'query') selection = { kind: 'query', sql: props.querySql }
  else selection = { kind: 'workspace' }

  if (selection.kind === 'workspace' && format.value !== 'sqlite') {
    localError.value = '整个工作区只能导出为 SQLite；其他格式请选择数据表或查询。'
    return
  }
  if (grouped.value && !canGroupExport.value) {
    localError.value = '当前来源不支持分组导出。'
    return
  }

  const csvEncoding = encoding.value === 'gbk' ? 'gbk' : 'utf-8'
  emit('submit', {
    selection,
    format: format.value,
    fileName: normalizedFileName(),
    strict: strict.value,
    includeMetadata: includeMetadata.value,
    encoding: format.value === 'csv' ? csvEncoding : encoding.value,
    csv: {
      encoding: csvEncoding,
      bom: bom.value,
      delimiter: delimiter.value,
      lineEnding: lineEnding.value,
      includeHeader: includeHeader.value,
    },
    xlsx: {
      sheetName: sheetName.value.trim(),
      includeHeader: includeHeader.value,
    },
    ...(grouped.value ? { groupBy: [...props.groupColumns] } : {}),
  })
}
</script>

<template>
  <n-modal
    :show="show"
    preset="card"
    title="导出数据"
    class="export-dialog"
    :style="{ width: 'min(720px, calc(100vw - 32px))' }"
    :mask-closable="!loading"
    :close-on-esc="!loading"
    :closable="!loading"
    @update:show="onVisibilityChange"
  >
    <div class="export-dialog__body">
      <section class="export-dialog__section">
        <h3>1. 数据来源</h3>
        <n-radio-group v-model:value="source" :disabled="loading">
          <n-radio-button value="table" :disabled="!tables.length">选中的数据表</n-radio-button>
          <n-radio-button value="query" :disabled="!hasQueryResult">当前查询结果</n-radio-button>
          <n-radio-button value="workspace">整个工作区</n-radio-button>
        </n-radio-group>

        <label v-if="source === 'table'" class="export-dialog__field">
          <span>选择数据表</span>
          <n-select
            v-model:value="tableName"
            :options="tableOptions"
            placeholder="请选择数据表"
            :disabled="loading"
          />
        </label>
        <div v-else-if="source === 'query'" class="export-dialog__query">
          <span>将导出以下 SQL 的当前结果，不会重复执行</span>
          <pre>{{ querySql }}</pre>
        </div>
        <n-alert v-else type="info" :show-icon="false" class="export-dialog__notice">
          导出完整 SQLite 工作数据库；DBF、CSV、XLSX 仅支持单表或查询来源。
        </n-alert>
      </section>

      <section class="export-dialog__section">
        <h3>2. 文件与格式</h3>
        <div class="export-dialog__file-row">
          <n-radio-group
            class="export-dialog__format-row"
            v-model:value="format"
            :disabled="loading || source === 'workspace'"
          >
            <n-radio-button
              v-for="option in formatOptions"
              :key="option.value"
              :value="option.value"
            >
              {{ option.label }}
            </n-radio-button>
          </n-radio-group>
          <label class="export-dialog__field export-dialog__file-name">
            <span>文件名</span>
            <n-input
              :value="fileName"
              :disabled="loading"
              placeholder="导出_20261106_153020.xlsx"
              @update:value="updateFileName"
            />
          </label>
        </div>
        <div v-if="canGroupExport" class="export-dialog__grouped">
          <n-checkbox v-model:checked="grouped" :disabled="loading">
            按勾选列分组导出
          </n-checkbox>
          <span class="export-dialog__grouped-hint">
            {{ groupedScopeText }}；依据列：{{ props.groupColumns.join('、') }}。每组一个
            .{{ format }} 文件，打包为 ZIP 压缩包下载。
          </span>
        </div>
      </section>

      <section class="export-dialog__section">
        <h3>3. 转换选项</h3>
        <div class="export-dialog__options-grid">
          <label v-if="format === 'dbf' || format === 'csv'" class="export-dialog__field">
            <span>文本编码</span>
            <n-select v-model:value="encoding" :options="encodingOptions" :disabled="loading" />
          </label>
          <label v-if="format === 'csv'" class="export-dialog__field">
            <span>分隔符</span>
            <n-select v-model:value="delimiter" :options="delimiterOptions" :disabled="loading" />
          </label>
          <label v-if="format === 'csv'" class="export-dialog__field">
            <span>换行符</span>
            <n-select v-model:value="lineEnding" :options="lineEndingOptions" :disabled="loading" />
          </label>
          <label v-if="format === 'xlsx'" class="export-dialog__field">
            <span>工作表名称</span>
            <n-input v-model:value="sheetName" :maxlength="31" :disabled="loading" />
          </label>
        </div>

        <div class="export-dialog__checks">
          <n-checkbox v-if="format === 'dbf'" v-model:checked="strict" :disabled="loading">
            严格模式：字段溢出、不可编码字符或不支持的类型会中止导出
          </n-checkbox>
          <n-checkbox v-if="format === 'csv' || format === 'xlsx'" v-model:checked="includeHeader" :disabled="loading">
            包含表头
          </n-checkbox>
          <n-checkbox v-if="format === 'csv' && encoding === 'utf-8'" v-model:checked="bom" :disabled="loading">
            写入 UTF-8 BOM（便于 Excel 识别）
          </n-checkbox>
          <n-checkbox v-model:checked="includeMetadata" :disabled="loading">
            包含来源与转换元数据（目标格式支持时）
          </n-checkbox>
        </div>
        <n-alert v-if="format === 'dbf' && !strict" type="warning" :show-icon="false" class="export-dialog__notice">
          兼容模式可能截断文本、调整字段或降级类型；所有数据损失应记入诊断报告。
        </n-alert>
      </section>

      <n-alert v-if="displayError" type="error" class="export-dialog__error" closable @close="localError = ''; emit('clear-error')">
        {{ displayError }}
      </n-alert>
    </div>

    <template #footer>
      <div class="export-dialog__footer">
        <span>导出由父层数据适配器执行，本对话框不会直接访问数据库。</span>
        <div>
          <n-button :disabled="loading" @click="close">取消</n-button>
          <n-button type="primary" :loading="loading" :disabled="!canSubmit" @click="submit">
            开始导出
          </n-button>
        </div>
      </div>
    </template>
  </n-modal>
</template>

<style scoped>
.export-dialog__body {
  display: grid;
  gap: 12px;
}

.export-dialog__section {
  padding: 0 0 12px;
  border: 0;
  border-bottom: 1px solid var(--border-color);
  border-radius: 0;
  background: transparent;
}

.export-dialog__section h3 {
  margin: 0 0 10px;
  color: #334155;
  font-size: 13px;
}

.export-dialog__field {
  display: grid;
  gap: 6px;
  margin-top: 10px;
  color: #64748b;
  font-size: 12px;
}

.export-dialog__file-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 14px;
  align-items: end;
}

.export-dialog__format-row {
  white-space: nowrap;
}

.export-dialog__file-name {
  margin-top: 0;
}

.export-dialog__grouped {
  display: grid;
  gap: 5px;
  margin-top: 12px;
}

.export-dialog__grouped-hint {
  color: var(--text-muted);
  font-size: 11px;
  line-height: 1.6;
}

.export-dialog__query {
  margin-top: 10px;
  color: var(--text-muted);
  font-size: 12px;
}

.export-dialog__query pre {
  overflow: auto;
  max-height: 80px;
  margin: 7px 0 0;
  padding: 10px 12px;
  color: #334155;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: #f8fafc;
  font: 12px/1.6 "Cascadia Code", Consolas, monospace;
  white-space: pre-wrap;
}

.export-dialog__options-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0 14px;
}

.export-dialog__options-grid .export-dialog__field {
  margin-top: 0;
}

.export-dialog__checks {
  display: grid;
  gap: 8px;
  margin-top: 12px;
}

.export-dialog__notice {
  margin-top: 10px;
}

.export-dialog__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.export-dialog__footer > span {
  color: var(--text-muted);
  font-size: 11px;
}

.export-dialog__footer > div {
  display: flex;
  flex: 0 0 auto;
  gap: 8px;
}

@media (max-width: 640px) {
  .export-dialog__file-row {
    grid-template-columns: 1fr;
  }

  .export-dialog__options-grid {
    grid-template-columns: 1fr;
    gap: 12px;
  }

  .export-dialog__footer > span {
    display: none;
  }

  .export-dialog__footer {
    justify-content: flex-end;
  }
}
</style>
