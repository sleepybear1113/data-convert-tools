<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  NAlert,
  NButton,
  NCheckbox,
  NEmpty,
  NInput,
  NInputNumber,
  NSelect,
  NTag,
} from 'naive-ui'

import type { ColumnMapping, ImportMapping } from '../core/model/conversion'
import type { ColumnDataType, TableSchema } from '../core/model/table'

const props = withDefaults(
  defineProps<{
    sourceSchema: TableSchema
    modelValue?: readonly ColumnMapping[]
    targetTableName?: string
    loading?: boolean
    disabled?: boolean
    error?: string | null
  }>(),
  {
    modelValue: () => [],
    targetTableName: '',
    loading: false,
    disabled: false,
    error: null,
  },
)

const emit = defineEmits<{
  'update:modelValue': [columns: readonly ColumnMapping[]]
  'update:targetTableName': [name: string]
  submit: [mapping: ImportMapping]
  cancel: []
}>()

const typeOptions: Array<{ label: string; value: ColumnDataType }> = [
  { label: '文本', value: 'string' },
  { label: '整数', value: 'integer' },
  { label: '高精度小数', value: 'decimal' },
  { label: '浮点数', value: 'float' },
  { label: '布尔值', value: 'boolean' },
  { label: '日期', value: 'date' },
  { label: '日期时间', value: 'datetime' },
  { label: '二进制', value: 'binary' },
  { label: '空列', value: 'empty' },
  { label: '未知', value: 'unknown' },
]
const typeLabels = Object.fromEntries(
  typeOptions.map((option) => [option.value, option.label]),
) as Record<ColumnDataType, string>
const dbfTypeOptions = [
  { label: 'C · 字符', value: 'C' },
  { label: 'V · 可变字符', value: 'V' },
  { label: 'N · 数值', value: 'N' },
  { label: 'F · 浮点', value: 'F' },
  { label: 'Y · 货币', value: 'Y' },
  { label: 'I · 整数', value: 'I' },
  { label: 'L · 逻辑', value: 'L' },
  { label: 'D · 日期', value: 'D' },
  { label: 'T · 日期时间', value: 'T' },
  { label: 'B · 双精度', value: 'B' },
  { label: 'Q · 可变二进制', value: 'Q' },
]

const mappings = ref<ColumnMapping[]>([])
const tableName = ref(props.targetTableName || props.sourceSchema.name)

function defaultDbfMapping(
  type: ColumnDataType,
  sourceSize?: number,
  sourceDecimals?: number,
): Pick<ColumnMapping, 'dbfType' | 'dbfSize' | 'dbfDecimalPlaces'> {
  switch (type) {
    case 'integer':
      return { dbfType: 'I', dbfSize: 4, dbfDecimalPlaces: 0 }
    case 'decimal':
      return {
        dbfType: 'N',
        dbfSize: sourceSize ?? 20,
        dbfDecimalPlaces: sourceDecimals ?? 4,
      }
    case 'float':
      return {
        dbfType: 'F',
        dbfSize: sourceSize ?? 20,
        dbfDecimalPlaces: sourceDecimals ?? 4,
      }
    case 'boolean':
      return { dbfType: 'L', dbfSize: 1, dbfDecimalPlaces: 0 }
    case 'date':
      return { dbfType: 'D', dbfSize: 8, dbfDecimalPlaces: 0 }
    case 'datetime':
      return { dbfType: 'T', dbfSize: 8, dbfDecimalPlaces: 0 }
    case 'binary':
      return { dbfType: 'Q', dbfSize: sourceSize ?? 254, dbfDecimalPlaces: 0 }
    case 'empty':
      return { dbfType: 'C', dbfSize: 1, dbfDecimalPlaces: 0 }
    case 'string':
    case 'unknown':
      return {
        dbfType: 'C',
        dbfSize: sourceSize ?? 254,
        dbfDecimalPlaces: 0,
      }
  }
}

function createDefaults(): ColumnMapping[] {
  return props.sourceSchema.columns.map((column, sourceIndex) => ({
    sourceIndex,
    included: true,
    targetName: column.name || `column_${sourceIndex + 1}`,
    targetType: column.dataType,
    ...defaultDbfMapping(
      column.dataType,
      column.source?.size,
      column.source?.decimalPlaces,
    ),
  }))
}

function signature(columns: readonly ColumnMapping[]): string {
  return JSON.stringify(columns)
}

watch(
  () => props.modelValue,
  (columns) => {
    const next = columns.length ? columns : createDefaults()
    if (signature(next) !== signature(mappings.value)) {
      mappings.value = next.map((column) => ({ ...column }))
    }
    if (!columns.length) {
      emit('update:modelValue', mappings.value.map((column) => ({ ...column })))
    }
  },
  { immediate: true, deep: true },
)

watch(
  () => props.sourceSchema,
  () => {
    const next = props.modelValue.length ? props.modelValue : createDefaults()
    mappings.value = next.map((column) => ({ ...column }))
    tableName.value = props.targetTableName || props.sourceSchema.name
    emit('update:modelValue', mappings.value.map((column) => ({ ...column })))
  },
  { deep: true },
)

watch(
  () => props.targetTableName,
  (value) => {
    if (value && value !== tableName.value) tableName.value = value
  },
)

const includedCount = computed(
  () => mappings.value.filter((column) => column.included).length,
)
const allSelected = computed(
  () => mappings.value.length > 0 && includedCount.value === mappings.value.length,
)
const partiallySelected = computed(
  () => includedCount.value > 0 && !allSelected.value,
)
const validationErrors = computed<string[]>(() => {
  const errors: string[] = []
  if (!tableName.value.trim()) errors.push('目标表名不能为空。')
  if (!includedCount.value) errors.push('至少需要选择一列。')

  const usedNames = new Set<string>()
  for (const column of mappings.value) {
    if (!column.included) continue
    const name = column.targetName.trim()
    const normalized = name.toLocaleLowerCase()
    if (!name) errors.push(`源列 ${column.sourceIndex + 1} 的目标名不能为空。`)
    if (name && usedNames.has(normalized)) errors.push(`目标列名“${name}”重复。`)
    usedNames.add(normalized)

    const size = column.dbfSize
    const decimals = column.dbfDecimalPlaces ?? 0
    if (!Number.isInteger(size) || (size ?? 0) < 1 || (size ?? 0) > 254) {
      errors.push(`列“${name || column.sourceIndex + 1}”的 DBF 长度须为 1–254 的整数。`)
    }
    if (!Number.isInteger(decimals) || decimals < 0 || decimals >= (size ?? 1)) {
      errors.push(`列“${name || column.sourceIndex + 1}”的小数位无效。`)
    }
  }
  return [...new Set(errors)]
})

function publish(next: ColumnMapping[]): void {
  mappings.value = next
  emit('update:modelValue', next.map((column) => ({ ...column })))
}

function patchColumn(index: number, patch: Partial<ColumnMapping>): void {
  const next = mappings.value.map((column, columnIndex) =>
    columnIndex === index ? { ...column, ...patch } : { ...column },
  )
  publish(next)
}

function updateTargetType(index: number, type: ColumnDataType): void {
  const current = mappings.value[index]
  if (!current) return
  const source = props.sourceSchema.columns[current.sourceIndex]
  patchColumn(index, {
    targetType: type,
    ...defaultDbfMapping(
      type,
      source?.source?.size,
      source?.source?.decimalPlaces,
    ),
  })
}

function setAll(included: boolean): void {
  publish(mappings.value.map((column) => ({ ...column, included })))
}

function updateTableName(value: string): void {
  tableName.value = value
  emit('update:targetTableName', value)
}

function isFixedLength(dbfType: string | undefined): boolean {
  return ['Y', 'I', 'L', 'D', 'T', 'B'].includes(dbfType ?? '')
}

function reset(): void {
  const defaults = createDefaults()
  publish(defaults)
  updateTableName(props.sourceSchema.name)
}

function submit(): void {
  if (validationErrors.value.length || props.disabled || props.loading) return
  emit('submit', {
    sourceSchema: props.sourceSchema,
    targetTableName: tableName.value.trim(),
    columns: mappings.value.map((column) => ({
      ...column,
      targetName: column.targetName.trim(),
    })),
  })
}

defineExpose({ reset })
</script>

<template>
  <section class="mapping-editor" aria-labelledby="mapping-editor-title">
    <div class="section-heading">
      <div>
        <h2 id="mapping-editor-title">列与类型映射</h2>
        <p class="mapping-editor__description">
          选择需要导入的列，并确认 SQLite 目标类型及后续 DBF 导出参数。
        </p>
      </div>
      <n-tag size="small" :bordered="false" type="info">
        已选 {{ includedCount }} / {{ mappings.length }} 列
      </n-tag>
    </div>

    <label class="mapping-editor__table-name">
      <span>目标表名</span>
      <n-input
        :value="tableName"
        placeholder="imported_data"
        :disabled="disabled || loading"
        @update:value="updateTableName"
      />
    </label>

    <n-alert v-if="error" type="error" class="mapping-editor__alert">{{ error }}</n-alert>
    <n-alert v-if="validationErrors.length" type="warning" class="mapping-editor__alert" title="请先修正映射">
      <ul class="mapping-editor__errors">
        <li v-for="message in validationErrors.slice(0, 4)" :key="message">{{ message }}</li>
      </ul>
      <span v-if="validationErrors.length > 4">
        另有 {{ validationErrors.length - 4 }} 项问题。
      </span>
    </n-alert>

    <div v-if="mappings.length" class="mapping-editor__scroll">
      <table class="mapping-editor__table">
        <thead>
          <tr>
            <th class="mapping-editor__check-cell">
              <n-checkbox
                :checked="allSelected"
                :indeterminate="partiallySelected"
                :disabled="disabled || loading"
                aria-label="全选或取消全选列"
                @update:checked="setAll"
              />
            </th>
            <th>源列 / 推断类型</th>
            <th>目标列名</th>
            <th>目标类型</th>
            <th>DBF 类型</th>
            <th>长度（字节）</th>
            <th>小数位</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(column, index) in mappings"
            :key="`${column.sourceIndex}-${sourceSchema.columns[column.sourceIndex]?.id ?? index}`"
            :class="{ 'mapping-editor__row--excluded': !column.included }"
          >
            <td class="mapping-editor__check-cell">
              <n-checkbox
                :checked="column.included"
                :disabled="disabled || loading"
                :aria-label="`选择第 ${index + 1} 列`"
                @update:checked="patchColumn(index, { included: $event })"
              />
            </td>
            <td>
              <div class="mapping-editor__source">
                <strong :title="sourceSchema.columns[column.sourceIndex]?.name">
                  {{ sourceSchema.columns[column.sourceIndex]?.name || `列 ${index + 1}` }}
                </strong>
                <span>
                  {{ typeLabels[sourceSchema.columns[column.sourceIndex]?.dataType ?? 'unknown'] }}
                  <template v-if="sourceSchema.columns[column.sourceIndex]?.nullable"> · 可空</template>
                </span>
              </div>
            </td>
            <td>
              <n-input
                :value="column.targetName"
                size="small"
                :disabled="disabled || loading || !column.included"
                @update:value="patchColumn(index, { targetName: $event })"
              />
            </td>
            <td>
              <n-select
                :value="column.targetType ?? 'unknown'"
                size="small"
                :options="typeOptions"
                :disabled="disabled || loading || !column.included"
                @update:value="updateTargetType(index, $event)"
              />
            </td>
            <td>
              <n-select
                :value="column.dbfType ?? 'C'"
                size="small"
                :options="dbfTypeOptions"
                :disabled="disabled || loading || !column.included"
                @update:value="patchColumn(index, { dbfType: $event })"
              />
            </td>
            <td>
              <n-input-number
                :value="column.dbfSize ?? 1"
                size="small"
                :min="1"
                :max="254"
                :precision="0"
                :disabled="disabled || loading || !column.included || isFixedLength(column.dbfType)"
                @update:value="patchColumn(index, { dbfSize: $event ?? 1 })"
              />
            </td>
            <td>
              <n-input-number
                :value="column.dbfDecimalPlaces ?? 0"
                size="small"
                :min="0"
                :max="Math.max(0, (column.dbfSize ?? 1) - 1)"
                :precision="0"
                :disabled="disabled || loading || !column.included || !['N', 'F'].includes(column.dbfType ?? '')"
                @update:value="patchColumn(index, { dbfDecimalPlaces: $event ?? 0 })"
              />
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <n-empty v-else description="源文件没有可映射的列。" class="mapping-editor__empty" />

    <footer class="mapping-editor__footer">
      <span>固定宽度 DBF 类型的长度不可修改；小数位仅用于 N/F 字段。</span>
      <div>
        <n-button :disabled="loading" @click="emit('cancel')">取消</n-button>
        <n-button
          type="primary"
          :loading="loading"
          :disabled="disabled || validationErrors.length > 0"
          @click="submit"
        >
          确认导入
        </n-button>
      </div>
    </footer>
  </section>
</template>

<style scoped>
.mapping-editor__description {
  margin: 5px 0 0;
  color: var(--text-muted);
  font-size: 12px;
}

.mapping-editor__table-name {
  display: grid;
  grid-template-columns: 100px minmax(0, 320px);
  align-items: center;
  gap: 12px;
  margin-top: 16px;
  color: #475569;
  font-size: 13px;
}

.mapping-editor__alert {
  margin-top: 14px;
}

.mapping-editor__errors {
  margin: 0;
  padding-left: 18px;
}

.mapping-editor__scroll {
  overflow: auto;
  max-height: min(52vh, 520px);
  margin-top: 16px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
}

.mapping-editor__table {
  width: 100%;
  min-width: 1040px;
  border-collapse: separate;
  border-spacing: 0;
  font-size: 12px;
}

.mapping-editor__table th {
  position: sticky;
  z-index: 1;
  top: 0;
  padding: 10px 8px;
  color: #64748b;
  background: #f8fafc;
  border-bottom: 1px solid var(--border-color);
  text-align: left;
  white-space: nowrap;
}

.mapping-editor__table td {
  min-width: 112px;
  padding: 8px;
  border-bottom: 1px solid #edf0f5;
  vertical-align: middle;
}

.mapping-editor__table tr:last-child td {
  border-bottom: 0;
}

.mapping-editor__table tbody tr:hover {
  background: #fafbff;
}

.mapping-editor__check-cell {
  min-width: 42px !important;
  width: 42px;
  text-align: center !important;
}

.mapping-editor__row--excluded td {
  opacity: 0.55;
  background: #fafafa;
}

.mapping-editor__source {
  display: grid;
  min-width: 150px;
  max-width: 220px;
  gap: 4px;
}

.mapping-editor__source strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mapping-editor__source span,
.mapping-editor__footer {
  color: var(--text-muted);
  font-size: 11px;
}

.mapping-editor__empty {
  margin: 30px 0;
}

.mapping-editor__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-top: 18px;
}

.mapping-editor__footer > div {
  display: flex;
  flex: 0 0 auto;
  gap: 8px;
}
</style>
