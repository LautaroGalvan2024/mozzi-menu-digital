// Explicit file enumeration works on Node 22 in both Windows and POSIX shells.
import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const directory = fileURLToPath(new URL('.', import.meta.url))
const files = readdirSync(directory).filter(file => file.endsWith('.test.mjs')).sort().map(file => path.join(directory, file))
if (files.length === 0) throw new Error('No operational tests found')
const result = spawnSync(process.execPath, ['--test', ...files], { windowsHide: true, stdio: 'inherit' })
if (result.error) throw new Error('Cannot launch operational tests')
process.exitCode = result.status ?? 1
