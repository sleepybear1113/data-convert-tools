import { readFile } from 'node:fs/promises'

import { expect, test } from '@playwright/test'

import { createNodeSqlJsEngine } from '../../src/core/database/sqljs-node'
import { readXlsx } from '../../src/core/formats/xlsx'
import { decodeCsv } from '../../src/core/formats/csv'

test('renders the initial workspace shell', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '数据转换工具', exact: true })).toBeVisible()
  await expect(page.getByText('DBF · SQLite · XLSX · CSV', { exact: true })).toBeVisible()
})

test('imports DBF, maps columns, queries and exports DBF in Chromium', async ({ page }) => {
  test.setTimeout(60_000)
  await page.goto('/')
  await page.getByRole('button', { name: '导入文件', exact: true }).click()
  await page.locator('input[type=file]').setInputFiles('tests/fixtures/dbf/vfp-0x30-c-nulls.dbf')
  await page.getByRole('button', { name: '继续', exact: true }).click()
  await expect(page.getByRole('heading', { name: '确认导入映射', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '确认导入', exact: true }).click()
  await expect(page.getByText(/导入完成/).first()).toBeVisible()
  // 表名默认取导入文件名（去扩展名），并显示列数与行数。
  await expect(page.locator('.workspace__sidebar').getByText('vfp-0x30-c-nulls', { exact: true }).first()).toBeVisible()
  await expect(page.locator('.workspace__sidebar').getByText(/44 列 · 1 行/).first()).toBeVisible()

  await page.locator('.cm-content').click()
  await page.keyboard.press('Control+A')
  await page.keyboard.insertText('SELECT COUNT(*) AS total_rows FROM "vfp-0x30-c-nulls";')
  await page.getByRole('button', { name: '执行', exact: true }).click()
  await expect(page.locator('.result-grid__table')).toContainText('total_rows')
  await expect(page.locator('.result-grid__table')).toContainText('1')

  await page.getByRole('button', { name: '导出', exact: true }).click()
  await page.locator('.export-dialog').getByText('DBF', { exact: true }).click()
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '开始导出', exact: true }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toMatch(/^vfp-0x30-c-nulls_导出_\d{8}_\d{6}\.dbf$/)

  const path = await download.path()
  const bytes = await readFile(path!)
  expect(bytes.readUInt32LE(4)).toBe(1)
  expect(bytes.readUInt16LE(8)).toBe(1736)
  expect(bytes[bytes.length - 1]).toBe(0x1a)
})

test('converts CSV to XLSX and SQLite in Chromium', async ({ page }) => {
  test.setTimeout(60_000)
  await page.goto('/')
  await page.getByRole('button', { name: '导入文件', exact: true }).click()
  await page.locator('input[type=file]').setInputFiles('tests/fixtures/csv/people.csv')
  await page.getByRole('button', { name: '继续', exact: true }).click()
  await expect(page.getByRole('heading', { name: '确认导入映射', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '确认导入', exact: true }).click()
  await expect(page.getByText(/导入完成/).first()).toBeVisible()

  await page.getByRole('button', { name: '导出', exact: true }).click()
  await page.locator('.export-dialog').getByText('Excel (.xlsx)', { exact: true }).click()
  const xlsxDownloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '开始导出', exact: true }).click()
  const xlsxDownload = await xlsxDownloadPromise
  expect(xlsxDownload.suggestedFilename()).toMatch(/^people_导出_\d{8}_\d{6}\.xlsx$/)
  const xlsxBytes = await readFile((await xlsxDownload.path())!)
  const workbook = readXlsx(xlsxBytes)
  expect(workbook.rows).toHaveLength(2)
  expect(workbook.rows[0].slice(0, 2)).toEqual(['001', '张三'])

  await page.getByRole('button', { name: '导出', exact: true }).click()
  await page.locator('.export-dialog').getByText('SQLite', { exact: true }).click()
  const sqliteDownloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '开始导出', exact: true }).click()
  const sqliteDownload = await sqliteDownloadPromise
  expect(sqliteDownload.suggestedFilename()).toMatch(/^people_导出_\d{8}_\d{6}\.sqlite$/)

  const sqliteBytes = await readFile((await sqliteDownload.path())!)
  const engine = createNodeSqlJsEngine()
  try {
    await engine.open(sqliteBytes)
    expect((await engine.getSchema()).tables[0].name).toBe('people')
    const execution = await engine.execute('SELECT COUNT(*) FROM "people"')
    const resultId = execution.statements[0].resultId!
    const pageResult = await engine.getResultPage({ resultId, offset: 0, limit: 1 })
    expect(pageResult.rows[0][0]).toBe(2)
    await engine.releaseResult(resultId)
  } finally {
    await engine.close()
  }

  await page.getByRole('button', { name: '新建工作区', exact: true }).click()
  await page.locator('.n-modal:visible').getByRole('button', { name: '新建工作区', exact: true }).click()
  await expect(page.getByText(/已新建空白工作区/).first()).toBeVisible()
  await page.getByRole('button', { name: '导入文件', exact: true }).click()
  await page.locator('input[type=file]').setInputFiles({
    name: 'imported_data.sqlite',
    mimeType: 'application/vnd.sqlite3',
    buffer: sqliteBytes,
  })
  await page.getByRole('button', { name: '继续', exact: true }).click()
  await expect(page.getByText(/导入完成/).first()).toBeVisible()
  // SQLite 导入直接打开数据库，表名来自库内数据（people），与文件名无关。
  await expect(page.locator('.workspace__sidebar').getByText('people', { exact: true }).first()).toBeVisible()
})

test('imports XLSX and exports the current query as CSV', async ({ page }) => {
  test.setTimeout(60_000)
  await page.goto('/')
  await page.getByRole('button', { name: '导入文件', exact: true }).click()
  await page.locator('input[type=file]').setInputFiles('tests/fixtures/xlsx/people.xlsx')
  await page.getByRole('button', { name: '继续', exact: true }).click()
  await expect(page.getByRole('heading', { name: '确认导入映射', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '确认导入', exact: true }).click()
  await expect(page.getByText(/导入完成/).first()).toBeVisible()

  await page.locator('.cm-content').click()
  await page.keyboard.press('Control+A')
  await page.keyboard.insertText('SELECT id, name FROM "people" WHERE active = 1;')
  await page.getByRole('button', { name: '执行', exact: true }).click()
  await expect(page.locator('.result-grid__table')).toContainText('张三')
  await expect(page.locator('.result-grid__table')).not.toContainText('李四')

  await page.getByRole('button', { name: '导出', exact: true }).click()
  await page.locator('.export-dialog').getByText('当前查询结果', { exact: true }).click()
  await page.locator('.export-dialog').getByText('CSV', { exact: true }).click()
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '开始导出', exact: true }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toMatch(/^people_导出_\d{8}_\d{6}\.csv$/)

  const bytes = await readFile((await download.path())!)
  expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
  const text = decodeCsv(bytes, 'utf-8').text
  expect(text).toContain('张三')
  expect(text).not.toContain('李四')
})

test('renames and deletes tables with confirmation', async ({ page }) => {
  test.setTimeout(60_000)
  await page.goto('/')
  await page.getByRole('button', { name: '导入文件', exact: true }).click()
  await page.locator('input[type=file]').setInputFiles('tests/fixtures/csv/people.csv')
  await page.getByRole('button', { name: '继续', exact: true }).click()
  await page.getByRole('button', { name: '确认导入', exact: true }).click()
  await expect(page.getByText(/导入完成/).first()).toBeVisible()

  // 重命名 people → 人员信息
  const row = page.locator('.workspace__sidebar').locator('.schema-navigator__table-row').first()
  await row.getByRole('button', { name: '重命名 people' }).click()
  const renameInput = page.locator('.schema-navigator__rename-input input')
  await renameInput.fill('人员信息')
  await renameInput.press('Enter')
  await expect(page.getByText(/已重命名数据表/).first()).toBeVisible()
  await expect(page.locator('.workspace__sidebar').getByText('人员信息', { exact: true }).first()).toBeVisible()

  // 删除需要二次确认
  await row.getByRole('button', { name: '删除 人员信息' }).click()
  const deleteDialog = page.locator('.n-modal:visible').filter({ hasText: '将删除数据表' })
  await expect(deleteDialog).toBeVisible()
  await deleteDialog.getByRole('button', { name: '删除数据表', exact: true }).click()
  await expect(page.getByText(/已删除数据表：人员信息/).first()).toBeVisible()
  await expect(page.locator('.workspace__sidebar').getByText('人员信息', { exact: true })).toHaveCount(0)
})

test('imports the same file name twice with numbered suffixes', async ({ page }) => {
  test.setTimeout(60_000)
  await page.goto('/')
  for (const expected of ['people', 'people_1', 'people_2']) {
    await page.getByRole('button', { name: '导入文件', exact: true }).click()
    await page.locator('input[type=file]').setInputFiles('tests/fixtures/csv/people.csv')
    await page.getByRole('button', { name: '继续', exact: true }).click()
    await expect(page.getByRole('heading', { name: '确认导入映射', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '确认导入', exact: true }).click()
    await expect(page.getByText(/导入完成/).first()).toBeVisible()
    await expect(page.locator('.workspace__sidebar').getByText(expected, { exact: true }).first()).toBeVisible()
  }
})

test('exports grouped files as a ZIP archive', async ({ page }) => {
  test.setTimeout(60_000)
  await page.goto('/')
  await page.getByRole('button', { name: '导入文件', exact: true }).click()
  await page.locator('input[type=file]').setInputFiles('tests/fixtures/csv/people.csv')
  await page.getByRole('button', { name: '继续', exact: true }).click()
  await page.getByRole('button', { name: '确认导入', exact: true }).click()
  await expect(page.getByText(/导入完成/).first()).toBeVisible()

  // 深度类型检测工具行：一键全部设为文本 + 重新检测类型（默认前 2000 行）
  await page.getByRole('button', { name: '导入文件', exact: true }).click()
  await page.locator('input[type=file]').setInputFiles('tests/fixtures/csv/people.csv')
  await page.getByRole('button', { name: '继续', exact: true }).click()
  await expect(page.getByRole('heading', { name: '确认导入映射', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '全部设为文本', exact: true }).click()
  await expect(page.locator('.mapping-editor__table tbody').first().getByText('文本', { exact: true }).first()).toBeVisible()
  await page.getByRole('button', { name: '重新检测类型', exact: true }).click()
  await page.locator('.mapping-editor__tools').getByText('检测行数', { exact: true }).waitFor()
  // 取消导入，不影响后续流程
  await page.locator('.n-modal:visible').getByRole('button', { name: '取消', exact: true }).click()
  await expect(page.locator('.n-modal:visible')).toHaveCount(0)

  await page.locator('.cm-content').click()
  await page.keyboard.press('Control+A')
  await page.keyboard.insertText('SELECT id, name, active FROM "people";')
  await page.getByRole('button', { name: '执行', exact: true }).click()
  await expect(page.locator('.result-grid__table')).toContainText('张三')

  await page.getByRole('button', { name: '分组导出列', exact: true }).click()
  // naive-ui 的 ellipsis 包装会在表头文本前插入一个空格，正则需容忍空白
  const activeHeader = page.locator('.result-grid__table .n-data-table-th').filter({ hasText: /^\s*active\s*$/ })
  await activeHeader.locator('.n-checkbox').click()
  await expect(page.getByText('已选 1 列')).toBeVisible()

  await page.getByRole('button', { name: '导出', exact: true }).click()
  await page.locator('.export-dialog').getByText('当前查询结果', { exact: true }).click()
  await page.locator('.export-dialog').getByText('按勾选列分组导出', { exact: true }).click()
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '开始导出', exact: true }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toMatch(/^people_分组导出_\d{8}_\d{6}\.zip$/)

  const bytes = await readFile((await download.path())!)
  expect(bytes[0]).toBe(0x50)
  expect(bytes[1]).toBe(0x4b)
  // EOCD 中条目数 = 2（true / false 各一个文件）
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  expect(view.getUint16(bytes.length - 22 + 10, true)).toBe(2)
})

test('exports the whole table grouped via the table source', async ({ page }) => {
  test.setTimeout(60_000)
  await page.goto('/')
  await page.getByRole('button', { name: '导入文件', exact: true }).click()
  await page.locator('input[type=file]').setInputFiles('tests/fixtures/csv/people.csv')
  await page.getByRole('button', { name: '继续', exact: true }).click()
  await page.getByRole('button', { name: '确认导入', exact: true }).click()
  await expect(page.getByText(/导入完成/).first()).toBeVisible()

  // 简单单表 SELECT：应识别为可整表分组导出
  await page.locator('.cm-content').click()
  await page.keyboard.press('Control+A')
  await page.keyboard.insertText('SELECT * FROM "people" LIMIT 500;')
  await page.getByRole('button', { name: '执行', exact: true }).click()
  await expect(page.locator('.result-grid__table')).toContainText('张三')

  await page.getByRole('button', { name: '分组导出列', exact: true }).click()
  const activeHeader = page.locator('.result-grid__table .n-data-table-th').filter({ hasText: /^\s*active\s*$/ })
  await activeHeader.locator('.n-checkbox').click()
  await expect(page.getByText('已选 1 列')).toBeVisible()

  await page.getByRole('button', { name: '导出', exact: true }).click()
  // 默认来源即「选中的数据表」：分组选项应对整张表生效
  await page.locator('.export-dialog').getByText('按勾选列分组导出', { exact: true }).click()
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '开始导出', exact: true }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toMatch(/^people_分组导出_\d{8}_\d{6}\.zip$/)

  const bytes = await readFile((await download.path())!)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  expect(view.getUint16(bytes.length - 22 + 10, true)).toBe(2)
})

test('supports snippets, table-name insertion, query history and preview confirmation', async ({ page }) => {
  test.setTimeout(60_000)
  await page.goto('/')
  await page.getByRole('button', { name: '导入文件', exact: true }).click()
  await page.locator('input[type=file]').setInputFiles('tests/fixtures/csv/people.csv')
  await page.getByRole('button', { name: '继续', exact: true }).click()
  await page.getByRole('button', { name: '确认导入', exact: true }).click()
  await expect(page.getByText(/导入完成/).first()).toBeVisible()

  // 片段按钮：点击 SELECT 插入关键词
  await page.locator('.sql-editor__snippet').filter({ hasText: /^SELECT$/ }).click()
  await expect(page.locator('.cm-content')).toContainText('SELECT')

  // 点击表名：选中 + 展开的同时把带引号的表名插入编辑器
  await page.locator('.schema-navigator__table-select').first().click()
  await expect(page.locator('.cm-content')).toContainText('"people"')

  // 替换为合法查询并执行 → 记录历史
  await page.locator('.cm-content').click()
  await page.keyboard.press('Control+A')
  await page.keyboard.insertText('SELECT * FROM "people" LIMIT 500;')
  await page.getByRole('button', { name: '执行', exact: true }).click()
  await expect(page.locator('.result-grid__table')).toContainText('张三')

  // 历史 SQL 弹窗：最新在最上面，带执行时间，「使用」替换编辑器
  await page.getByRole('button', { name: '历史 SQL', exact: true }).click()
  const historyDialog = page.locator('.n-modal:visible').filter({ hasText: '历史查询' })
  await expect(historyDialog).toBeVisible()
  await expect(historyDialog.getByText(/SELECT \* FROM "people" LIMIT 500;/).first()).toBeVisible()
  await expect(historyDialog.locator('.sql-editor__history-row').first().locator('.sql-editor__history-meta span').first()).toContainText('/')
  await historyDialog.getByRole('button', { name: '使用', exact: true }).first().click()
  await expect(page.locator('.n-modal:visible')).toHaveCount(0)
  await expect(page.locator('.cm-content')).toContainText('LIMIT 500')

  // 编辑器有内容时点击「查询」：需要确认清空
  await page.locator('.schema-navigator__table-row').first().hover()
  await page.locator('.schema-navigator__preview').first().click()
  const confirmDialog = page.locator('.n-modal:visible').filter({ hasText: '清空 SQL 编辑器' })
  await expect(confirmDialog).toBeVisible()
  await confirmDialog.getByRole('button', { name: '继续并执行查询', exact: true }).click()
  await expect(page.locator('.cm-content')).toContainText('SELECT *')
  await expect(page.locator('.result-grid__table')).toContainText('张三')

  // 编辑器为空（默认模板）时点击「查询」不弹确认：新建工作区并重新导入后直接执行
  await page.getByRole('button', { name: '新建工作区', exact: true }).click()
  await page.locator('.n-modal:visible').getByRole('button', { name: '新建工作区', exact: true }).click()
  await expect(page.getByText(/已新建空白工作区/).first()).toBeVisible()
  await page.getByRole('button', { name: '导入文件', exact: true }).click()
  await page.locator('input[type=file]').setInputFiles('tests/fixtures/csv/people.csv')
  await page.getByRole('button', { name: '继续', exact: true }).click()
  await page.getByRole('button', { name: '确认导入', exact: true }).click()
  await expect(page.getByText(/导入完成：people/).first()).toBeVisible()
  await page.locator('.schema-navigator__preview').first().click()
  await expect(page.locator('.result-grid__table')).toContainText('张三')
  await expect(page.locator('.cm-content')).toContainText('SELECT *')
})
