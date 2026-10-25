// Run SQL suites against the dedicated loopback test DB. No secrets or fixture contents logged.
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { localDatabaseEnvironment, run } from './connection.mjs'

const env = localDatabaseEnvironment()
const databaseArgument = process.argv.find(value => value.startsWith('--database='))
if (databaseArgument) {
  env.PGDATABASE = databaseArgument.slice('--database='.length)
  if (!/^mozzi_[a-z0-9_]+$/.test(env.PGDATABASE)) throw new Error('Invalid isolated database name')
}
const baseline = process.argv.slice(2).find(value => value.startsWith('--baseline='))?.slice('--baseline='.length)
if (baseline && !/^[0-9a-f]{40}$/.test(baseline)) throw new Error('Baseline must be a full local Git SHA')
const requested = process.argv.slice(2).filter(value => !value.startsWith('--baseline=') && !value.startsWith('--database='))
const suites = requested.length ? requested : readdirSync('supabase/tests')
  .filter(file => file.endsWith('.sql') && (!baseline || Number(file.slice(0, 3)) <= 10)).sort()
let assertions = 0
let failed = 0
for (const suite of suites) {
  if (!/^\d{3}_[a-z0-9_]+\.sql$/.test(suite)) throw new Error('Invalid SQL suite name')
  try {
    const output = run(path.join(env.PG_BIN, 'psql.exe'), ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'], {
      env, input: baseline ? run('git', ['show', `${baseline}:supabase/tests/${suite}`]) : readFileSync(path.join('supabase/tests', suite), 'utf8'),
    })
    const lines = output.split(/\r?\n/)
    const count = lines.filter(line => /^(?:not )?ok \d+\b/.test(line)).length
    const errors = lines.filter(line => /^not ok \d+\b|^# (?:Failed|Looks like|You planned)|^Bail out!/i.test(line))
    assertions += count
    if (errors.length || count === 0) {
      failed += 1
      console.error(`${suite}: FAIL (${count} assertions)\n${lines.filter(line => /^(?:not ok|#|Bail out!)/.test(line)).join('\n')}`)
    } else console.log(`${suite}: PASS (${count} assertions)`)
  } catch (error) {
    failed += 1
    console.error(`${suite}: ERROR ${error.message}`)
  }
}
console.log(JSON.stringify({ suites: suites.length, assertions, failed }))
if (failed) process.exitCode = 1
