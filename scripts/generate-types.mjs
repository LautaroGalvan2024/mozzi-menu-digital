import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const outputPath = path.resolve(
  process.cwd(),
  process.env.SUPABASE_TYPES_OUTPUT ?? 'src/types/database.generated.ts',
)
const projectId = process.env.SUPABASE_PROJECT_ID?.trim()
const databaseUrl = process.env.SUPABASE_DB_URL?.trim()
const sourceArguments = projectId
  ? ['--project-id', projectId]
  : databaseUrl
    ? ['--db-url', databaseUrl]
    : ['--local']
const command = [
  'gen',
  'types',
  'typescript',
  ...sourceArguments,
  '--schema',
  'public',
]

const localCli = path.resolve(process.cwd(), 'node_modules/supabase/dist/supabase.js')
const candidates = process.env.SUPABASE_CLI
  ? [{ executable: process.env.SUPABASE_CLI, prefix: [] }]
  : existsSync(localCli)
    ? [{ executable: process.execPath, prefix: [localCli] }]
    : [{ executable: 'supabase', prefix: [] }]

let result
for (const candidate of candidates) {
  result = spawnSync(candidate.executable, [...candidate.prefix, ...command], {
    cwd: process.cwd(),
    encoding: 'utf8',
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  if (!result.error) {
    break
  }
}

if (!result || result.error || result.status !== 0) {
  console.error('No se pudieron generar los tipos de Supabase.')
  console.error('Verificá que la CLI esté instalada y que Supabase local esté iniciado, o definí SUPABASE_PROJECT_ID/SUPABASE_DB_URL.')
  if (result?.stderr?.trim()) {
    console.error(result.stderr.trim())
  }
  process.exit(result?.status ?? 1)
}

const generated = result.stdout.trimStart()

if (!generated.includes('export type Database') || generated.length < 500) {
  console.error('La CLI devolvió una salida inesperada; el archivo existente no fue reemplazado.')
  process.exit(1)
}

await mkdir(path.dirname(outputPath), { recursive: true })
await writeFile(outputPath, generated, { encoding: 'utf8', flag: 'w' })
console.log(`Tipos generados en ${path.relative(process.cwd(), outputPath)}.`)
