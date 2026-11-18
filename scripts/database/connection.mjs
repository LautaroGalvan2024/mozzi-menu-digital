import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

export function run(binary, args, options = {}) {
  const result = spawnSync(binary, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, ...options })
  if (result.error || result.status !== 0) {
    // Never include environment variables or CLI dry-run output in diagnostics.
    throw new Error(`${path.basename(binary)} failed (${result.status ?? 'spawn'}): ${result.stderr?.slice(-4000) ?? result.error?.code ?? ''}`)
  }
  return result.stdout
}

export function linkedDatabaseEnvironment() {
  const script = run(process.execPath, ['node_modules/supabase/dist/supabase.js', 'db', 'dump', '--linked', '--dry-run'])
  const env = { ...process.env, PGSSLMODE: 'require', PGCONNECT_TIMEOUT: '20' }
  // The linked CLI result is the only source of connection routing. libpq's
  // hostaddr/service overrides can otherwise silently bypass its host.
  for (const name of ['PGHOSTADDR', 'PGSERVICE', 'PGSERVICEFILE', 'PGOPTIONS']) delete env[name]
  for (const name of ['PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE']) {
    const match = script.match(new RegExp(`^export ${name}="([^"\\r\\n]*)"\\r?$`, 'm'))
    if (!match || /[\\`$]/.test(match[1])) throw new Error(`Unsupported CLI credential encoding for ${name}; no command executed`)
    env[name] = match[1]
  }
  return env
}

export function readEnvironment(file) {
  return Object.fromEntries(readFileSync(file, 'utf8').split(/\r?\n/).filter(line => /^[A-Z_][A-Z_0-9]*=/.test(line)).map(line => {
    const position = line.indexOf('=')
    return [line.slice(0, position), line.slice(position + 1).replace(/^(["'])(.*)\1$/, '$2')]
  }))
}

export function validateLocalDatabaseEnvironment(env) {
  for (const name of ['PGHOSTADDR', 'PGSERVICE', 'PGSERVICEFILE', 'PGOPTIONS']) {
    if (env[name]) throw new Error(`Local database refuses inherited ${name}; configure the isolated connection explicitly`)
  }
  if (!['127.0.0.1', 'localhost', '::1'].includes(env.PGHOST)
    || !/^mozzi_[a-z0-9_]+$/.test(env.PGDATABASE ?? '')
    || env.PGDATABASE.length > 63
    || !/^\d{1,5}$/.test(String(env.PGPORT ?? ''))
    || Number(env.PGPORT) < 1 || Number(env.PGPORT) > 65535) {
    throw new Error('Isolated database required: loopback host, explicit port and strict mozzi_ database name')
  }
  return { ...env }
}

export function localDatabaseEnvironment(file = process.env.MOZZI_DATABASE_ENV_FILE ?? '.env.database.local') {
  const configured = readEnvironment(file)
  // Reject a dangerous inherited value even if the file happens to mask it.
  for (const name of ['PGHOSTADDR', 'PGSERVICE', 'PGSERVICEFILE', 'PGOPTIONS']) {
    if (process.env[name]) throw new Error(`Local database refuses inherited ${name}`)
  }
  return validateLocalDatabaseEnvironment({ ...process.env, ...configured })
}

export function pgBinary(env, name, platform = process.platform) {
  if (!/^(psql|pg_dump|pg_restore|pg_config)$/.test(name)) throw new Error('Unsupported PostgreSQL executable')
  const executable = `${name}${platform === 'win32' ? '.exe' : ''}`
  return env.PG_BIN ? path.join(env.PG_BIN, executable) : executable
}
