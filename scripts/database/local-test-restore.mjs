// Restore only into a NEW loopback mozzi_restore_* DB. Never changes the linked project.
// Real backup data remains local and is never printed. This checks schema/data recovery,
// not managed service ownership/ACLs, Auth HTTP, Storage HTTP or production deployment.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { localDatabaseEnvironment, run } from './connection.mjs'

const directory = process.argv[2] && path.resolve(process.argv[2])
if (!directory || directory === process.cwd() || directory.startsWith(process.cwd() + path.sep)) {
  throw new Error('Specify an existing restricted backup directory outside the repository')
}
const manifest = JSON.parse(readFileSync(path.join(directory, 'manifest.json'), 'utf8'))
function verifyFile(relative, expected) {
  if (typeof relative !== 'string' || !/^[a-f0-9]{64}$/.test(expected ?? '')) throw new Error('Incomplete backup checksum manifest')
  const filename = path.resolve(directory, relative)
  if (!filename.startsWith(directory + path.sep)) throw new Error('Backup file path escapes backup directory')
  assert.equal(createHash('sha256').update(readFileSync(filename)).digest('hex'), expected, 'Backup checksum mismatch')
}
assert.ok(manifest.files?.some(file => file.file === 'database.dump'), 'Database archive checksum required')
for (const file of manifest.files) verifyFile(file.file, file.sha256)
for (const asset of manifest.assets ?? []) verifyFile(asset.file, asset.sha256)
const sourceEnv = localDatabaseEnvironment()
const database = `mozzi_restore_${new Date().toISOString().replace(/\D/g, '').slice(0, 17)}`
const env = { ...sourceEnv, PGDATABASE: database }
const psql = path.join(env.PG_BIN, 'psql.exe')
const query = (sql, name = database) => run(psql, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', name], { env, input: sql }).trim()
assert.match(query('show server_version;', 'postgres'), /^17\./)
assert.equal(query(`select count(*) from pg_database where datname='${database}';`, 'postgres'), '0', 'Restore target must be new')
query(`create database "${database}";`, 'postgres')
query('create schema extensions; create schema auth; create schema storage; create schema private; create schema supabase_migrations; create extension pgcrypto with schema extensions; create extension "uuid-ossp" with schema extensions; create publication supabase_realtime;')

const restored = spawnSync(path.join(env.PG_BIN, 'pg_restore.exe'), [
  '--dbname', database, '--exit-on-error', '--single-transaction', '--no-owner', '--no-acl',
  '--schema=auth', '--schema=storage', '--schema=public', '--schema=private', '--schema=supabase_migrations',
  path.join(directory, 'database.dump'),
], { env, windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
if (restored.error || restored.status !== 0) {
  // COPY diagnostics can contain real data: keep them only in the restricted backup directory.
  const diagnostics = path.join(directory, `${database}-restore-error.log`)
  writeFileSync(diagnostics, restored.stderr ?? restored.error?.message ?? 'Unknown restore failure', { mode: 0o600 })
  throw new Error(`Isolated restore failed; restricted diagnostics saved beside backup (${database}). No data printed.`)
}
const counts = JSON.parse(query(`select json_build_object(
 'migrations',(select count(*) from supabase_migrations.schema_migrations),
 'restaurants',(select count(*) from public.restaurants),
 'products',(select count(*) from public.products),
 'orders',(select count(*) from public.orders),
 'auth_users',(select count(*) from auth.users),
 'storage_objects',(select count(*) from storage.objects));`))
for (const [key, value] of Object.entries(counts)) assert.equal(value, manifest.counts[key], `Restored count mismatch: ${key}`)
assert.equal(query("select count(*) from pg_constraint c join pg_namespace n on n.oid=c.connamespace where n.nspname in ('auth','storage','public','private') and c.contype='f' and not c.convalidated;"), '0', 'Foreign keys must be validated')
const assets = manifest.assets ?? []
let verifiedAssets = 0
for (const asset of assets) {
  const relative = asset.localFile ?? asset.file ?? asset.path
  const expected = asset.sha256
  if (!relative || !expected) throw new Error('Incomplete Storage checksum manifest')
  const filename = path.resolve(directory, relative)
  if (!filename.startsWith(directory + path.sep)) throw new Error('Backup asset path escapes backup directory')
  assert.equal(createHash('sha256').update(readFileSync(filename)).digest('hex'), expected, 'Storage backup checksum mismatch')
  verifiedAssets += 1
}
const report = {
  database, restored: true, countsMatch: true, counts,
  sourcePostgres: manifest.counts.server_version, targetPostgres: query('show server_version;'),
  storageFilesVerified: verifiedAssets, storageManifestEntries: assets.length,
  scope: 'local schema/data/FKs; managed ownership and ACLs intentionally excluded; no HTTP services or production changes',
}
writeFileSync(path.join(directory, `${database}-recovery-report.json`), JSON.stringify(report, null, 2), { mode: 0o600 })
console.log(JSON.stringify(report))
