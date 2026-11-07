<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  startCompletion,
} from '@codemirror/autocomplete'
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from '@codemirror/commands'
import {
  bracketMatching,
  defaultHighlightStyle,
  syntaxHighlighting,
} from '@codemirror/language'
import { sql, SQLite } from '@codemirror/lang-sql'
import type { SQLNamespace } from '@codemirror/lang-sql'
import { Compartment, EditorState } from '@codemirror/state'
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder as editorPlaceholder,
} from '@codemirror/view'
import { NAlert, NButton, NEmpty, NInput, NInputNumber, NModal, NSelect, NTag } from 'naive-ui'

import type {
  DatabaseSchema,
  SqlCompletionSchema,
} from '../core/database/schema'
import { useQueryHistory } from '../composables/useQueryHistory'
import type { QueryHistoryConfig, QueryHistoryEntry, QueryHistoryMode } from '../composables/useQueryHistory'
import { useSqlSnippets } from '../composables/useSqlSnippets'
import type { SqlSnippet } from '../composables/useSqlSnippets'

const props = withDefaults(
  defineProps<{
    modelValue?: string
    schema?: DatabaseSchema | SqlCompletionSchema
    disabled?: boolean
    loading?: boolean
    error?: string | null
    placeholder?: string
    height?: string
  }>(),
  {
    modelValue: '',
    schema: () => ({ tables: [] }),
    disabled: false,
    loading: false,
    error: null,
    placeholder: '输入 SQLite SQL；Ctrl+Space 补全，Ctrl+Enter 执行',
    height: '240px',
  },
)

const emit = defineEmits<{
  'update:modelValue': [value: string]
  execute: [sql: string]
}>()

const host = ref<HTMLDivElement | null>(null)
let view: EditorView | null = null
const language = new Compartment()
const editable = new Compartment()
const placeholderText = new Compartment()

function isDatabaseSchema(
  schema: DatabaseSchema | SqlCompletionSchema,
): schema is DatabaseSchema {
  if (!('tables' in schema) || !Array.isArray(schema.tables)) return false
  if (Object.keys(schema).some((key) => key !== 'tables')) return false
  return schema.tables.every(
    (table) =>
      typeof table === 'object' &&
      table !== null &&
      'name' in table &&
      'columns' in table,
  )
}

const schemaForCompletion = computed<SQLNamespace>(() => {
  const namespace: { [name: string]: SQLNamespace } = {}
  const schema = props.schema

  if (isDatabaseSchema(schema)) {
    for (const table of schema.tables) {
      namespace[table.name] = table.columns.map((column) => column.name)
    }
  } else {
    for (const [tableName, columns] of Object.entries(schema)) {
      namespace[tableName] = columns
    }
  }

  return namespace
})

function sqlExtension() {
  return sql({
    dialect: SQLite,
    schema: schemaForCompletion.value,
    upperCaseKeywords: true,
  })
}

function editableExtension(enabled: boolean) {
  return [
    EditorState.readOnly.of(!enabled),
    EditorView.editable.of(enabled),
  ]
}

function executionText(): string {
  if (!view) return props.modelValue
  const selection = view.state.selection.main
  return selection.empty
    ? view.state.doc.toString()
    : view.state.sliceDoc(selection.from, selection.to)
}

function execute(): void {
  const value = executionText()
  if (!props.disabled && !props.loading && value.trim()) {
    emit('execute', value)
  }
}

function focus(): void {
  view?.focus()
}

function insertText(text: string): void {
  if (!view || props.disabled) return
  const selection = view.state.selection.main
  view.dispatch({
    changes: { from: selection.from, to: selection.to, insert: text },
    selection: { anchor: selection.from + text.length },
    scrollIntoView: true,
  })
  view.focus()
}

/** 常用片段：插入文本并按 cursorOffset 定位光标（成对符号停在中间）。 */
function insertSnippet(snippet: SqlSnippet): void {
  if (!view || props.disabled) return
  const selection = view.state.selection.main
  view.dispatch({
    changes: { from: selection.from, to: selection.to, insert: snippet.insert },
    selection: {
      anchor: selection.from + snippet.insert.length + (snippet.cursorOffset ?? 0),
    },
    scrollIntoView: true,
  })
  view.focus()
}

const { snippets, save: saveSnippets, resetToDefaults: resetSnippetDefaults } = useSqlSnippets()
const snippetEditorVisible = ref(false)
const draftSnippets = ref<SqlSnippet[]>([])

function openSnippetEditor(): void {
  draftSnippets.value = snippets.value.map((snippet) => ({ ...snippet }))
  snippetEditorVisible.value = true
}

function addDraftSnippet(): void {
  draftSnippets.value = [...draftSnippets.value, { label: '', insert: '' }]
}

function removeDraftSnippet(index: number): void {
  draftSnippets.value = draftSnippets.value.filter((_, itemIndex) => itemIndex !== index)
}

function moveDraftSnippet(index: number, offset: number): void {
  const target = index + offset
  if (target < 0 || target >= draftSnippets.value.length) return
  const next = [...draftSnippets.value]
  const [moved] = next.splice(index, 1)
  next.splice(target, 0, moved!)
  draftSnippets.value = next
}

function finishSnippetEditing(): void {
  const cleaned = draftSnippets.value
    .map((snippet) => ({ ...snippet, label: snippet.label.trim(), insert: snippet.insert }))
    .filter((snippet) => snippet.label.length > 0 && snippet.insert.length > 0)
  saveSnippets(cleaned)
  snippetEditorVisible.value = false
}

const queryHistory = useQueryHistory()
const historyConfig = queryHistory.config
const historyEntries = queryHistory.entries
const historyVisible = ref(false)

function updateHistoryConfig(patch: Partial<QueryHistoryConfig>): void {
  queryHistory.setConfig(patch)
}

function useHistoryEntry(entry: QueryHistoryEntry): void {
  if (!view) return
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: entry.sql },
    selection: { anchor: entry.sql.length },
    scrollIntoView: true,
  })
  view.focus()
  historyVisible.value = false
}

function formatHistoryTime(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString('zh-CN', { hour12: false })
}

function resetSnippetsAndRefreshEditor(): void {
  resetSnippetDefaults()
  openSnippetEditor()
}

const historyModeOptions: Array<{ label: string; value: QueryHistoryMode }> = [
  { label: '持久保存', value: 'persistent' },
  { label: '仅当前窗口', value: 'session' },
  { label: '不保存', value: 'off' },
]

/** 供父层在查询成功后记录历史。 */
function recordHistory(sql: string): void {
  queryHistory.record(sql)
}

onMounted(() => {
  if (!host.value) return

  view = new EditorView({
    parent: host.value,
    state: EditorState.create({
      doc: props.modelValue,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        drawSelection(),
        history(),
        bracketMatching(),
        closeBrackets(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        language.of(sqlExtension()),
        editable.of(editableExtension(!props.disabled)),
        placeholderText.of(editorPlaceholder(props.placeholder)),
        autocompletion({ activateOnTyping: true }),
        keymap.of([
          {
            key: 'Ctrl-Enter',
            mac: 'Cmd-Enter',
            preventDefault: true,
            run: () => {
              execute()
              return true
            },
          },
          {
            key: 'Ctrl-Space',
            mac: 'Cmd-Space',
            preventDefault: true,
            run: (currentView) => startCompletion(currentView),
          },
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          ...completionKeymap,
          indentWithTab,
        ]),
        EditorView.contentAttributes.of({
          'aria-label': 'SQLite SQL 编辑器',
          'aria-multiline': 'true',
          spellcheck: 'false',
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            const value = update.state.doc.toString()
            if (value !== props.modelValue) emit('update:modelValue', value)
          }
        }),
      ],
    }),
  })
})

watch(
  () => props.modelValue,
  (value) => {
    if (!view || value === view.state.doc.toString()) return
    const selection = view.state.selection.main
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
      selection: {
        anchor: Math.min(selection.anchor, value.length),
        head: Math.min(selection.head, value.length),
      },
    })
  },
)

watch(
  schemaForCompletion,
  () => {
    view?.dispatch({ effects: language.reconfigure(sqlExtension()) })
  },
  { deep: true },
)

watch(
  () => props.disabled,
  (disabled) => {
    view?.dispatch({
      effects: editable.reconfigure(editableExtension(!disabled)),
    })
  },
)

watch(
  () => props.placeholder,
  (value) => {
    view?.dispatch({
      effects: placeholderText.reconfigure(editorPlaceholder(value)),
    })
  },
)

onBeforeUnmount(() => {
  view?.destroy()
  view = null
})

defineExpose({ focus, insertText, recordHistory })
</script>

<template>
  <section class="sql-editor panel" aria-labelledby="sql-editor-title">
    <div class="section-heading sql-editor__heading">
      <div class="section-heading__title">
        <h2 id="sql-editor-title">SQL 编辑器</h2>
        <n-tag size="small" :bordered="false" type="info">SQLite</n-tag>
      </div>
      <div class="sql-editor__actions">
        <span class="shortcut-hint">Ctrl+Space 补全 · Ctrl+Enter 执行</span>
        <n-button
          type="primary"
          size="small"
          :loading="loading"
          :disabled="disabled || !modelValue.trim()"
          @click="execute"
        >
          执行
        </n-button>
      </div>
    </div>

    <div class="sql-editor__snippets">
      <div class="sql-editor__snippet-buttons">
        <button
          v-for="snippet in snippets"
          :key="`${snippet.label}-${snippet.insert}`"
          type="button"
          class="sql-editor__snippet"
          :title="`插入 ${JSON.stringify(snippet.insert)}`"
          :disabled="disabled || loading"
          @click="insertSnippet(snippet)"
        >
          {{ snippet.label }}
        </button>
      </div>
      <div class="sql-editor__snippet-actions">
        <n-button size="tiny" quaternary :disabled="disabled" @click="openSnippetEditor">
          编辑片段
        </n-button>
        <n-button size="tiny" quaternary :disabled="disabled" @click="historyVisible = true">
          历史 SQL
        </n-button>
      </div>
    </div>

    <div
      ref="host"
      class="sql-editor__host"
      :class="{ 'sql-editor__host--disabled': disabled }"
      :style="{ '--sql-editor-height': height }"
    />
    <p class="sql-editor__help">
      选中 SQL 时仅执行选区，否则执行编辑器全部内容。表名和列名补全会随左侧 Schema 更新。
    </p>
    <n-alert v-if="error" type="error" :show-icon="true" class="sql-editor__error">
      {{ error }}
    </n-alert>

    <n-modal
      v-model:show="snippetEditorVisible"
      preset="card"
      title="编辑常用片段"
      :style="{ width: 'min(680px, calc(100vw - 32px))' }"
    >
      <p class="sql-editor__snippet-tip">
        「显示名」是按钮文字；「插入文本」是点击后写入编辑器的内容。保存后立即生效并持久保存到本机浏览器。
      </p>
      <div v-if="draftSnippets.length" class="sql-editor__snippet-drafts">
        <div v-for="(snippet, index) in draftSnippets" :key="index" class="sql-editor__snippet-draft-row">
          <n-input
            v-model:value="snippet.label"
            size="small"
            placeholder="显示名"
            class="sql-editor__snippet-draft-label"
          />
          <n-input
            v-model:value="snippet.insert"
            size="small"
            placeholder="插入文本"
            class="sql-editor__snippet-draft-insert"
          />
          <n-button
            size="tiny"
            quaternary
            :disabled="index === 0"
            title="上移"
            @click="moveDraftSnippet(index, -1)"
          >
            ↑
          </n-button>
          <n-button
            size="tiny"
            quaternary
            :disabled="index === draftSnippets.length - 1"
            title="下移"
            @click="moveDraftSnippet(index, 1)"
          >
            ↓
          </n-button>
          <n-button size="tiny" quaternary type="error" title="删除" @click="removeDraftSnippet(index)">
            删除
          </n-button>
        </div>
      </div>
      <n-empty v-else description="还没有任何片段。" />
      <div class="sql-editor__snippet-draft-actions">
        <n-button size="small" @click="addDraftSnippet">添加片段</n-button>
        <n-button size="small" @click="resetSnippetsAndRefreshEditor">恢复默认</n-button>
      </div>
      <template #footer>
        <div class="sql-editor__modal-footer">
          <span>空白的片段保存时会被忽略。</span>
          <n-button type="primary" size="small" @click="finishSnippetEditing">保存并关闭</n-button>
        </div>
      </template>
    </n-modal>

    <n-modal
      v-model:show="historyVisible"
      preset="card"
      title="历史查询"
      :style="{ width: 'min(720px, calc(100vw - 32px))' }"
    >
      <div class="sql-editor__history-config">
        <span>保存设置</span>
        <n-select
          :value="historyConfig.mode"
          :options="historyModeOptions"
          size="small"
          class="sql-editor__history-mode"
          @update:value="updateHistoryConfig({ mode: $event })"
        />
        <n-input-number
          :value="historyConfig.limit"
          size="small"
          :min="1"
          :max="500"
          :precision="0"
          :disabled="historyConfig.mode === 'off'"
          class="sql-editor__history-limit"
          @update:value="updateHistoryConfig({ limit: $event ?? 50 })"
        />
        <span>条</span>
      </div>
      <n-empty
        v-if="historyEntries.length === 0 || historyConfig.mode === 'off'"
        description="暂无历史查询。执行 SQL 后会记录在这里。"
        class="sql-editor__history-empty"
      />
      <div v-else class="sql-editor__history-list">
        <div v-for="(entry, index) in historyEntries" :key="`${entry.executedAt}-${index}`" class="sql-editor__history-row">
          <div class="sql-editor__history-meta">
            <span>{{ formatHistoryTime(entry.executedAt) }}</span>
            <n-button size="tiny" type="primary" secondary @click="useHistoryEntry(entry)">
              使用
            </n-button>
          </div>
          <pre class="sql-editor__history-sql" :title="entry.sql">{{ entry.sql }}</pre>
        </div>
      </div>
    </n-modal>
  </section>
</template>

<style scoped>
.sql-editor {
  min-width: 0;
}

.sql-editor__heading {
  margin-bottom: 12px;
}

.section-heading__title,
.sql-editor__actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.shortcut-hint,
.sql-editor__help {
  color: var(--text-muted);
  font-size: 12px;
}

.sql-editor__host {
  overflow: hidden;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: #fff;
  transition: border-color 0.2s, box-shadow 0.2s;
}

/* 常用片段按钮行：标题下方、编辑器上方。 */
.sql-editor__snippets {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin-bottom: 10px;
}

.sql-editor__snippet-buttons {
  display: flex;
  flex: 1;
  flex-wrap: wrap;
  gap: 6px;
}

.sql-editor__snippet {
  padding: 3px 10px;
  color: #475569;
  border: 1px solid var(--border-color);
  border-radius: 999px;
  background: #f8fafc;
  cursor: pointer;
  font-size: 12px;
  line-height: 1.4;
  transition: border-color 0.15s ease, color 0.15s ease, background-color 0.15s ease;
}

.sql-editor__snippet:hover:not(:disabled) {
  color: #4c78d6;
  border-color: #4c78d6;
  background: #f0f5ff;
}

.sql-editor__snippet:disabled {
  color: #cbd5e1;
  cursor: default;
}

.sql-editor__snippet:focus-visible {
  outline: 2px solid #4c70c9;
  outline-offset: 1px;
}

.sql-editor__snippet-actions {
  display: flex;
  flex: 0 0 auto;
  gap: 2px;
}

.sql-editor__snippet-tip {
  margin: 0;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.6;
}

.sql-editor__snippet-drafts {
  display: grid;
  gap: 8px;
  margin-top: 12px;
}

.sql-editor__snippet-draft-row {
  display: grid;
  grid-template-columns: minmax(110px, 150px) minmax(0, 1fr) auto auto auto;
  align-items: center;
  gap: 8px;
}

.sql-editor__snippet-draft-actions {
  display: flex;
  gap: 8px;
  margin-top: 14px;
}

.sql-editor__modal-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.sql-editor__modal-footer > span {
  color: var(--text-muted);
  font-size: 11px;
}

.sql-editor__history-config {
  display: flex;
  align-items: center;
  gap: 10px;
  color: #475569;
  font-size: 12px;
}

.sql-editor__history-mode {
  width: 140px;
}

.sql-editor__history-limit {
  width: 110px;
}

.sql-editor__history-empty {
  margin: 26px 0;
}

.sql-editor__history-list {
  display: grid;
  gap: 10px;
  max-height: min(48vh, 460px);
  margin-top: 12px;
  overflow: auto;
}

.sql-editor__history-row {
  padding: 10px 12px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--surface-muted);
}

.sql-editor__history-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  color: var(--text-muted);
  font-size: 11px;
}

.sql-editor__history-sql {
  overflow: hidden;
  max-height: 64px;
  margin: 8px 0 0;
  color: #334155;
  font: 12px/1.6 "Cascadia Code", Consolas, monospace;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.sql-editor__host:focus-within {
  border-color: #4c78d6;
  box-shadow: 0 0 0 2px rgb(76 120 214 / 12%);
}

.sql-editor__host--disabled {
  opacity: 0.68;
  background: var(--surface-muted);
}

.sql-editor__host :deep(.cm-editor) {
  height: var(--sql-editor-height);
  color: #1f2937;
  font-size: 13px;
}

.sql-editor__host :deep(.cm-scroller) {
  overflow: auto;
  font-family: "Cascadia Code", "SFMono-Regular", Consolas, monospace;
  line-height: 1.65;
}

.sql-editor__host :deep(.cm-gutters) {
  color: #94a3b8;
  border-right-color: #edf0f5;
  background: #f8fafc;
}

.sql-editor__host :deep(.cm-activeLine),
.sql-editor__host :deep(.cm-activeLineGutter) {
  background: rgb(76 120 214 / 6%);
}

.sql-editor__host :deep(.cm-tooltip) {
  z-index: 2200;
  border-color: var(--border-color);
  box-shadow: 0 8px 24px rgb(15 23 42 / 14%);
}

.sql-editor__help {
  margin: 8px 0 0;
}

.sql-editor__error {
  margin-top: 10px;
}

@media (max-width: 1100px) {
  .shortcut-hint {
    display: none;
  }
}
</style>
