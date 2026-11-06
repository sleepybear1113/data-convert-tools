<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  NButton,
  NEmpty,
  NSelect,
  NSkeleton,
  NTag,
} from 'naive-ui'

import type {
  Diagnostic,
  DiagnosticSeverity,
} from '../core/model/diagnostic'

const props = withDefaults(
  defineProps<{
    diagnostics?: readonly Diagnostic[]
    loading?: boolean
    emptyText?: string
  }>(),
  {
    diagnostics: () => [],
    loading: false,
    emptyText: '暂无诊断。导入、查询或导出产生的编码、类型与精度信息会显示在这里。',
  },
)

const emit = defineEmits<{
  clear: []
  locate: [diagnostic: Diagnostic]
}>()

type SeverityFilter = 'all' | DiagnosticSeverity
const severity = ref<SeverityFilter>('all')
const severityOptions = [
  { label: '全部级别', value: 'all' },
  { label: '错误', value: 'error' },
  { label: '警告', value: 'warning' },
  { label: '信息', value: 'info' },
]
const severityLabels: Record<DiagnosticSeverity, string> = {
  error: '错误',
  warning: '警告',
  info: '信息',
}

const counts = computed<Record<DiagnosticSeverity, number>>(() => ({
  error: props.diagnostics.filter((item) => item.severity === 'error').length,
  warning: props.diagnostics.filter((item) => item.severity === 'warning').length,
  info: props.diagnostics.filter((item) => item.severity === 'info').length,
}))
const filtered = computed(() =>
  severity.value === 'all'
    ? props.diagnostics
    : props.diagnostics.filter((item) => item.severity === severity.value),
)

function locationText(diagnostic: Diagnostic): string {
  const location = diagnostic.location
  if (!location) return ''
  const parts: string[] = []
  if (location.tableName) parts.push(`表 ${location.tableName}`)
  if (location.columnName) parts.push(`列 ${location.columnName}`)
  else if (location.columnIndex !== undefined) parts.push(`第 ${location.columnIndex + 1} 列`)
  if (location.rowIndex !== undefined) parts.push(`第 ${location.rowIndex + 1} 行`)
  if (location.byteOffset !== undefined) parts.push(`字节偏移 ${location.byteOffset}`)
  return parts.join(' · ')
}

function detailsText(diagnostic: Diagnostic): string {
  if (!diagnostic.details) return ''
  return JSON.stringify(diagnostic.details, (_key, value: unknown) => {
    if (typeof value === 'bigint') return `${value.toString()}n`
    if (value instanceof Uint8Array) return `[二进制 ${value.byteLength} 字节]`
    return value
  }, 2)
}
</script>

<template>
  <section class="diagnostic-list panel" aria-labelledby="diagnostic-list-title">
    <div class="section-heading diagnostic-list__heading">
      <div class="diagnostic-list__title">
        <h2 id="diagnostic-list-title">诊断信息</h2>
        <n-tag v-if="counts.error" size="small" type="error" :bordered="false">
          {{ counts.error }} 错误
        </n-tag>
        <n-tag v-if="counts.warning" size="small" type="warning" :bordered="false">
          {{ counts.warning }} 警告
        </n-tag>
        <n-tag v-if="!diagnostics.length && !loading" size="small" :bordered="false">
          无问题
        </n-tag>
      </div>
      <div class="diagnostic-list__tools">
        <n-select
          v-model:value="severity"
          class="diagnostic-list__filter"
          size="small"
          :options="severityOptions"
          :disabled="!diagnostics.length"
          aria-label="筛选诊断级别"
        />
        <n-button
          size="small"
          quaternary
          :disabled="!diagnostics.length || loading"
          @click="emit('clear')"
        >
          清空
        </n-button>
      </div>
    </div>

    <div v-if="loading" class="diagnostic-list__loading" aria-label="正在加载诊断">
      <n-skeleton text :repeat="3" />
    </div>
    <n-empty
      v-else-if="!filtered.length"
      class="diagnostic-list__empty"
      :description="diagnostics.length ? '当前级别没有诊断。' : emptyText"
    />

    <ol v-else class="diagnostic-list__items">
      <li
        v-for="(diagnostic, index) in filtered"
        :key="`${diagnostic.code}-${index}`"
        class="diagnostic-list__item"
        :class="`diagnostic-list__item--${diagnostic.severity}`"
      >
        <span class="diagnostic-list__severity">{{ severityLabels[diagnostic.severity] }}</span>
        <div class="diagnostic-list__content">
          <div class="diagnostic-list__message">
            <strong>{{ diagnostic.message }}</strong>
            <code>{{ diagnostic.code }}</code>
          </div>
          <span v-if="locationText(diagnostic)" class="diagnostic-list__location">
            {{ locationText(diagnostic) }}
          </span>
          <details v-if="diagnostic.details" class="diagnostic-list__details">
            <summary>详细上下文</summary>
            <pre>{{ detailsText(diagnostic) }}</pre>
          </details>
        </div>
        <n-button
          v-if="diagnostic.location"
          size="tiny"
          quaternary
          @click="emit('locate', diagnostic)"
        >
          定位
        </n-button>
      </li>
    </ol>
  </section>
</template>

<style scoped>
.diagnostic-list__heading {
  margin-bottom: 10px;
}

.diagnostic-list__title,
.diagnostic-list__tools,
.diagnostic-list__message {
  display: flex;
  align-items: center;
  gap: 8px;
}

.diagnostic-list__filter {
  width: 112px;
}

.diagnostic-list__loading,
.diagnostic-list__empty {
  padding: 20px 0;
}

.diagnostic-list__items {
  display: grid;
  max-height: 250px;
  margin: 0;
  padding: 0;
  overflow: auto;
  list-style: none;
  border: 1px solid var(--border-color);
  border-radius: 8px;
}

.diagnostic-list__item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  border-bottom: 1px solid #edf0f5;
}

.diagnostic-list__item:last-child {
  border-bottom: 0;
}

.diagnostic-list__severity {
  flex: 0 0 auto;
  min-width: 32px;
  padding-top: 2px;
  font-size: 11px;
  font-weight: 600;
}

.diagnostic-list__item--error .diagnostic-list__severity {
  color: #c43d4b;
}

.diagnostic-list__item--warning .diagnostic-list__severity {
  color: #a66908;
}

.diagnostic-list__item--info .diagnostic-list__severity {
  color: #3974c6;
}

.diagnostic-list__content {
  display: grid;
  flex: 1;
  min-width: 0;
  gap: 5px;
}

.diagnostic-list__message {
  align-items: flex-start;
  justify-content: space-between;
}

.diagnostic-list__message strong {
  color: #334155;
  font-size: 12px;
  font-weight: 500;
}

.diagnostic-list__message code,
.diagnostic-list__location {
  color: var(--text-muted);
  font-size: 11px;
}

.diagnostic-list__details summary {
  color: #64748b;
  cursor: pointer;
  font-size: 11px;
}

.diagnostic-list__details pre {
  overflow: auto;
  margin: 7px 0 0;
  padding: 8px;
  border-radius: 5px;
  background: #f8fafc;
  font-size: 11px;
  white-space: pre-wrap;
}
</style>
