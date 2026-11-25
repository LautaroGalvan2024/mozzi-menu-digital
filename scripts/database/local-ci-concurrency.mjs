// Discover only `supabase status` (local Docker stack), clone its rebuilt schema
// into a NEW mozzi_ci_* database, then run the original real-session harnesses.
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createReadStream, existsSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { pathToFileURL } from 'node:url'
import { pgBinary, validateLocalDatabaseEnvironment } from './connection.mjs'
import { runPrivate } from './backup-core.mjs'

export function localStatusEnvironment(status, inherited = process.env) {
  const database = new URL(status.DB_URL)
  if (!['postgres:', 'postgresql:'].includes(database.protocol)
    || !['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname)
    || database.pathname !== '/postgres' || database.search || database.hash || !database.port) {
    throw new Error('Only the local Supabase postgres endpoint is supported')
  }
  const env = { ...inherited }
  for (const name of Object.keys(env)) if (/^(PG|SUPABASE_)/.test(name)) delete env[name]
  Object.assign(env, { PGHOST: database.hostname.replace(/^\[|\]$/g, ''), PGPORT: database.port,
    PGUSER: decodeURIComponent(database.username), PGPASSWORD: decodeURIComponent(database.password),
    PGDATABASE: 'postgres', PGSSLMODE: 'disable', PGCONNECT_TIMEOUT: '5',
    ...(inherited.PG_BIN ? { PG_BIN: inherited.PG_BIN } : {}),
  })
  if (Object.values(env).some(value => /[\r\n]/.test(value ?? ''))) {
    // Only database fields are written to the environment file below. Other CI
    // variables may contain newlines, so validate just those fields strictly.
    for (const [name, value] of Object.entries(env)) if (name.startsWith('PG') && /[\r\n]/.test(value ?? '')) throw new Error('Invalid local database configuration')
  }
  return env
}

export function matchesLocalContainer(sourceEnv, identity, network) {
  const bindings = network?.Ports?.[`${identity.port}/tcp`] ?? []
  const loopbackBindings = {
    '127.0.0.1': ['127.0.0.1', '0.0.0.0'],
    '::1': ['::1', '::'],
    localhost: ['127.0.0.1', '0.0.0.0', '::1', '::'],
  }
  const hosts = loopbackBindings[sourceEnv.PGHOST] ?? []
  return Boolean(identity.host && bindings.some(binding =>
    binding.HostPort === sourceEnv.PGPORT && hosts.includes(binding.HostIp))
    && Object.values(network.Networks ?? {}).some(endpoint =>
      identity.host === endpoint.IPAddress || identity.host === endpoint.GlobalIPv6Address))
}

// Do not print restore SQL or row contents. Report only a known failure class
// and identifiers from PostgreSQL's diagnostic, inside the disposable clone.
export function restoreFailureSummary(stderr) {
  const toc = /from TOC entry (\d+);/.exec(stderr)
  const detail = /(?:relation|schema|table|type|extension|role|collation|constraint) "[a-z_][a-z_0-9.]{0,80}" (?:already exists|does not exist)/i.exec(stderr)
    ?? /permission denied (?:for|to) (?:schema|relation|database|table|function|change default privileges)(?: [a-z_][a-z_0-9.]*)?/i.exec(stderr)
    ?? /must be (?:owner|member|superuser)|must be able to SET ROLE/i.exec(stderr)
    ?? /password authentication failed|peer authentication failed|no password supplied|could not connect to server/i.exec(stderr)
  return [toc && `TOC ${toc[1]}`, detail?.[0]].filter(Boolean).join(', ') || 'restore process failed'
}

async function restoreContainerArchive(container, env, target, archive, list, setStage) {
  const command = ['--context', 'default', 'exec', '-i', '--user', 'postgres', container]
  const containerList = `/tmp/${target}-restore.list`
  await runPrivate('docker', [...command, 'sh', '-c', 'umask 077; set -C; cat > "$1"', 'sh', containerList], { env, input: list })
  try {
    // This is the verified local container. Its Unix-socket administrator can
    // recreate objects owned by Auth/Storage roles. Preserve their real owners.
    const child = spawn('docker', [...command, 'pg_restore', '--host=/var/run/postgresql', '--username=supabase_admin',
      '--no-password', '--exit-on-error', '--single-transaction', '--dbname', target, '--use-list', containerList],
    { env, stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true, timeout: 120000 })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8192) })
    const completed = new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    const [status, input] = await Promise.allSettled([completed, pipeline(createReadStream(archive), child.stdin)])
    if (status.status !== 'fulfilled' || status.value !== 0 || input.status === 'rejected') {
      setStage(`disposable database schema restoration (${restoreFailureSummary(stderr)})`)
      throw new Error('Disposable clone restore failed')
    }
  } finally {
    await runPrivate('docker', [...command, 'rm', '-f', containerList], { env })
  }
}

export async function cloneLocalDatabase(sourceEnv, target, directory, setStage = () => {}) {
  if (!/^mozzi_ci_[a-f0-9]+$/.test(target)) throw new Error('A new synthetic CI database name is required')
  validateLocalDatabaseEnvironment({ ...sourceEnv, PGDATABASE: target })
  if (!/^(postgres|mozzi_[a-z0-9_]+)$/.test(sourceEnv.PGDATABASE)) throw new Error('Invalid local source database')
  const query = input => runPrivate(pgBinary(sourceEnv, 'psql'), ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '--no-password'], { env: sourceEnv, input })
  const identity = JSON.parse((await query("select json_build_object('host',inet_server_addr(),'port',inet_server_port(),'database',current_database(),'version',current_setting('server_version_num'));" )).trim())
  if (identity.database !== sourceEnv.PGDATABASE || Number(identity.version) < 170000 || Number(identity.version) >= 180000) throw new Error('Local PostgreSQL 17 identity mismatch')
  let container
  if (!['127.0.0.1', '::1'].includes(identity.host) || identity.port !== Number(sourceEnv.PGPORT)) {
    // Inside Docker, PostgreSQL reports its bridge address and internal port.
    // Only accept the precise mapping published by this project's local DB container.
    setStage('local Supabase container endpoint verification')
    const project = /^project_id\s*=\s*"([a-zA-Z0-9_-]+)"\s*$/m.exec(readFileSync('supabase/config.toml', 'utf8'))?.[1]
    if (!project) throw new Error('Missing local Supabase project ID')
    container = `supabase_db_${project}`
    const details = await runPrivate('docker', ['--context', 'default', 'inspect', '--type=container',
      '--format', '{{json .NetworkSettings}}', container], { env: sourceEnv })
    if (!matchesLocalContainer(sourceEnv, identity, JSON.parse(details))) throw new Error('Local Supabase container mismatch')
  }
  setStage('local extension inventory and schema dump')
  const extensions = JSON.parse((await query("select coalesce(json_agg(json_build_object('name',e.extname,'schema',n.nspname)),'[]') from pg_extension e join pg_namespace n on n.oid=e.extnamespace where n.nspname in ('public','extensions');")).trim())
  const archive = path.join(directory, 'local-clone.dump')
  await runPrivate(pgBinary(sourceEnv, 'pg_dump'), ['--format=custom', '--no-owner', '--schema=public', '--schema=private',
    '--schema=auth', '--schema=storage', '--schema=extensions', '--schema=supabase_migrations', '--file', archive, '--no-password'], { env: sourceEnv })
  setStage('disposable database creation')
  await query(`create database "${target}";`)
  const env = validateLocalDatabaseEnvironment({ ...sourceEnv, PGDATABASE: target })
  try {
    // Schema-scoped pg_dump does not include CREATE EXTENSION. Recreate the
    // same locally installed extensions first, then preserve schema ACL entries.
    setStage('disposable database extensions')
    const quote = value => `"${String(value).replaceAll('"', '""')}"`
    await runPrivate(pgBinary(env, 'psql'), ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '--no-password'], { env,
      input: `create schema extensions; ${extensions.map(extension => `create extension if not exists ${quote(extension.name)} with schema ${quote(extension.schema)};`).join('\n')}` })
    setStage('disposable database schema restoration')
    const list = await runPrivate(pgBinary(env, 'pg_restore'), ['--list', archive], { env })
    const entries = list.split(/\r?\n/).filter(line => !/\sSCHEMA - (public|extensions) /.test(line)).join('\n')
    if (container) {
      await restoreContainerArchive(container, env, target, archive, entries, setStage)
    } else {
      const listFile = path.join(directory, 'local-clone.list')
      writeFileSync(listFile, entries, { mode: 0o600 })
      await runPrivate(pgBinary(env, 'pg_restore'), ['--dbname', target, '--exit-on-error', '--single-transaction', '--no-owner', '--use-list', listFile, archive], { env })
    }
  } catch (error) {
    await query(`drop database "${target}" with (force);`)
    throw error
  }
  return env
}

async function main() {
  let directory; let source; let target; let created = false
  let stage = 'local Supabase discovery'
  try {
    if (process.argv.length !== 2) throw new Error('This runner accepts no remote connection arguments')
    const cli = existsSync('node_modules/supabase/dist/supabase.js')
      ? [process.execPath, ['node_modules/supabase/dist/supabase.js']] : ['supabase', []]
    const cliEnv = { ...process.env }
    for (const name of Object.keys(cliEnv)) if (/^(PG|SUPABASE_)/.test(name)) delete cliEnv[name]
    const result = spawnSync(cli[0], [...cli[1], 'status', '-o', 'json'], { env: cliEnv, encoding: 'utf8', windowsHide: true, timeout: 30_000 })
    if (result.status !== 0 || result.error) throw new Error('Start the local Supabase stack before running concurrency checks')
    source = localStatusEnvironment(JSON.parse(result.stdout))
    directory = mkdtempSync(path.join(tmpdir(), 'mozzi-ci-concurrency-'))
    target = `mozzi_ci_${randomBytes(8).toString('hex')}`
    stage = 'isolated schema clone'
    const env = await cloneLocalDatabase(source, target, directory, step => { stage = step })
    created = true
    const config = path.join(directory, 'database.env')
    writeFileSync(config, Object.entries(env).filter(([name]) => /^PG/.test(name)).map(([name, value]) => `${name}=${value}`).join('\n'), { mode: 0o600 })
    env.MOZZI_DATABASE_ENV_FILE = config
    for (const script of ['local-test-concurrency.mjs', 'local-test-commerce-concurrency.mjs', 'local-test-catalog-stock-concurrency.mjs', 'local-test-asset-hours-concurrency.mjs', 'local-test-invitation-delivery-concurrency.mjs', 'local-test-payment-maintenance-concurrency.mjs', 'local-test-store-offer-order-concurrency.mjs', 'local-test-backup-consistency.mjs']) {
      stage = script
      await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [`scripts/database/${script}`, `--database=${target}`], { env, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'] })
        const timer = setTimeout(() => { child.kill(); reject(new Error('Local concurrency suite timed out')) }, 180_000)
        child.on('error', () => { clearTimeout(timer); reject(new Error('Cannot start local concurrency suite')) })
        child.on('close', code => {
          clearTimeout(timer)
          if (code === 0) resolve()
          else reject(new Error('Local concurrency suite failed'))
        })
      })
    }
    console.log(JSON.stringify({ localConcurrencyPassed: true, suites: 10, backupConsistencyPassed: true, sourceUntouched: true }))
  } catch {
    console.error(`Local concurrency checks failed during ${stage}; credentials and raw connection diagnostics withheld.`)
    process.exitCode = 1
  } finally {
    if (created) {
      try {
        await runPrivate(pgBinary(source, 'psql'), ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '--no-password'], { env: source, input: `drop database "${target}" with (force);` })
      } catch { console.error('Synthetic CI database cleanup failed; stop the local stack after inspection.'); process.exitCode = 1 }
    }
    if (directory) {
      for (const file of ['local-clone.dump', 'local-clone.list', 'database.env']) { const absolute = path.join(directory, file); if (existsSync(absolute)) unlinkSync(absolute) }
      rmdirSync(directory)
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main()
