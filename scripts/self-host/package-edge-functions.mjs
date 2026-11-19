import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('../../', import.meta.url))
const functions = path.join(repo, 'supabase', 'functions')
const sourceTypes = path.join(repo, 'src', 'types', 'database.generated.ts')
const sourceImport = '../../../src/types/database.generated.ts'

function packageFunctions(destination) {
  if (existsSync(destination)) throw new Error('El directorio de destino debe ser nuevo.')

  const entries = readdirSync(functions).filter(name => (
    /^(_shared|[a-z][a-z0-9-]*)$/.test(name) && statSync(path.join(functions, name)).isDirectory()
  ))
  mkdirSync(destination, { recursive: true })
  for (const name of [...entries, 'deno.json', 'deno.lock']) {
    cpSync(path.join(functions, name), path.join(destination, name), {
      recursive: true,
      filter: source => !source.endsWith('_test.ts'),
    })
  }

  // Edge Runtime only mounts the functions directory. Include the canonical
  // generated types in the package so Deno can resolve its graph inside it.
  const shared = path.join(destination, '_shared')
  cpSync(sourceTypes, path.join(shared, 'database.generated.ts'))
  for (const name of readdirSync(shared).filter(name => name.endsWith('.ts'))) {
    const file = path.join(shared, name)
    const content = readFileSync(file, 'utf8')
    if (content.includes(sourceImport)) {
      writeFileSync(file, content.replaceAll(sourceImport, './database.generated.ts'))
    }
  }
  console.log(`Paquete de funciones preparado (${entries.length - 1} funciones).`)
}

if (process.argv.length !== 3) {
  console.error('Uso: node scripts/self-host/package-edge-functions.mjs <directorio-nuevo>')
  process.exitCode = 1
} else {
  packageFunctions(path.resolve(process.argv[2]))
}
