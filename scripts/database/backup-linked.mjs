// Explicit invocation only. Reads the linked project; never changes the remote database.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { linkedDatabaseEnvironment, readEnvironment, run } from './connection.mjs'

const bin = process.env.PG_BIN
if (!bin) throw new Error('Set PG_BIN to PostgreSQL 17+ binaries')
const destination = path.resolve(process.env.BACKUP_DIRECTORY ?? path.join(os.homedir(), '.codex', 'backups', 'Mozzi-Menu', new Date().toISOString().replace(/[:.]/g, '-')))
const repository = process.cwd()
if (destination === repository || destination.startsWith(repository + path.sep)) throw new Error('Backups must stay outside the repository')
mkdirSync(destination, { recursive: true, mode: 0o700 })
if (process.platform === 'win32') {
  const identity = run('whoami.exe', []).trim()
  run('icacls.exe', [destination, '/inheritance:r', '/grant:r', `${identity}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'])
}
const env = linkedDatabaseEnvironment()
const query = sql => run(path.join(bin, 'psql.exe'), ['-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', 'set role postgres;', '-c', sql], { env }).trim().replace(/^SET\r?\n/, '')
const counts = JSON.parse(query(`select json_build_object('server_version',current_setting('server_version'),'migrations',(select count(*) from supabase_migrations.schema_migrations),'restaurants',(select count(*) from public.restaurants),'products',(select count(*) from public.products),'orders',(select count(*) from public.orders),'auth_users',(select count(*) from auth.users),'storage_objects',(select count(*) from storage.objects))`))
const dump = path.join(destination, 'database.dump')
const applicationDump = path.join(destination, 'application.dump')
const substrate = path.join(destination, 'managed-schema.sql')
if (process.env.BACKUP_REUSE_DUMPS === '1') {
  for (const file of [dump, applicationDump]) run(path.join(bin, 'pg_restore.exe'), ['--list', file])
  if (statSync(substrate).size === 0) throw new Error('Empty schema backup')
} else {
  run(path.join(bin, 'pg_dump.exe'), ['--role=postgres', '--format=custom', '--file', dump, '--no-password'], { env })
  run(path.join(bin, 'pg_dump.exe'), ['--role=postgres', '--format=custom', '--schema=public', '--schema=private', '--schema=supabase_migrations', '--file', applicationDump, '--no-password'], { env })
  run(path.join(bin, 'pg_dump.exe'), ['--role=postgres', '--schema-only', '--schema=auth', '--schema=storage', '--no-owner', '--no-acl', '--file', substrate, '--no-password'], { env })
}
const objects = JSON.parse(query(`select coalesce(json_agg(json_build_object('bucket',bucket_id,'name',name,'metadata',metadata)), '[]'::json) from storage.objects`))
const secrets = readEnvironment('.env.edge.production')
const frontend = readEnvironment('.env.local')
const url = secrets.SUPABASE_URL ?? secrets.PROJECT_URL ?? frontend.VITE_SUPABASE_URL
const key = secrets.SUPABASE_SERVICE_ROLE_KEY ?? secrets.SERVICE_ROLE_KEY
if (objects.length && !url) throw new Error('Database saved; Storage backup requires the configured project URL')
const assets = []
mkdirSync(path.join(destination, 'storage'), { recursive: true, mode: 0o700 })
for (const [index, object] of objects.entries()) {
  const response = await fetch(`${url}/storage/v1/object/${key ? 'authenticated' : 'public'}/${encodeURIComponent(object.bucket)}/${object.name.split('/').map(encodeURIComponent).join('/')}`, { headers: key ? { Authorization: `Bearer ${key}`, apikey: key } : {}, signal: AbortSignal.timeout(30000) })
  if (!response.ok) throw new Error(`Storage backup failed for object ${index + 1}: HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  const file = `storage/${String(index + 1).padStart(5, '0')}.bin`
  writeFileSync(path.join(destination, file), bytes, { mode: 0o600 })
  assets.push({ ...object, file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
}
const files = [dump, applicationDump, substrate].map(file => ({ file: path.basename(file), bytes: statSync(file).size, sha256: createHash('sha256').update(readFileSync(file)).digest('hex') }))
writeFileSync(path.join(destination, 'manifest.json'), JSON.stringify({ createdAt: new Date().toISOString(), counts, files, assets, recovery: 'Restore into an isolated target first. Managed Supabase schemas require their platform roles/extensions. Do not run a full --clean restore against the linked project.' }, null, 2), { mode: 0o600 })
console.log(JSON.stringify({ destination, counts, files, storageFiles: assets.length }, null, 2))
