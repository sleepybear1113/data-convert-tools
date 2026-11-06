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
import { NAlert, NButton, NTag } from 'naive-ui'

import type {
  DatabaseSchema,
  SqlCompletionSchema,
} from '../core/database/schema'

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

defineExpose({ focus, insertText })
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
