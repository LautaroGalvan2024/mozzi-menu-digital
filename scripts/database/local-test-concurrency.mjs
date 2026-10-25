// One entry point for real-session races. Uses only local, already migrated DBs.
// Credentials remain in the environment; no production or recovery data is seeded.
import { spawn } from 'node:child_process'
import path from 'node:path'
import { localDatabaseEnvironment } from './connection.mjs'

const env = localDatabaseEnvironment()
const databaseArgument = process.argv.find(value => value.startsWith('--database='))
if (databaseArgument) env.PGDATABASE = databaseArgument.slice('--database='.length)
if (!/^mozzi_[a-z0-9_]+$/.test(env.PGDATABASE) || env.PGDATABASE.startsWith('mozzi_restore_')) throw new Error('Synthetic mozzi_ database required; recovery databases are forbidden')
if (env.PGSERVICE || env.PGSERVICEFILE || env.PGHOSTADDR && !['127.0.0.1', '::1'].includes(env.PGHOSTADDR)) throw new Error('libpq service and non-loopback address overrides are forbidden')
env.S01_PSQL = path.join(env.PG_BIN, 'psql.exe')
env.MOZZI_ISOLATED_TEST_DB = '1'

const suites = [
  ['memberships', 'scripts/test-membership-concurrency.mjs'],
  ['catalogue SKU', 'scripts/database/local-test-sku-concurrency.mjs'],
  ['inventory', 'scripts/test-inventory-concurrency.mjs'],
  ['order requests', 'scripts/database/local-test-order-concurrency.mjs'],
]
for (const [name, script] of suites) {
  console.log(`Concurrency: ${name} (${env.PGDATABASE})`)
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, `--database=${env.PGDATABASE}`], {
      env, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'],
    })
    child.on('error', error => reject(new Error(`Cannot launch ${name}: ${error.code ?? 'unknown'}`)))
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`${name} failed (exit ${code})`)))
  })
}
console.log(JSON.stringify({ database: env.PGDATABASE, concurrencySuites: suites.length, passed: true, fixtures: 'synthetic; retained with audit history' }))
