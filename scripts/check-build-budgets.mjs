import { readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { join } from 'node:path'

const distDir = join(process.cwd(), 'dist')
const manifestPath = join(distDir, '.vite', 'manifest.json')

let manifest
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
} catch (error) {
  console.error(`No se pudo leer ${manifestPath}. Ejecutá npm run build antes del presupuesto.`)
  throw error
}

const kib = (bytes) => bytes / 1024
const gzipBytes = (relativePath) => gzipSync(readFileSync(join(distDir, relativePath))).byteLength

function collectGraph(entryKeys) {
  const visitedEntries = new Set()
  const jsFiles = new Set()
  const cssFiles = new Set()

  function visit(key) {
    if (visitedEntries.has(key)) return
    const entry = manifest[key]
    if (!entry) throw new Error(`El manifest no contiene la entrada esperada: ${key}`)
    visitedEntries.add(key)
    if (entry.file?.endsWith('.js')) jsFiles.add(entry.file)
    for (const css of entry.css ?? []) cssFiles.add(css)
    for (const dependency of entry.imports ?? []) visit(dependency)
  }

  for (const key of entryKeys) visit(key)
  return { jsFiles, cssFiles }
}

function measure(entryKeys, includeDocument = false) {
  const { jsFiles, cssFiles } = collectGraph(entryKeys)
  const js = [...jsFiles].reduce((total, file) => total + gzipBytes(file), 0)
  const css = [...cssFiles].reduce((total, file) => total + gzipBytes(file), 0)
  const document = includeDocument ? gzipBytes('index.html') : 0
  return { js, css, document, total: js + css + document }
}

const routes = {
  landing: ['index.html', 'src/pages/LandingPage.tsx'],
  menu: ['index.html', 'src/app/preload-public-catalog.ts', 'src/app/CommerceProviders.tsx', 'src/features/public-menu/PublicMenuPage.tsx'],
  store: ['index.html', 'src/app/preload-public-catalog.ts', 'src/app/CommerceProviders.tsx', 'src/features/store/PublicStorePage.tsx'],
}

const results = Object.fromEntries(
  Object.entries(routes).map(([name, entries]) => [name, measure(entries, true)]),
)
const publicRoute = results.menu.js >= results.store.js ? results.menu : results.store
const publicRouteName = results.menu.js >= results.store.js ? 'menu' : 'store'
const largestInitial = Object.entries(results).reduce(
  (largest, current) => current[1].total > largest[1].total ? current : largest,
)

const checks = [
  { label: 'Landing JS', actual: results.landing.js, limit: 130 * 1024 },
  { label: `Comercio público JS (${publicRouteName})`, actual: publicRoute.js, limit: 180 * 1024 },
  { label: `Carga inicial total (${largestInitial[0]})`, actual: largestInitial[1].total, limit: 400 * 1024 },
]

console.log('Presupuestos de producción (transferencia gzip, grafo de imports estáticos):')
for (const [name, result] of Object.entries(results)) {
  console.log(
    `  ${name.padEnd(7)} JS ${kib(result.js).toFixed(1)} KiB · CSS ${kib(result.css).toFixed(1)} KiB · total ${kib(result.total).toFixed(1)} KiB`,
  )
}

let failed = false
for (const check of checks) {
  const passed = check.actual <= check.limit
  console.log(
    `${passed ? '✓' : '✗'} ${check.label}: ${kib(check.actual).toFixed(1)} / ${kib(check.limit).toFixed(0)} KiB`,
  )
  failed ||= !passed
}

if (failed) {
  console.error('El build excede uno o más presupuestos. Revisá el split de rutas o las dependencias agregadas.')
  process.exitCode = 1
}
