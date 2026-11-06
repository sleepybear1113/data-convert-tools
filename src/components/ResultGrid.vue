<script setup lang="ts">
import { computed, h } from 'vue'
import {
  NAlert,
  NButton,
  NDataTable,
  NEmpty,
  NPagination,
  NTag,
} from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'

import type { CellValue } from '../core/model/value'
import type { TableRow } from '../core/model/table'
import type { ResultPageChange } from './contracts'

interface GridRow {
  id: number
  values: readonly CellValue[]
}

interface CellDisplay {
  text: string
  title: string
  kind: 'normal' | 'null' | 'empty' | 'binary' | 'bigint'
}

const props = withDefaults(
  defineProps<{
    columns?: readonly string[]
    rows?: readonly TableRow[]
    offset?: number
    totalRows?: number
    pageSize?: number
    pageSizeOptions?: readonly number[]
    loading?: boolean
    executed?: boolean
    error?: string | null
    emptyText?: string
    durationMs?: number | null
    rowsAffected?: number | null
  }>(),
  {
    columns: () => [],
    rows: () => [],
    offset: 0,
    totalRows: undefined,
    pageSize: 200,
    pageSizeOptions: () => [50, 100, 200, 500],
    loading: false,
    executed: false,
    error: null,
    emptyText: '',
    durationMs: null,
    rowsAffected: null,
  },
)

const emit = defineEmits<{
  'page-change': [change: ResultPageChange]
  refresh: []
}>()

const currentPage = computed(() => Math.floor(props.offset / props.pageSize) + 1)
const effectiveTotal = computed(() => {
  if (props.totalRows !== undefined) return props.totalRows
  const loadedThrough = props.offset + props.rows.length
  return props.rows.length === props.pageSize ? loadedThrough + 1 : loadedThrough
})
const pageCount = computed(() =>
  Math.max(currentPage.value, 1, Math.ceil(effectiveTotal.value / props.pageSize)),
)
const rangeText = computed(() => {
  if (!props.rows.length) return '0 行'
  const first = props.offset + 1
  const last = props.offset + props.rows.length
  return props.totalRows === undefined
    ? `${first}–${last} 行`
    : `${first}–${last} / ${props.totalRows} 行`
})
const emptyDescription = computed(() => {
  if (props.emptyText) return props.emptyText
  if (!props.executed) return '执行 SQL 后，在这里只读查看当前页数据。'
  if (!props.columns.length) return '语句执行完成，没有返回表格数据。'
  return '当前页没有数据。'
})

const gridRows = computed<GridRow[]>(() =>
  props.rows.map((values, index) => ({ id: props.offset + index, values })),
)

function displayCell(value: CellValue | undefined): CellDisplay {
  if (value === null || value === undefined) {
    return { text: 'NULL', title: '数据库 NULL', kind: 'null' }
  }
  if (value instanceof Uint8Array) {
    const hex = Array.from(value.subarray(0, 12), (byte) =>
      byte.toString(16).padStart(2, '0').toUpperCase(),
    ).join(' ')
    const suffix = value.byteLength > 12 ? ' …' : ''
    return {
      text: `BINARY · ${value.byteLength} B${hex ? ` · ${hex}${suffix}` : ''}`,
      title: `只读二进制数据，共 ${value.byteLength} 字节`,
      kind: 'binary',
    }
  }
  if (typeof value === 'string') {
    return value.length === 0
      ? { text: '"" · 空字符串', title: '空字符串（不是 NULL）', kind: 'empty' }
      : { text: value, title: value, kind: 'normal' }
  }
  if (typeof value === 'bigint') {
    const text = value.toString()
    return { text: `${text}n`, title: `BigInt：${text}`, kind: 'bigint' }
  }
  if (typeof value === 'boolean') {
    const text = value ? 'TRUE' : 'FALSE'
    return { text, title: text, kind: 'normal' }
  }
  const text = String(value)
  return { text, title: text, kind: 'normal' }
}

function renderCell(value: CellValue | undefined) {
  const display = displayCell(value)
  return h(
    'span',
    {
      class: ['result-cell', `result-cell--${display.kind}`],
      title: display.title,
    },
    display.text,
  )
}

const tableColumns = computed<DataTableColumns<GridRow>>(() => [
  {
    title: '#',
    key: '__row_number',
    width: 64,
    fixed: 'left',
    align: 'right',
    render: (row) => h('span', { class: 'row-number' }, row.id + 1),
  },
  ...props.columns.map((name, index) => ({
    title: name || `列 ${index + 1}`,
    key: `column_${index}`,
    minWidth: 140,
    ellipsis: { tooltip: true },
    render: (row: GridRow) => renderCell(row.values[index]),
  })),
])

function rowKey(row: GridRow): number {
  return row.id
}

function changePage(page: number): void {
  emit('page-change', {
    offset: Math.max(0, page - 1) * props.pageSize,
    limit: props.pageSize,
  })
}

function changePageSize(pageSize: number): void {
  emit('page-change', { offset: 0, limit: pageSize })
}
</script>

<template>
  <section class="result-grid panel" aria-labelledby="result-grid-title">
    <div class="section-heading result-grid__heading">
      <div class="result-grid__title-group">
        <h2 id="result-grid-title">查询结果</h2>
        <n-tag size="small" :bordered="false">只读 · 当前页</n-tag>
        <span v-if="durationMs !== null" class="result-grid__metric">
          {{ durationMs.toFixed(1) }} ms
        </span>
        <span v-if="rowsAffected !== null && rowsAffected !== undefined" class="result-grid__metric">
          影响 {{ rowsAffected }} 行
        </span>
      </div>
      <span class="result-grid__range">{{ rangeText }}</span>
    </div>

    <div v-if="error" class="result-grid__error">
      <n-alert type="error" title="查询或分页失败">
        <div class="result-grid__error-content">
          <span>{{ error }}</span>
          <n-button size="tiny" secondary :loading="loading" @click="emit('refresh')">
            重试
          </n-button>
        </div>
      </n-alert>
    </div>

    <n-data-table
      v-if="columns.length"
      class="result-grid__table"
      size="small"
      :columns="tableColumns"
      :data="gridRows"
      :row-key="rowKey"
      :loading="loading"
      :bordered="false"
      :single-line="false"
      :max-height="420"
      :scroll-x="Math.max(720, (columns.length + 1) * 150)"
      virtual-scroll
    >
      <template #empty>
        <n-empty :description="emptyDescription" />
      </template>
    </n-data-table>
    <div v-else class="result-grid__empty">
      <n-empty :description="emptyDescription" />
    </div>

    <footer v-if="executed && columns.length" class="result-grid__footer">
      <span>每页仅保留当前页数据，NULL、空串与二进制值分别标识。</span>
      <n-pagination
        :page="currentPage"
        :page-count="pageCount"
        :page-size="pageSize"
        :page-sizes="[...pageSizeOptions]"
        :disabled="loading"
        :show-size-picker="true"
        :show-quick-jumper="pageCount > 5"
        @update:page="changePage"
        @update:page-size="changePageSize"
      />
    </footer>
  </section>
</template>

<style scoped>
.result-grid {
  min-width: 0;
}

.result-grid__heading {
  margin-bottom: 12px;
}

.result-grid__title-group,
.result-grid__error-content,
.result-grid__footer {
  display: flex;
  align-items: center;
  gap: 10px;
}

.result-grid__metric,
.result-grid__range,
.result-grid__footer {
  color: var(--text-muted);
  font-size: 12px;
}

.result-grid__error {
  margin-bottom: 12px;
}

.result-grid__error-content {
  justify-content: space-between;
}

.result-grid__table {
  min-height: 160px;
}

.result-grid__empty {
  display: grid;
  min-height: 190px;
  place-items: center;
  border: 1px dashed var(--border-color);
  border-radius: 8px;
  background: var(--surface-muted);
}

.result-grid__footer {
  justify-content: space-between;
  margin-top: 12px;
}

:deep(.result-cell) {
  font-family: "Cascadia Code", "SFMono-Regular", Consolas, monospace;
  font-size: 12px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

:deep(.result-cell--null),
:deep(.result-cell--empty) {
  display: inline-block;
  padding: 1px 5px;
  border-radius: 4px;
  font-family: inherit;
  font-size: 11px;
}

:deep(.result-cell--null) {
  color: #7c5b18;
  background: #fff6dc;
  font-style: italic;
}

:deep(.result-cell--empty) {
  color: #64748b;
  background: #f1f5f9;
}

:deep(.result-cell--binary) {
  color: #6750a4;
}

:deep(.result-cell--bigint) {
  color: #0f766e;
}

:deep(.row-number) {
  color: #94a3b8;
  font-variant-numeric: tabular-nums;
}

@media (max-width: 900px) {
  .result-grid__footer {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
