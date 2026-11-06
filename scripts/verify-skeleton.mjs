import assert from 'node:assert/strict'
import { access, readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { chunkIterable } from '../src/core/utils/chunks.ts'
import { significantDigits } from '../src/core/utils/decimal.ts'
import { quoteSqliteIdentifier, uniqueName } from '../src/core/utils/identifiers.ts'

assert.equal(quoteSqliteIdentifier('a"b'), '"a""b"')
assert.equal(uniqueName('name', new Set(['name', 'name_2'])), 'name_3')
assert.equal(significantDigits('-00123.4500'), 7)

async function* values() {
  yield 1
  yield 2
  yield 3
}

const chunks = []
for await (const chunk of chunkIterable(values(), 2)) {
  chunks.push([...chunk])
}
assert.deepEqual(chunks, [[1, 2], [3]])

const packageJson = JSON.parse(await readFile('package.json', 'utf8'))
assert.equal(packageJson.dependencies.xlsx, 'file:third_party/sheetjs/xlsx-0.20.3.tgz')
await access('third_party/sheetjs/xlsx-0.20.3.tgz')

const pureDirectories = ['src/core/model', 'src/core/utils']
let loadedModules = 0

for (const directory of pureDirectories) {
  const files = await readdir(resolve(directory), { recursive: true })
  for (const file of files.filter((file) => file.endsWith('.ts'))) {
    await import(pathToFileURL(resolve(directory, file)).href)
    loadedModules += 1
  }
}

console.log(`Skeleton assertions passed; loaded ${loadedModules} pure modules.`)
