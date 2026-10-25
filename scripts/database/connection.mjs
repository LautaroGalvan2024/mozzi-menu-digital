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

export function localDatabaseEnvironment(file = '.env.database.local') {
  const env = { ...process.env, ...readEnvironment(file) }
  if (!['127.0.0.1', 'localhost', '::1'].includes(env.PGHOST) || !env.PGDATABASE?.startsWith('mozzi_')) {
    throw new Error('Isolated database required: loopback host and mozzi_ database')
  }
  return env
}
