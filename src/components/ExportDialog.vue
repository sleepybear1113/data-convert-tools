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
import type { WorkspaceExportOptions } from './contracts'

type SourceKind = DataSelection['kind']

const props = withDefaults(
  defineProps<{
    show?: boolean
    tables?: readonly SqliteTableInfo[]
    activeTableName?: string | null
    querySql?: string
    hasQueryResult?: boolean
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
const format = ref<ExportFormat>('dbf')
const fileName = ref('export.dbf')
const fileNameTouched = ref(false)
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
const formatOptions: Array<{ label: string; value: ExportFormat }> = [
  { label: 'DBF', value: 'dbf' },
  { label: 'CSV', value: 'csv' },
  { label: 'XLSX', value: 'xlsx' },
  { label: 'SQLite', value: 'sqlite' },
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
const extension = computed(() => `.${format.value}`)
const displayError = computed(() => localError.value || props.error || '')
const canSubmit = computed(() => {
  if (!fileName.value.trim() || props.loading) return false
  if (source.value === 'table' && !tableName.value) return false
  if (source.value === 'query' && (!props.hasQueryResult || !props.querySql.trim())) return false
  if (format.value === 'xlsx' && !sheetName.value.trim()) return false
  return true
})

function suggestedBaseName(): string {
  if (source.value === 'table') return tableName.value || 'table_export'
  if (source.value === 'query') return 'query_result'
  return 'workspace'
}

function updateSuggestedFileName(): void {
  if (!fileNameTouched.value) fileName.value = `${suggestedBaseName()}${extension.value}`
}

watch(
  () => props.show,
  (show) => {
    if (!show) return
    localError.value = ''
    tableName.value = props.activeTableName || props.tables[0]?.name || ''
    source.value = tableName.value
      ? 'table'
      : props.hasQueryResult
        ? 'query'
        : 'workspace'
    format.value = source.value === 'workspace' ? 'sqlite' : 'dbf'
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

function updateFileName(value: string): void {
  fileName.value = value
  fileNameTouched.value = true
}

function normalizedFileName(): string {
  const base = fileName.value
    .trim()
    .replace(/\.(dbf|csv|xlsx|sqlite|sqlite3|db)$/i, '')
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
  })
}
</script>

<template>
  <n-modal
    :show="show"
    preset="card"
    title="导出数据"
    class="export-dialog"
    :style="{ width: 'min(680px, calc(100vw - 32px))' }"
    :mask-closable="!loading"
    :close-on-esc="!loading"
    :closable="!loading"
    @update:show="onVisibilityChange"
  >
    <div class="export-dialog__body">
      <section class="export-dialog__section">
        <h3>1. 数据来源</h3>
        <n-radio-group v-model:value="source" :disabled="loading">
          <n-radio-button value="table" :disabled="!tables.length">数据表</n-radio-button>
          <n-radio-button value="query" :disabled="!hasQueryResult">当前查询</n-radio-button>
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
        <div class="export-dialog__format-row">
          <n-radio-group v-model:value="format" :disabled="loading || source === 'workspace'">
            <n-radio-button
              v-for="option in formatOptions"
              :key="option.value"
              :value="option.value"
            >
              {{ option.label }}
            </n-radio-button>
          </n-radio-group>
        </div>
        <label class="export-dialog__field">
          <span>文件名</span>
          <n-input
            :value="fileName"
            :disabled="loading"
            placeholder="export.dbf"
            @update:value="updateFileName"
          />
        </label>
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
  gap: 18px;
}

.export-dialog__section {
  padding: 0 0 18px;
  border: 0;
  border-bottom: 1px solid var(--border-color);
  border-radius: 0;
  background: transparent;
}

.export-dialog__section h3 {
  margin: 0 0 12px;
  color: #334155;
  font-size: 13px;
}

.export-dialog__field {
  display: grid;
  gap: 7px;
  margin-top: 14px;
  color: #64748b;
  font-size: 12px;
}

.export-dialog__format-row {
  overflow-x: auto;
}

.export-dialog__query {
  margin-top: 14px;
  color: var(--text-muted);
  font-size: 12px;
}

.export-dialog__query pre {
  overflow: auto;
  max-height: 120px;
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
  gap: 10px;
  margin-top: 16px;
}

.export-dialog__notice {
  margin-top: 14px;
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
