import { mkdir, writeFile } from 'node:fs/promises'
import { utils, write } from 'xlsx'

const worksheet = utils.aoa_to_sheet([
  ['id', 'name', 'amount', 'active'],
  ['001', '张三', 12.5, true],
  ['002', '李四', 13.6, false],
])
const workbook = utils.book_new()
utils.book_append_sheet(workbook, worksheet, 'People')
const bytes = write(workbook, { type: 'buffer', bookType: 'xlsx', compression: true })
await mkdir('tests/fixtures/xlsx', { recursive: true })
await writeFile('tests/fixtures/xlsx/people.xlsx', bytes)
