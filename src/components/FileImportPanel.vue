<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  NAlert,
  NButton,
  NCheckbox,
  NInput,
  NInputNumber,
  NSelect,
  NTag,
} from 'naive-ui'

import type {
  FileImportRequest,
  ImportFormat,
  ImportFormatOption,
} from './contracts'

const props = withDefaults(
  defineProps<{
    disabled?: boolean
    loading?: boolean
    error?: string | null
    defaultEncoding?: string
    defaultStrict?: boolean
    accept?: string
  }>(),
  {
    disabled: false,
    loading: false,
    error: null,
    defaultEncoding: 'auto',
    defaultStrict: true,
    accept: '.dbf,.sqlite,.sqlite3,.db,.db3,.xlsx,.xls,.csv',
  },
)

const emit = defineEmits<{
  submit: [request: FileImportRequest]
  change: [file: File | null]
  cancel: []
  'clear-error': []
}>()

const input = ref<HTMLInputElement | null>(null)
const selectedFile = ref<File | null>(null)
const format = ref<ImportFormatOption>('auto')
const encoding = ref(props.defaultEncoding)
const delimiter = ref('auto')
const hasHeader = ref(true)
const sampleSize = ref(1000)
const includeDeleted = ref(false)
const strict = ref(props.defaultStrict)
const sheetName = ref('')
const headerRow = ref(1)
const inferDates = ref(true)
const dragging = ref(false)
const localError = ref('')

const formatOptions = [
  { label: '按扩展名自动识别', value: 'auto' },
  { label: 'DBF 数据表', value: 'dbf' },
  { label: 'SQLite 数据库', value: 'sqlite' },
  { label: 'Excel 工作簿', value: 'xlsx' },
  { label: 'CSV 文本', value: 'csv' },
]
const encodingOptions = [
  { label: '自动检测', value: 'auto' },
  { label: 'UTF-8', value: 'utf-8' },
  { label: 'GBK', value: 'gbk' },
  { label: 'GB18030', value: 'gb18030' },
  { label: 'Big5', value: 'big5' },
]
const delimiterOptions = [
  { label: '自动识别', value: 'auto' },
  { label: '逗号（,）', value: ',' },
  { label: '分号（;）', value: ';' },
  { label: '制表符（Tab）', value: '\t' },
  { label: '竖线（|）', value: '|' },
]

const resolvedFormat = computed<ImportFormat | null>(() => {
  if (format.value !== 'auto') return format.value
  return selectedFile.value ? inferFormat(selectedFile.value.name) : null
})
const needsEncoding = computed(
  () => resolvedFormat.value === 'dbf' || resolvedFormat.value === 'csv',
)
const displayError = computed(() => localError.value || props.error || '')
const fileSize = computed(() => {
  if (!selectedFile.value) return ''
  const bytes = selectedFile.value.size
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
})
const formatLabel = computed(() => {
  const labels: Record<ImportFormat, string> = {
    dbf: 'DBF',
    sqlite: 'SQLite',
    xlsx: 'XLSX',
    csv: 'CSV',
  }
  return resolvedFormat.value ? labels[resolvedFormat.value] : '未识别'
})

function inferFormat(fileName: string): ImportFormat | null {
  const extension = fileName.split('.').pop()?.toLowerCase()
  if (extension === 'dbf') return 'dbf'
  if (extension === 'csv') return 'csv'
  if (extension === 'xlsx' || extension === 'xls') return 'xlsx'
  if (['sqlite', 'sqlite3', 'db', 'db3'].includes(extension ?? '')) return 'sqlite'
  return null
}

function openPicker(): void {
  if (!props.disabled && !props.loading) input.value?.click()
}

function setFile(file: File | null): void {
  localError.value = ''
  emit('clear-error')
  selectedFile.value = file
  if (file) {
    const inferred = inferFormat(file.name)
    if (!inferred && format.value === 'auto') {
      localError.value = '无法按扩展名识别格式，请手动选择 DBF、SQLite、XLSX 或 CSV。'
    }
  }
  emit('change', file)
}

function onInputChange(event: Event): void {
  const target = event.target as HTMLInputElement
  setFile(target.files?.[0] ?? null)
  target.value = ''
}

function onDrop(event: DragEvent): void {
  dragging.value = false
  if (props.disabled || props.loading) return
  const files = event.dataTransfer?.files
  if (!files?.length) return
  if (files.length > 1) {
    localError.value = '每次导入一个文件，请分别添加多个文件。'
    return
  }
  setFile(files[0] ?? null)
}

function clearFile(): void {
  setFile(null)
  format.value = 'auto'
}

function reset(): void {
  clearFile()
  localError.value = ''
}

function submit(): void {
  localError.value = ''
  const file = selectedFile.value
  const currentFormat = resolvedFormat.value
  if (!file) {
    localError.value = '请先选择或拖入一个文件。'
    return
  }
  if (!currentFormat) {
    localError.value = '请选择有效的文件格式。'
    return
  }
  if (needsEncoding.value && !encoding.value) {
    localError.value = '请选择文件编码。'
    return
  }

  let request: FileImportRequest
  switch (currentFormat) {
    case 'dbf':
      request = {
        file,
        format: 'dbf',
        options: {
          encoding: encoding.value,
          includeDeleted: includeDeleted.value,
          strict: strict.value,
        },
      }
      break
    case 'csv':
      request = {
        file,
        format: 'csv',
        options: {
          encoding: encoding.value,
          delimiter: delimiter.value === 'auto' ? undefined : delimiter.value,
          hasHeader: hasHeader.value,
          sampleSize: sampleSize.value,
        },
      }
      break
    case 'xlsx':
      request = {
        file,
        format: 'xlsx',
        options: {
          sheetName: sheetName.value.trim() || undefined,
          headerRow: headerRow.value,
          inferDates: inferDates.value,
        },
      }
      break
    case 'sqlite':
      request = { file, format: 'sqlite', options: {} }
      break
  }
  emit('submit', request)
}

defineExpose({ reset, clearFile, setFile })
</script>

<template>
  <section class="file-import" aria-labelledby="file-import-title">
    <div class="section-heading">
      <div>
        <h2 id="file-import-title">导入文件</h2>
        <p class="section-description">文件仅在当前浏览器工作区处理，不会由界面组件上传。</p>
      </div>
      <n-tag v-if="selectedFile" size="small" type="info" :bordered="false">
        {{ formatLabel }}
      </n-tag>
    </div>

    <input
      ref="input"
      class="file-import__input"
      type="file"
      :accept="accept"
      :disabled="disabled || loading"
      @change="onInputChange"
    />

    <div
      class="file-import__dropzone"
      :class="{
        'file-import__dropzone--active': dragging,
        'file-import__dropzone--filled': selectedFile,
      }"
      @dragenter.prevent="dragging = true"
      @dragover.prevent="dragging = true"
      @dragleave.prevent="dragging = false"
      @drop.prevent="onDrop"
    >
      <template v-if="selectedFile">
        <div class="file-import__file-mark" aria-hidden="true">FILE</div>
        <div class="file-import__file-info">
          <strong :title="selectedFile.name">{{ selectedFile.name }}</strong>
          <span>{{ fileSize }} · {{ formatLabel }}</span>
        </div>
        <n-button quaternary size="small" :disabled="disabled || loading" @click="clearFile">
          移除
        </n-button>
      </template>
      <template v-else>
        <div class="file-import__drop-copy">
          <strong>拖放文件到这里</strong>
          <span>支持 DBF、SQLite、XLSX、CSV，每次一个文件</span>
        </div>
        <n-button secondary type="primary" :disabled="disabled || loading" @click="openPicker">
          选择文件
        </n-button>
      </template>
    </div>

    <n-alert v-if="displayError" type="error" class="file-import__alert" closable @close="localError = ''; emit('clear-error')">
      {{ displayError }}
    </n-alert>

    <div class="file-import__form">
      <label class="field-label">
        <span>文件格式</span>
        <n-select v-model:value="format" :options="formatOptions" :disabled="disabled || loading" />
      </label>
      <label v-if="needsEncoding" class="field-label">
        <span>文件编码</span>
        <n-select v-model:value="encoding" :options="encodingOptions" :disabled="disabled || loading" />
      </label>
    </div>

    <div v-if="resolvedFormat === 'csv'" class="file-import__format-options">
      <label class="field-label">
        <span>分隔符</span>
        <n-select v-model:value="delimiter" :options="delimiterOptions" :disabled="disabled || loading" />
      </label>
      <label class="field-label">
        <span>类型推断抽样行数</span>
        <n-input-number v-model:value="sampleSize" :min="1" :max="100000" :disabled="disabled || loading" />
      </label>
      <n-checkbox v-model:checked="hasHeader" :disabled="disabled || loading">首行是表头</n-checkbox>
    </div>

    <div v-else-if="resolvedFormat === 'dbf'" class="file-import__format-options file-import__format-options--checks">
      <n-checkbox v-model:checked="includeDeleted" :disabled="disabled || loading">包含已删除记录</n-checkbox>
      <n-checkbox v-model:checked="strict" :disabled="disabled || loading">严格读取（遇到编码或结构错误即停止）</n-checkbox>
    </div>

    <div v-else-if="resolvedFormat === 'xlsx'" class="file-import__format-options">
      <label class="field-label">
        <span>工作表名称（留空使用首个）</span>
        <n-input v-model:value="sheetName" placeholder="Sheet1" :disabled="disabled || loading" />
      </label>
      <label class="field-label field-label--short">
        <span>表头行号</span>
        <n-input-number v-model:value="headerRow" :min="1" :disabled="disabled || loading" />
      </label>
      <n-checkbox v-model:checked="inferDates" :disabled="disabled || loading">识别 Excel 日期</n-checkbox>
    </div>

    <n-alert v-else-if="resolvedFormat === 'sqlite'" type="info" :show-icon="false" class="file-import__notice">
      SQLite 文件将替换当前内存工作区；需要保留现有内容时请先导出。
    </n-alert>

    <footer class="file-import__footer">
      <span>确认编码与格式后再继续，列映射可在下一步调整。</span>
      <div>
        <n-button :disabled="disabled || loading" @click="emit('cancel')">取消</n-button>
        <n-button
          type="primary"
          :loading="loading"
          :disabled="disabled || !selectedFile || !resolvedFormat"
          @click="submit"
        >
          继续
        </n-button>
      </div>
    </footer>
  </section>
</template>

<style scoped>
.file-import__input {
  display: none;
}

.section-description {
  margin: 5px 0 0;
  color: var(--text-muted);
  font-size: 12px;
}

.file-import__dropzone {
  display: flex;
  align-items: center;
  gap: 14px;
  min-height: 112px;
  margin-top: 16px;
  padding: 20px;
  border: 1px dashed #b9c4d6;
  border-radius: 10px;
  background: #f8fafc;
  transition: border-color 0.2s, background 0.2s;
}

.file-import__dropzone--active {
  border-color: #4c78d6;
  background: #f0f5ff;
}

.file-import__dropzone--filled {
  min-height: 78px;
  border-style: solid;
  background: #fff;
}

.file-import__drop-copy {
  display: grid;
  flex: 1;
  gap: 6px;
}

.file-import__drop-copy span,
.file-import__file-info span,
.file-import__footer {
  color: var(--text-muted);
  font-size: 12px;
}

.file-import__file-mark {
  display: grid;
  flex: 0 0 44px;
  height: 50px;
  place-items: center;
  color: #4c78d6;
  border: 1px solid #ccd9f3;
  border-radius: 7px;
  background: #eff4ff;
  font-size: 10px;
  font-weight: 700;
}

.file-import__file-info {
  display: grid;
  flex: 1;
  min-width: 0;
  gap: 5px;
}

.file-import__file-info strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-import__alert,
.file-import__notice {
  margin-top: 14px;
}

.file-import__form,
.file-import__format-options {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
  margin-top: 16px;
}

.file-import__format-options {
  align-items: end;
  padding-top: 14px;
  border-top: 1px solid var(--border-color);
}

.file-import__format-options--checks {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
}

.field-label {
  display: grid;
  gap: 7px;
  color: #475569;
  font-size: 12px;
}

.field-label--short {
  max-width: 180px;
}

.file-import__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px solid var(--border-color);
}

.file-import__footer > div {
  display: flex;
  flex: 0 0 auto;
  gap: 8px;
}

@media (max-width: 640px) {
  .file-import__form,
  .file-import__format-options {
    grid-template-columns: 1fr;
  }

  .file-import__footer > span {
    display: none;
  }

  .file-import__footer {
    justify-content: flex-end;
  }
}
</style>
