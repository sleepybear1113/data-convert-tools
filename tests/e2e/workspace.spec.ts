import { readFile } from 'node:fs/promises'

import { expect, test } from '@playwright/test'

import { createNodeSqlJsEngine } from '../../src/core/database/sqljs-node'
import { readXlsx } from '../../src/core/formats/xlsx'
import { decodeCsv } from '../../src/core/formats/csv'

test('renders the initial workspace shell', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Data Convert Tools', exact: true })).toBeVisible()
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
  await expect(page.locator('.workspace__sidebar').getByText('imported_data', { exact: true }).first()).toBeVisible()

  await page.locator('.cm-content').click()
  await page.keyboard.press('Control+A')
  await page.keyboard.insertText('SELECT COUNT(*) AS total_rows FROM imported_data;')
  await page.getByRole('button', { name: '执行', exact: true }).click()
  await expect(page.locator('.result-grid__table')).toContainText('total_rows')
  await expect(page.locator('.result-grid__table')).toContainText('1')

  await page.getByRole('button', { name: '导出', exact: true }).click()
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '开始导出', exact: true }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe('imported_data.dbf')

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
  await page.locator('.export-dialog').getByText('XLSX', { exact: true }).click()
  const xlsxDownloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '开始导出', exact: true }).click()
  const xlsxDownload = await xlsxDownloadPromise
  expect(xlsxDownload.suggestedFilename()).toBe('imported_data.xlsx')
  const xlsxBytes = await readFile((await xlsxDownload.path())!)
  const workbook = readXlsx(xlsxBytes)
  expect(workbook.rows).toHaveLength(2)
  expect(workbook.rows[0].slice(0, 2)).toEqual(['001', '张三'])

  await page.getByRole('button', { name: '导出', exact: true }).click()
  await page.locator('.export-dialog').getByText('SQLite', { exact: true }).click()
  const sqliteDownloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '开始导出', exact: true }).click()
  const sqliteDownload = await sqliteDownloadPromise
  expect(sqliteDownload.suggestedFilename()).toBe('imported_data.sqlite')

  const sqliteBytes = await readFile((await sqliteDownload.path())!)
  const engine = createNodeSqlJsEngine()
  try {
    await engine.open(sqliteBytes)
    expect((await engine.getSchema()).tables[0].name).toBe('imported_data')
    const execution = await engine.execute('SELECT COUNT(*) FROM imported_data')
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
  await expect(page.locator('.workspace__sidebar').getByText('imported_data', { exact: true }).first()).toBeVisible()
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
  await page.keyboard.insertText('SELECT id, name FROM imported_data WHERE active = 1;')
  await page.getByRole('button', { name: '执行', exact: true }).click()
  await expect(page.locator('.result-grid__table')).toContainText('张三')
  await expect(page.locator('.result-grid__table')).not.toContainText('李四')

  await page.getByRole('button', { name: '导出', exact: true }).click()
  await page.locator('.export-dialog').getByText('当前查询', { exact: true }).click()
  await page.locator('.export-dialog').getByText('CSV', { exact: true }).click()
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '开始导出', exact: true }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe('query_result.csv')

  const bytes = await readFile((await download.path())!)
  expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
  const text = decodeCsv(bytes, 'utf-8').text
  expect(text).toContain('张三')
  expect(text).not.toContain('李四')
})
