import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { validateIsolation } from './validate-isolation.mjs'

function fixture(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'mozzi-isolation-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const uri = 'postgresql://user:fixture@db:5432/postgres'
  const internalNetwork = { networks: { default: null } }
  const data = path.join(directory, 'volumes', 'db', 'data')
  const config = {
    name: 'mozzi-supabase',
    networks: { default: { name: 'mozzi-supabase_default' } },
    volumes: { 'db-config': { name: 'mozzi-supabase_db-config' } },
    services: {
      studio: { ...internalNetwork, environment: { POSTGRES_HOST: 'db' } },
      'api-gw': {
        ...internalNetwork,
        ports: [{ host_ip: '127.0.0.1', published: '18000', target: 8000, protocol: 'tcp' }],
      },
      auth: { ...internalNetwork, environment: { GOTRUE_DB_DATABASE_URL: uri } },
      rest: { ...internalNetwork, environment: { PGRST_DB_URI: uri } },
      realtime: {
        container_name: 'realtime-dev.mozzi-supabase-realtime',
        networks: { default: { aliases: ['realtime-dev.supabase-realtime'] } },
        environment: { DB_HOST: 'db', DB_PORT: '5432' },
      },
      storage: { ...internalNetwork, environment: { DATABASE_URL: uri } },
      imgproxy: { ...internalNetwork },
      meta: { ...internalNetwork, environment: { PG_META_DB_HOST: 'db', PG_META_DB_PORT: '5432' } },
      functions: { ...internalNetwork, environment: { SUPABASE_DB_URL: uri } },
      db: {
        ...internalNetwork,
        environment: { POSTGRES_HOST: '/var/run/postgresql', PGPORT: '5432' },
        volumes: [
          { type: 'bind', source: data, target: '/var/lib/postgresql/data' },
          { type: 'volume', source: 'db-config', target: '/etc/postgresql-custom' },
        ],
      },
      supavisor: { ...internalNetwork, environment: { POSTGRES_HOST: 'db', DATABASE_URL: uri } },
    },
  }
  return { config, directory, data }
}

test('allows the loopback gateway and a fresh, dedicated data directory', (t) => {
  const { config, directory } = fixture(t)
  assert.doesNotThrow(() => validateIsolation(config, directory))
})

test('rejects Compose configurations that retain a published database pooler', (t) => {
  const { config, directory } = fixture(t)
  config.services.supavisor.ports = [{ published: '5432', target: 5432, protocol: 'tcp' }]
  assert.throws(() => validateIsolation(config, directory), /único puerto publicado/)
})

test('rejects a gateway published on all addresses', (t) => {
  const { config, directory } = fixture(t)
  config.services['api-gw'].ports[0].host_ip = '0.0.0.0'
  assert.throws(() => validateIsolation(config, directory), /127\.0\.0\.1/)
})

test('rejects Docker volumes reused by name from outside the project', (t) => {
  const { config, directory } = fixture(t)
  config.volumes['db-config'].external = true
  assert.throws(() => validateIsolation(config, directory), /volúmenes con nombre/)
})

test('rejects a data directory redirected through a symlink or junction', (t) => {
  const { config, directory, data } = fixture(t)
  const anotherService = path.join(directory, 'existing-postgres')
  mkdirSync(anotherService)
  mkdirSync(path.dirname(data), { recursive: true })
  symlinkSync(anotherService, data, 'junction')
  assert.throws(() => validateIsolation(config, directory), /fuera del directorio dedicado/)
})

test('rejects a database URL that points at the host without echoing it', (t) => {
  const { config, directory } = fixture(t)
  config.services.functions.environment.SUPABASE_DB_URL = 'postgresql://user:fixture@host.docker.internal:5432/postgres'
  assert.throws(() => validateIsolation(config, directory), {
    message: 'Los servicios de Supabase deben usar la base interna db:5432.',
  })
})

test('allows private Auth templates and rejects a published template service', (t) => {
  const { config, directory } = fixture(t)
  config.services.auth.environment.GOTRUE_MAILER_TEMPLATES_INVITE = 'http://auth-templates:8080/invite-es.html'
  config.services.auth.environment.GOTRUE_MAILER_TEMPLATES_RECOVERY = 'http://auth-templates:8080/recovery-es.html'
  config.services['auth-templates'] = {
    networks: { default: null },
    read_only: true,
    volumes: [{
      type: 'bind', source: path.join(directory, 'volumes', 'auth-templates'),
      target: '/templates', read_only: true,
    }],
  }
  assert.doesNotThrow(() => validateIsolation(config, directory))
  config.services['auth-templates'].ports = [{ published: '8080', target: 8080, protocol: 'tcp' }]
  assert.throws(() => validateIsolation(config, directory), /único puerto publicado/)
})
