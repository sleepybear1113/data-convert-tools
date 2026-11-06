<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  NAlert,
  NButton,
  NEmpty,
  NInput,
  NSkeleton,
  NTag,
} from 'naive-ui'

import type { DatabaseSchema } from '../core/database/schema'
import { quoteSqliteIdentifier } from '../core/utils/identifiers'

const props = withDefaults(
  defineProps<{
    schema?: DatabaseSchema
    activeTableName?: string | null
    loading?: boolean
    error?: string | null
  }>(),
  {
    schema: () => ({ tables: [] }),
    activeTableName: null,
    loading: false,
    error: null,
  },
)

const emit = defineEmits<{
  select: [tableName: string]
  preview: [tableName: string]
  insert: [text: string]
  refresh: []
}>()

const search = ref('')
const collapsed = ref<Set<string>>(new Set())
const normalizedSearch = computed(() => search.value.trim().toLocaleLowerCase())
const filteredTables = computed(() => {
  const query = normalizedSearch.value
  if (!query) return props.schema.tables
  return props.schema.tables.filter(
    (table) =>
      table.name.toLocaleLowerCase().includes(query) ||
      table.columns.some((column) => column.name.toLocaleLowerCase().includes(query)),
  )
})

watch(
  () => props.activeTableName,
  (tableName) => {
    if (!tableName) return
    const next = new Set(collapsed.value)
    next.delete(tableName)
    collapsed.value = next
  },
)

function isExpanded(tableName: string): boolean {
  return Boolean(normalizedSearch.value) || !collapsed.value.has(tableName)
}

function toggle(tableName: string): void {
  const next = new Set(collapsed.value)
  if (next.has(tableName)) next.delete(tableName)
  else next.add(tableName)
  collapsed.value = next
}

function select(tableName: string): void {
  emit('select', tableName)
  const next = new Set(collapsed.value)
  next.delete(tableName)
  collapsed.value = next
}
</script>

<template>
  <section class="schema-navigator panel" aria-labelledby="schema-navigator-title">
    <div class="section-heading schema-navigator__heading">
      <div class="schema-navigator__title">
        <h2 id="schema-navigator-title">数据表</h2>
        <n-tag size="small" :bordered="false">{{ schema.tables.length }}</n-tag>
      </div>
      <n-button
        size="tiny"
        quaternary
        :loading="loading"
        title="刷新表结构"
        @click="emit('refresh')"
      >
        刷新
      </n-button>
    </div>

    <n-input
      v-model:value="search"
      size="small"
      clearable
      placeholder="搜索表或字段"
      aria-label="搜索表或字段"
    />
    <n-alert v-if="error" type="error" size="small" class="schema-navigator__alert">
      {{ error }}
    </n-alert>

    <div v-if="loading && !schema.tables.length" class="schema-navigator__loading">
      <n-skeleton text :repeat="5" />
    </div>
    <n-empty
      v-else-if="!filteredTables.length"
      class="schema-navigator__empty"
      :description="schema.tables.length ? '没有匹配的表或字段。' : '导入文件后，这里会显示数据表和字段。'"
    />

    <ul v-else class="schema-navigator__tables">
      <li v-for="table in filteredTables" :key="table.name">
        <div
          class="schema-navigator__table-row"
          :class="{ 'schema-navigator__table-row--active': table.name === activeTableName }"
        >
          <button
            type="button"
            class="schema-navigator__expand"
            :aria-label="`${isExpanded(table.name) ? '折叠' : '展开'} ${table.name}`"
            :aria-expanded="isExpanded(table.name)"
            @click="toggle(table.name)"
          >
            {{ isExpanded(table.name) ? '▾' : '▸' }}
          </button>
          <button
            type="button"
            class="schema-navigator__table-select"
            :title="table.name"
            @click="select(table.name)"
          >
            <span>{{ table.name }}</span>
            <small>{{ table.columns.length }} 列</small>
          </button>
          <button
            type="button"
            class="schema-navigator__preview"
            title="生成并执行 SELECT 查询"
            @click="emit('preview', table.name)"
          >
            查询
          </button>
        </div>

        <ul v-if="isExpanded(table.name)" class="schema-navigator__columns">
          <li v-for="column in table.columns" :key="column.name">
            <button
              type="button"
              :title="`插入字段 ${column.name}`"
              @click="emit('insert', quoteSqliteIdentifier(column.name))"
            >
              <span class="schema-navigator__column-name">{{ column.name }}</span>
              <span class="schema-navigator__column-type">{{ column.declaredType || 'ANY' }}</span>
              <span v-if="column.primaryKey" class="schema-navigator__key">PK</span>
              <span v-else-if="column.nullable" class="schema-navigator__nullable">NULL</span>
            </button>
          </li>
        </ul>
      </li>
    </ul>
    <p v-if="schema.tables.length" class="schema-navigator__hint">点击字段插入 SQL；点击“查询”预览数据表。</p>
  </section>
</template>

<style scoped>
.schema-navigator {
  min-width: 0;
}

.schema-navigator__heading {
  margin-bottom: 12px;
}

.schema-navigator__title {
  display: flex;
  align-items: center;
  gap: 8px;
}

.schema-navigator__alert {
  margin-top: 10px;
}

.schema-navigator__loading,
.schema-navigator__empty {
  padding: 24px 0;
}

.schema-navigator__tables,
.schema-navigator__columns {
  margin: 12px 0 0;
  padding: 0;
  list-style: none;
}

.schema-navigator__tables {
  display: grid;
  gap: 4px;
}

.schema-navigator__table-row {
  display: flex;
  align-items: center;
  min-width: 0;
  border: 1px solid transparent;
  border-radius: 6px;
}

.schema-navigator__table-row:hover {
  background: #f6f8fc;
}

.schema-navigator__table-row--active {
  border-color: #d5e0f7;
  background: #f0f5ff;
}

.schema-navigator__expand,
.schema-navigator__preview,
.schema-navigator__table-select,
.schema-navigator__columns button {
  border: 0;
  background: transparent;
  cursor: pointer;
}

.schema-navigator__expand {
  flex: 0 0 26px;
  color: #7b8798;
}

.schema-navigator__table-select {
  display: flex;
  align-items: center;
  flex: 1;
  min-width: 0;
  gap: 7px;
  padding: 7px 0;
  color: #334155;
  text-align: left;
}

.schema-navigator__table-select > span {
  overflow: hidden;
  font-size: 13px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.schema-navigator__table-select small {
  flex: 0 0 auto;
  color: #94a3b8;
  font-size: 10px;
}

.schema-navigator__preview {
  flex: 0 0 auto;
  padding: 5px 7px;
  color: #4c78d6;
  font-size: 11px;
}

.schema-navigator__columns {
  margin: 0 0 5px 23px;
  padding-left: 9px;
  border-left: 1px solid #e2e8f0;
}

.schema-navigator__columns button {
  display: flex;
  align-items: center;
  width: 100%;
  min-width: 0;
  gap: 6px;
  padding: 5px 6px;
  border-radius: 4px;
  text-align: left;
}

.schema-navigator__columns button:hover {
  background: #f1f5f9;
}

.schema-navigator__column-name {
  overflow: hidden;
  flex: 1;
  color: #475569;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.schema-navigator__column-type,
.schema-navigator__nullable,
.schema-navigator__key {
  color: #94a3b8;
  font: 9px "Cascadia Code", Consolas, monospace;
}

.schema-navigator__key {
  color: #a56b11;
  font-weight: 700;
}

.schema-navigator__hint {
  margin: 12px 0 0;
  color: var(--text-muted);
  font-size: 11px;
}
</style>
