import { spawn } from 'node:child_process'
import { delimiter, dirname, join } from 'node:path'
import { access } from 'node:fs/promises'

const nodeHome = dirname(process.execPath)
const npmCli = join(nodeHome, 'node_modules', 'npm', 'bin', 'npm-cli.js')

await access(npmCli)

const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH'
const child = spawn(process.execPath, [npmCli, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: {
    ...process.env,
    [pathKey]: `${nodeHome}${delimiter}${process.env[pathKey] ?? ''}`,
  },
})

child.on('error', (error) => {
  console.error(error)
  process.exitCode = 1
})

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`npm exited with signal ${signal}`)
    process.exitCode = 1
    return
  }

  process.exitCode = code ?? 1
})
