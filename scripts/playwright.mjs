import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { access } from 'node:fs/promises'

const cli = resolve('node_modules/playwright/cli.js')
await access(cli)

const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: {
    ...process.env,
    PLAYWRIGHT_BROWSERS_PATH: resolve('.cache/ms-playwright'),
  },
})

child.on('error', (error) => {
  console.error(error)
  process.exitCode = 1
})

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`Playwright exited with signal ${signal}`)
    process.exitCode = 1
    return
  }

  process.exitCode = code ?? 1
})
