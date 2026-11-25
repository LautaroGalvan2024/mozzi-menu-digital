import assert from 'node:assert/strict'
import test from 'node:test'
import { localStatusEnvironment, matchesLocalContainer, restoreFailureSummary } from './local-ci-concurrency.mjs'

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

test('Docker identity requires this container address and its exact locally published PostgreSQL port', () => {
  const local = { PGHOST: '127.0.0.1', PGPORT: '54322' }
  const postgres = { host: '172.18.0.3', port: 5432 }
  const network = {
    Ports: { '5432/tcp': [{ HostIp: '0.0.0.0', HostPort: '54322' }] },
    Networks: { supabase: { IPAddress: '172.18.0.3', GlobalIPv6Address: '' } },
  }
  assert.equal(matchesLocalContainer(local, postgres, network), true)
  assert.equal(matchesLocalContainer({ ...local, PGHOST: 'db.example' }, postgres, network), false)
  assert.equal(matchesLocalContainer({ ...local, PGPORT: '55432' }, postgres, network), false)
  assert.equal(matchesLocalContainer(local, { ...postgres, host: '172.18.0.4' }, network), false)
  assert.equal(matchesLocalContainer(local, { ...postgres, port: 7432 }, network), false)
  const remoteBinding = { ...network, Ports: { '5432/tcp': [{ HostIp: '192.0.2.5', HostPort: '54322' }] } }
  assert.equal(matchesLocalContainer(local, postgres, remoteBinding), false)
})

test('restore diagnostics retain the failed object class without printing SQL or rows', () => {
  const failure = 'pg_restore: from TOC entry 4; 13 45 TABLE auth sample postgres\n'
    + 'pg_restore: error: could not execute query: ERROR: schema "missing" does not exist\n'
    + "Command was: INSERT INTO missing.table VALUES ('sensitive example');"
  assert.equal(restoreFailureSummary(failure), 'TOC 4, schema "missing" does not exist')
  assert.equal(restoreFailureSummary('arbitrary fixture contents'), 'restore process failed')
})
