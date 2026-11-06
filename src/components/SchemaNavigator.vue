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
import { usePointerDrag } from '../composables/usePointerDrag'

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

/**
 * 字段名列宽占整行宽度的百分比（24–84，默认 60）。
 * 存为百分比而不是像素：侧边栏拖宽/拖窄时字段名区域按比例跟随。
 */
const FIELD_NAME_DEFAULT_SHARE = 60
const FIELD_NAME_MIN_SHARE = 24
const FIELD_NAME_MAX_SHARE = 84
const fieldNameShare = ref(FIELD_NAME_DEFAULT_SHARE)

const navigatorStyle = computed(() => ({
  '--field-name-share': fieldNameShare.value,
}))

function clampFieldNameShare(share: number): number {
  return Math.round(
    Math.min(Math.max(share, FIELD_NAME_MIN_SHARE), FIELD_NAME_MAX_SHARE) * 10,
  ) / 10
}

const dragFieldGrip = usePointerDrag<HTMLElement | null>({
  // 以表头为参照物换算百分比，表头与字段行共用同一套列宽定义。
  onStart: (event) =>
    (event.currentTarget as HTMLElement).closest(
      '.schema-navigator__columns-header',
    ) as HTMLElement | null,
  onMove: (event, state) => {
    const header = state.context
    if (!header) return
    const rect = header.getBoundingClientRect()
    // 表头与字段行都有 6px 左右内边距，可分配宽度 = 宽度 - 12px。
    const inner = Math.max(rect.width - 12, 1)
    const offset = event.clientX - rect.left - 6
    fieldNameShare.value = clampFieldNameShare((offset / inner) * 100)
  },
})

function resetFieldNameShare(): void {
  fieldNameShare.value = FIELD_NAME_DEFAULT_SHARE
}

function onFieldGripKeydown(event: KeyboardEvent): void {
  const step = event.shiftKey ? 6 : 2
  if (event.key === 'ArrowLeft') {
    fieldNameShare.value = clampFieldNameShare(fieldNameShare.value - step)
    event.preventDefault()
  } else if (event.key === 'ArrowRight') {
    fieldNameShare.value = clampFieldNameShare(fieldNameShare.value + step)
    event.preventDefault()
  }
}
</script>

<template>
  <section
    class="schema-navigator panel"
    aria-labelledby="schema-navigator-title"
    :style="navigatorStyle"
  >
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

        <div v-if="isExpanded(table.name)" class="schema-navigator__columns">
          <div class="schema-navigator__columns-header">
            <span class="schema-navigator__columns-header-label">字段名</span>
            <span class="schema-navigator__columns-header-label">类型</span>
            <span
              class="schema-navigator__field-grip"
              role="separator"
              aria-orientation="vertical"
              aria-label="调整字段名宽度"
              :aria-valuemin="FIELD_NAME_MIN_SHARE"
              :aria-valuemax="FIELD_NAME_MAX_SHARE"
              :aria-valuenow="fieldNameShare"
              tabindex="0"
              title="拖动或用 ←/→ 调整字段名宽度（Shift 加速），双击恢复默认"
              @pointerdown="dragFieldGrip"
              @dblclick="resetFieldNameShare"
              @keydown="onFieldGripKeydown"
            />
          </div>
          <ul class="schema-navigator__column-list">
            <li v-for="column in table.columns" :key="column.name">
              <button
                type="button"
                :title="`插入字段 ${column.name}`"
                @click="emit('insert', quoteSqliteIdentifier(column.name))"
              >
                <span class="schema-navigator__column-name">{{ column.name }}</span>
                <span class="schema-navigator__column-meta">
                  <span class="schema-navigator__column-type">{{ column.declaredType || 'ANY' }}</span>
                  <span v-if="column.primaryKey" class="schema-navigator__key">PK</span>
                  <span v-else-if="column.nullable" class="schema-navigator__nullable">NULL</span>
                </span>
              </button>
            </li>
          </ul>
        </div>
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

.schema-navigator__tables {
  display: grid;
  gap: 4px;
  margin: 12px 0 0;
  padding: 0;
  list-style: none;
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
.schema-navigator__column-list button {
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
  flex: 1;
  min-width: 0;
  /* 表名换行成多行时，列数徽标与首行文字对齐。 */
  align-items: baseline;
  gap: 7px;
  padding: 7px 0;
  color: #334155;
  text-align: left;
}

/* 表名过长时换行，而不是截断或撑破侧边栏。 */
.schema-navigator__table-select > span {
  min-width: 0;
  overflow-wrap: anywhere;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.45;
  white-space: normal;
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

.schema-navigator__column-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

/* 表头与字段行共用同一套列模板：字段名列宽 = 行内容宽度的 --field-name-share%。 */
.schema-navigator__columns-header,
.schema-navigator__column-list button {
  display: grid;
  grid-template-columns:
    minmax(0, calc(var(--field-name-share, 60) * 1%))
    minmax(0, 1fr);
  align-items: center;
  column-gap: 6px;
}

.schema-navigator__columns-header {
  position: relative;
  padding: 0 6px 5px;
}

.schema-navigator__columns-header-label {
  overflow: hidden;
  color: #94a3b8;
  font-size: 10px;
  letter-spacing: 0.4px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.schema-navigator__column-list button {
  width: 100%;
  padding: 5px 6px;
  border-radius: 4px;
  text-align: left;
}

.schema-navigator__column-list button:hover {
  background: #f1f5f9;
}

.schema-navigator__column-name {
  overflow: hidden;
  min-width: 0;
  color: #475569;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.schema-navigator__column-meta {
  display: flex;
  align-items: center;
  min-width: 0;
  gap: 4px;
}

.schema-navigator__column-type {
  overflow: hidden;
  min-width: 0;
  color: #94a3b8;
  font: 9px "Cascadia Code", Consolas, monospace;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.schema-navigator__nullable,
.schema-navigator__key {
  flex: 0 0 auto;
  color: #94a3b8;
  font: 9px "Cascadia Code", Consolas, monospace;
}

/* 字段名宽度拖动把手：定位在字段名/类型分界线上（表头内绝对定位）。 */
.schema-navigator__field-grip {
  position: absolute;
  top: -8px;
  bottom: -8px;
  left: calc((100% - 12px) * var(--field-name-share, 60) / 100);
  width: 12px;
  cursor: col-resize;
  touch-action: none;
}

.schema-navigator__field-grip::before {
  content: "";
  position: absolute;
  top: 8px;
  bottom: 8px;
  left: 50%;
  width: 2px;
  border-radius: 2px;
  background: transparent;
  transform: translateX(-50%);
  transition: background-color 0.15s ease;
}

.schema-navigator__field-grip:hover::before,
.schema-navigator__field-grip:focus-visible::before {
  background: #4c70c9;
}

.schema-navigator__field-grip:focus-visible {
  outline: 2px solid #4c70c9;
  outline-offset: -3px;
  border-radius: 4px;
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
