import assert from 'node:assert/strict'
import test from 'node:test'
import { localStatusEnvironment } from './local-ci-concurrency.mjs'

test('CI database discovery refuses remote hosts and connection-string overrides', () => {
  for (const url of ['postgres://u:p@remote.example:5432/postgres', 'postgres://u:p@127.0.0.1:5432/postgres?hostaddr=remote',
    'postgres://u:p@127.0.0.1:5432/production', 'https://127.0.0.1:5432/postgres', 'postgres://u:p@127.0.0.1/postgres']) {
    assert.throws(() => localStatusEnvironment({ DB_URL: url }, {}), /local Supabase/)
  }
  const env = localStatusEnvironment({ DB_URL: 'postgresql://postgres:synthetic@127.0.0.1:54322/postgres' }, {
    PGHOSTADDR: 'remote', PGSERVICE: 'production', PGOPTIONS: 'untrusted', SUPABASE_ACCESS_TOKEN: 'synthetic', PG_BIN: '/opt/pgsql/bin', PATH: '/bin',
  })
  assert.equal(env.PGHOST, '127.0.0.1'); assert.equal(env.PGPORT, '54322'); assert.equal(env.PG_BIN, '/opt/pgsql/bin')
  for (const key of ['PGHOSTADDR', 'PGSERVICE', 'PGOPTIONS', 'SUPABASE_ACCESS_TOKEN']) assert.equal(env[key], undefined)
})
