import type { DatabaseEngine } from '../core/database/engine'
import type { DataSelection } from '../core/model/conversion'
import type { TableRow } from '../core/model/table'
import { quoteSqliteIdentifier } from '../core/utils/identifiers'

const PAGE_SIZE = 1000

export interface SelectionReader {
  columns: readonly string[]
  recordCount: number
  rows: AsyncIterable<TableRow>
  release(): Promise<void>
}

export async function readSelection(
  engine: DatabaseEngine,
  selection: Exclude<DataSelection, { kind: 'workspace' }>,
): Promise<SelectionReader> {
  let resultId = selection.kind === 'query' ? selection.resultId : undefined
  let totalRowsHint: number | undefined
  let ownsResult = false

  if (!resultId) {
    const sql = selection.kind === 'table'
      ? `SELECT * FROM ${quoteSqliteIdentifier(selection.tableName)}`
      : selection.sql
    const execution = await engine.execute(sql)
    const result = [...execution.statements].reverse().find((statement) => statement.resultId)
    if (!result?.resultId) {
      throw new Error('The selected SQL did not produce a tabular result')
    }
    resultId = result.resultId
    totalRowsHint = result.totalRows
    ownsResult = true
  }

  const activeResultId = resultId
  let released = false
  const release = async (): Promise<void> => {
    if (released) return
    released = true
    if (ownsResult) await engine.releaseResult(activeResultId)
  }

  let firstPage: Awaited<ReturnType<DatabaseEngine['getResultPage']>>
  try {
    firstPage = await engine.getResultPage({ resultId: activeResultId, offset: 0, limit: PAGE_SIZE })
  } catch (error) {
    await release()
    throw error
  }

  const totalRows = firstPage.totalRows ?? totalRowsHint
  if (totalRows === undefined) {
    await release()
    throw new Error('The result row count is unavailable')
  }

  const rows: AsyncIterable<TableRow> = {
    async *[Symbol.asyncIterator]() {
      try {
        yield* firstPage.rows
        let offset = firstPage.rows.length

        while (offset < totalRows) {
          const page = await engine.getResultPage({ resultId: activeResultId, offset, limit: PAGE_SIZE })
          if (page.rows.length === 0) break
          yield* page.rows
          offset += page.rows.length
        }
      } finally {
        await release()
      }
    },
  }

  return {
    columns: firstPage.columns,
    recordCount: totalRows,
    rows,
    release,
  }
}
