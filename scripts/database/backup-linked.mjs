// Explicit invocation only. The source database is always read-only.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { linkedDatabaseEnvironment, pgBinary, readEnvironment, run } from './connection.mjs'
import { validateLinkedConnection } from './configure-commerce-maintenance.mjs'
import { assertStorageUnchanged, atomicJson, checksum, runPrivate, SnapshotSession, validateCheckpoint, validateStorageResponse } from './backup-core.mjs'

const COUNTS_SQL = `select json_build_object('server_version',current_setting('server_version'),
  'migrations',(select count(*) from supabase_migrations.schema_migrations),
  'restaurants',(select count(*) from public.restaurants),'products',(select count(*) from public.products),
  'orders',(select count(*) from public.orders),'auth_users',(select count(*) from auth.users),
  'storage_objects',(select count(*) from storage.objects));`
const INVENTORY_SELECT = `select coalesce(json_agg(json_build_object('id',o.id,'bucket',o.bucket_id,
  'name',o.name,'metadata',o.metadata,'version',to_jsonb(o)->>'version','updatedAt',o.updated_at) order by o.id), '[]'::json)
  from storage.objects o`

function backupFile(destination, relative) {
  const file = path.resolve(destination, relative)
  if (!file.startsWith(destination + path.sep)) throw new Error('Backup path escapes the restricted directory')
  return file
}

// Exported for isolated integration checks; only the CLI below reads linked credentials.
export async function createBackup(options) {
  const destination = path.resolve(options.destination)
  const lock = path.join(destination, 'backup.lock')
  // A single writer owns both the snapshot checkpoint and its archive filenames.
  // A leftover lock after a crash requires operator review, never automatic theft.
  writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 })
  try { return await createBackupUnlocked({ ...options, destination }) }
  finally { unlinkSync(lock) }
}

async function createBackupUnlocked({ env, destination, source, storage, reuse = false, fetchImplementation = fetch }) {
  destination = path.resolve(destination)
  const checkpointFile = path.join(destination, 'snapshot-checkpoint.json')
  const manifestFile = path.join(destination, 'manifest.json')
  let state
  if (reuse) {
    state = JSON.parse(readFileSync(checkpointFile, 'utf8'))
    validateCheckpoint(state, source, (relative, expected) => {
      const file = backupFile(destination, relative)
      return existsSync(file) && checksum(file) === expected
    })
  } else {
    if (['database.dump', 'application.dump', 'managed-schema.sql', 'snapshot-checkpoint.json', 'manifest.json']
      .some(file => existsSync(path.join(destination, file)))) {
      throw new Error('Backup destination already contains an archive; use a new directory or explicitly resume its checkpoint')
    }
    const session = new SnapshotSession(pgBinary(env, 'psql'), env)
    try {
      const snapshotCapturedAt = new Date().toISOString()
      const snapshot = await session.begin()
      const counts = JSON.parse(await session.query(COUNTS_SQL))
      const objects = JSON.parse(await session.query(`${INVENTORY_SELECT};`))
      const files = []
      for (const [file, options] of [
        ['database.dump', ['--format=custom']],
        ['application.dump', ['--format=custom', '--schema=public', '--schema=private', '--schema=supabase_migrations']],
        ['managed-schema.sql', ['--schema-only', '--schema=auth', '--schema=storage', '--no-owner', '--no-acl']],
      ]) {
        const target = path.join(destination, file)
        const partial = `${target}.partial`
        await runPrivate(pgBinary(env, 'pg_dump'), ['--role=postgres', `--snapshot=${snapshot}`,
          '--lock-wait-timeout=5s', ...options, '--file', partial, '--no-password'], { env, timeout: 20 * 60_000 })
        renameSync(partial, target)
        files.push({ file, bytes: statSync(target).size, sha256: checksum(target) })
      }
      state = { formatVersion: 2, source, snapshotCapturedAt, snapshot,
        counts, objects, files, assets: [] }
      atomicJson(checkpointFile, state)
    } finally { await session.close() }
  }

  if (state.objects.length && !storage?.url) throw new Error('Snapshot saved; Storage URL is required to complete this backup')
  const currentObjects = async objects => {
    const ids = objects.map(object => {
      if (!/^[0-9a-f-]{36}$/i.test(object.id)) throw new Error('Invalid Storage object identifier')
      return `'${object.id}'::uuid`
    })
    const output = await runPrivate(pgBinary(env, 'psql'), ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '--no-password'], {
      env, input: `begin read only; set local role postgres; set local statement_timeout='30s'; ${INVENTORY_SELECT} where o.id in (${ids.join(',')}); rollback;`,
    })
    return new Map(JSON.parse(output.trim()).map(object => [object.id, object]))
  }
  const completed = new Set(state.assets.map(asset => asset.id))
  const pending = state.objects.filter(object => !completed.has(object.id))
  mkdirSync(path.join(destination, 'storage'), { recursive: true, mode: 0o700 })
  // Validate each bounded batch before and after downloading; only then trust
  // its bytes. A retry never relabels old dumps with new counts or object versions.
  for (let offset = 0; offset < pending.length; offset += 25) {
    const batch = pending.slice(offset, offset + 25)
    const before = await currentObjects(batch)
    batch.forEach(object => assertStorageUnchanged(object, before.get(object.id)))
    const copied = []
    for (const object of batch) {
      const root = new URL(storage.url)
      if (root.protocol !== 'https:' && !(root.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(root.hostname))) {
        throw new Error('Storage backup requires HTTPS or an explicit loopback test endpoint')
      }
      if (root.username || root.password || root.search || root.hash || root.pathname !== '/') throw new Error('Invalid Storage project URL')
      const segments = object.name.split('/')
      if (segments.some(segment => segment === '.' || segment === '..' || segment === '')) throw new Error('Unsupported Storage object path')
      const objectPath = segments.map(encodeURIComponent).join('/')
      const url = new URL(`/storage/v1/object/${storage.key ? 'authenticated' : 'public'}/${encodeURIComponent(object.bucket)}/${objectPath}`, root)
      url.searchParams.set('backup_version', object.version ?? object.id)
      let bytes
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const response = await fetchImplementation(url, { headers: {
            'Cache-Control': 'no-cache',
            ...(storage.key ? { Authorization: `Bearer ${storage.key}`, apikey: storage.key } : {}),
          }, signal: AbortSignal.timeout(30_000), redirect: 'error' })
          if (!response.ok) { await response.body?.cancel(); throw new Error(`Storage backup failed: HTTP ${response.status}`) }
          bytes = Buffer.from(await response.arrayBuffer())
          validateStorageResponse(object, response, bytes)
          break
        } catch (error) { if (attempt === 2) throw error }
      }
      const file = `storage/${object.id}.bin`
      const target = backupFile(destination, file)
      writeFileSync(`${target}.partial`, bytes, { mode: 0o600 })
      renameSync(`${target}.partial`, target)
      copied.push({ ...object, file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
    }
    const after = await currentObjects(batch)
    batch.forEach(object => assertStorageUnchanged(object, after.get(object.id)))
    state.assets.push(...copied)
    atomicJson(checkpointFile, state)
  }
  const manifest = { formatVersion: 2, complete: true, createdAt: new Date().toISOString(),
    snapshotCapturedAt: state.snapshotCapturedAt, source: state.source,
    counts: state.counts, files: state.files, assets: state.assets,
    recovery: 'Restore into an isolated target first. Managed schemas require platform roles/extensions. Storage bytes were checked against snapshot identity before and after copying. No full --clean restore against the linked project.' }
  atomicJson(manifestFile, manifest)
  return { destination, counts: state.counts, files: state.files, storageFiles: state.assets.length, complete: true }
}

async function main() {
  try {
    const bin = process.env.PG_BIN
    if (!bin) throw new Error('PostgreSQL binaries required')
    const destination = path.resolve(process.env.BACKUP_DIRECTORY ?? path.join(os.homedir(), '.codex', 'backups', 'Mozzi-Menu', new Date().toISOString().replace(/[:.]/g, '-')))
    const repository = process.cwd()
    if (destination.toLowerCase() === repository.toLowerCase() || destination.toLowerCase().startsWith((repository + path.sep).toLowerCase())) throw new Error('Backups must stay outside the repository')
    mkdirSync(destination, { recursive: true, mode: 0o700 })
    if (process.platform === 'win32') {
      const identity = run('whoami.exe', []).trim()
      run('icacls.exe', [destination, '/inheritance:r', '/grant:r', `${identity}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'])
    }
    const source = readFileSync('supabase/.temp/project-ref', 'utf8').trim()
    if (!/^[a-z]{20}$/.test(source)) throw new Error('Invalid linked project')
    const secrets = readEnvironment('.env.edge.production')
    const frontend = readEnvironment('.env.local')
    const url = secrets.SUPABASE_URL ?? secrets.PROJECT_URL ?? frontend.VITE_SUPABASE_URL
    if (new URL(url).origin !== `https://${source}.supabase.co`) throw new Error('Storage project must match the linked database')
    const env = { ...linkedDatabaseEnvironment(), PG_BIN: bin }
    validateLinkedConnection(env, source)
    const key = secrets.SUPABASE_SECRET_KEY ?? secrets.SUPABASE_SERVICE_ROLE_KEY ?? secrets.SERVICE_ROLE_KEY
    console.log(JSON.stringify(await createBackup({ env, destination, source, storage: { url, key }, reuse: process.env.BACKUP_REUSE_DUMPS === '1' }), null, 2))
  } catch {
    console.error('Backup incomplete. No new manifest was published unless all checks finished. Preserve the restricted checkpoint and review configuration; raw diagnostics withheld.')
    process.exitCode = 1
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main()
