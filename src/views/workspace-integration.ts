import type { InjectionKey } from 'vue'

import type { DatabaseSchema } from '../core/database/schema'
import type {
  QueryResultPage,
  ResultPageRequest,
  SqlExecutionResult,
} from '../core/database/query'
import type { Diagnostic } from '../core/model/diagnostic'
import type { ImportMapping } from '../core/model/conversion'
import type { TableSchema } from '../core/model/table'
import type {
  FileImportRequest,
  WorkspaceExportOptions,
} from '../components/contracts'

export interface WorkspaceImportPreparation {
  /** 父层抽样/解析得到的源表结构，用于确认列映射。 */
  sourceSchema: TableSchema
  targetTableName: string
  /** 可选的父层句柄；确认导入时原样回传，视图不会持久化或解释它。 */
  context?: unknown
}

export interface WorkspaceOperationResult {
  /** 若提供 schema，视图直接采用；否则会在导入后调用 getSchema。 */
  schema?: DatabaseSchema
  /** 无 getSchema 时也可用 table 增量更新左侧结构。 */
  table?: TableSchema
  recordCount?: number
  diagnostics?: readonly Diagnostic[]
  activeTableName?: string
}

/**
 * 工作区唯一的数据集成边界。适配器可委托现有 service/Worker，视图本身不接触它们。
 * 所有结果页只短暂保存在 WorkspaceView 内，不进入 Pinia。
 */
export interface WorkspaceIntegration {
  /** 可选：先解析表头并进入列映射；未提供时 importFile 直接执行导入。 */
  prepareImport?(
    request: FileImportRequest,
  ): Promise<WorkspaceImportPreparation>
  /** mapping/context 仅在 prepareImport 流程的确认步骤传入。 */
  importFile?(
    request: FileImportRequest,
    mapping?: ImportMapping,
    context?: unknown,
  ): Promise<WorkspaceOperationResult | void>
  createWorkspace?(): Promise<WorkspaceOperationResult | void>
  executeSql?(sql: string): Promise<SqlExecutionResult>
  getResultPage?(request: ResultPageRequest): Promise<QueryResultPage>
  getSchema?(): Promise<DatabaseSchema>
  exportData?(options: WorkspaceExportOptions): Promise<void>
}

/**
 * 两种集成方式任选其一：
 *
 * 1. 模板：`<WorkspaceView :api="workspaceAdapter" />`；
 * 2. 根组件：`provide(workspaceIntegrationKey, workspaceAdapter)`。
 *
 * 适配器只需实现实际使用的方法。缺少必需方法时，操作会发出对应事件并显示
 * “未接入”错误，便于父层逐步接入。视图同时发出 import-request、new-workspace、
 * execute-sql、page-request、export-request、mapping-submit 和 schema-change 事件，
 * 可用于埋点或纯回调集成；需要异步返回数据时应使用 WorkspaceIntegration。
 */
export const workspaceIntegrationKey: InjectionKey<WorkspaceIntegration> = Symbol(
  'data-convert-workspace-integration',
)
