// Dedicated disposable cluster. Never operates on an existing cluster.
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync, appendFileSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { run } from './connection.mjs'

const root = path.join(process.env.LOCALAPPDATA, 'mozzi-tools', 'mayorista-db')
const bin = process.env.PG_BIN
if (!bin) throw new Error('Set PG_BIN to an installed PostgreSQL binary directory')
const data = path.join(root, 'data')
if (existsSync(data) || existsSync('.env.database.local')) throw new Error('Existing cluster/config: inspect before proceeding')
mkdirSync(root, { recursive: true, mode: 0o700 })
if (process.platform === 'win32') {
  const identity = run('whoami.exe', []).trim()
  run('icacls.exe', [root, '/inheritance:r', '/grant:r', `${identity}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'])
}
const password = randomBytes(32).toString('hex')
const passwordFile = path.join(root, 'init-password')
writeFileSync(passwordFile, password, { mode: 0o600 })
try {
  run(path.join(bin, 'initdb.exe'), ['-D', data, '-U', 'postgres', '--pwfile', passwordFile, '--auth=scram-sha-256', '--encoding=UTF8', '--locale=C'])
} finally {
  unlinkSync(passwordFile)
}
appendFileSync(path.join(data, 'postgresql.conf'), "\nlisten_addresses = '127.0.0.1'\nport = 55432\nwal_level = logical\n")
const env = { PGHOST: '127.0.0.1', PGPORT: '55432', PGUSER: 'postgres', PGPASSWORD: password, PGDATABASE: 'mozzi_test', PGSSLMODE: 'disable', PG_BIN: bin, PGDATA: data }
writeFileSync('.env.database.local', Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n'), { mode: 0o600 })
if (process.platform === 'win32') {
  const identity = run('whoami.exe', []).trim()
  run('icacls.exe', ['.env.database.local', '/inheritance:r', '/grant:r', `${identity}:F`, '*S-1-5-18:F'])
}
console.log(JSON.stringify({ initialized: true, data, config: '.env.database.local' }))
