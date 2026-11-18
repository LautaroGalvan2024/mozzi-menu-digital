import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pgBinary, validateLocalDatabaseEnvironment } from './connection.mjs'

const valid = { PGHOST: '127.0.0.1', PGPORT: '55432', PGDATABASE: 'mozzi_test' }
test('local connections reject every libpq route override before connecting', () => {
  for (const key of ['PGHOSTADDR', 'PGSERVICE', 'PGSERVICEFILE', 'PGOPTIONS']) {
    assert.throws(() => validateLocalDatabaseEnvironment({ ...valid, [key]: 'untrusted' }), new RegExp(key))
  }
  for (const overrides of [{ PGHOST: 'db.example.test' }, { PGHOST: '127.0.0.1,remote' }, { PGDATABASE: 'postgres' },
    { PGDATABASE: 'mozzi_test host=remote' }, { PGDATABASE: 'mozzi_' }, { PGPORT: '0' }, { PGPORT: '65536' }, { PGPORT: '5432,5433' }]) {
    assert.throws(() => validateLocalDatabaseEnvironment({ ...valid, ...overrides }), /Isolated database required/)
  }
  assert.deepEqual(validateLocalDatabaseEnvironment(valid), valid)
})

test('inherited overrides are rejected even when a local file masks them', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'mozzi-env-test-'))
  try {
    const file = path.join(directory, 'database.env')
    writeFileSync(file, 'PGHOST=127.0.0.1\nPGPORT=55432\nPGDATABASE=mozzi_test\nPGHOSTADDR=\n')
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import { localDatabaseEnvironment } from ${JSON.stringify(new URL('./connection.mjs', import.meta.url).href)}; localDatabaseEnvironment();`], {
      encoding: 'utf8', windowsHide: true, env: { ...process.env, MOZZI_DATABASE_ENV_FILE: file, PGHOSTADDR: '192.0.2.1' },
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /refuses inherited PGHOSTADDR/)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('PostgreSQL executable selection supports Windows and Linux without a shell', () => {
  assert.equal(pgBinary({}, 'psql', 'linux'), 'psql')
  assert.equal(pgBinary({}, 'psql', 'win32'), 'psql.exe')
  assert.equal(pgBinary({ PG_BIN: '/opt/postgres/bin' }, 'pg_dump', 'linux'), path.join('/opt/postgres/bin', 'pg_dump'))
  assert.throws(() => pgBinary({}, 'psql;echo secret'), /Unsupported/)
})
