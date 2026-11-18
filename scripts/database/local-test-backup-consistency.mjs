// Isolated PostgreSQL + in-memory Storage responses. Never calls linked credentials or HTTP.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { localDatabaseEnvironment, pgBinary } from './connection.mjs'
import { createBackup } from './backup-linked.mjs'
import { runPrivate } from './backup-core.mjs'

const base = localDatabaseEnvironment()
const suffix = randomBytes(6).toString('hex')
const sourceName = `mozzi_backup_${suffix}`
const restoreName = `mozzi_backup_restore_${suffix}`
const source = { ...base, PGDATABASE: sourceName }
const restored = { ...base, PGDATABASE: restoreName }
const query = async (input, env = source) => (await runPrivate(pgBinary(env, 'psql'), ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '--no-password'], { env, input })).trim()
const root = mkdtempSync(path.join(tmpdir(), 'mozzi-backup-consistency-'))
const directory = label => { const value = path.join(root, label); mkdirSync(value, { mode: 0o700 }); return value }
let sourceCreated = false; let restoreCreated = false; let writing = false; let writer
try {
  assert.match(await query('show server_version;', base), /^17\./)
  await query(`create database "${sourceName}";`, base); sourceCreated = true
  await query(`create schema auth; create schema storage; create schema private; create schema supabase_migrations;
    create table public.restaurants(id uuid primary key default gen_random_uuid());
    create table public.products(id uuid primary key default gen_random_uuid());
    create table public.orders(id uuid primary key default gen_random_uuid());
    create table auth.users(id uuid primary key default gen_random_uuid());
    create table supabase_migrations.schema_migrations(version text);
    create table storage.objects(id uuid primary key,bucket_id text,name text,metadata jsonb,version text,updated_at timestamptz);
    insert into public.restaurants default values; insert into public.products default values;
    insert into auth.users default values; insert into supabase_migrations.schema_migrations values('synthetic');`)
  const objectId = randomUUID()
  await query(`insert into storage.objects values('${objectId}','restaurant-assets','synthetic/image.webp','{"size":3,"eTag":"abc"}','original',now());`)
  const goodResponse = () => new Response('abc', { headers: { etag: '"abc"' } })
  const storage = { url: 'http://127.0.0.1:1' }
  writing = true
  writer = (async () => {
    while (writing) { await query('insert into public.orders default values;'); await new Promise(resolve => setTimeout(resolve, 5)) }
  })()
  const first = directory('concurrent')
  const result = await createBackup({ env: source, destination: first, source: sourceName, storage, fetchImplementation: goodResponse })
  writing = false; await writer; writer = null
  assert.ok(Number(await query('select count(*) from public.orders;')) > result.counts.orders, 'A real write must occur after the exported snapshot')
  await query(`create database "${restoreName}";`, base); restoreCreated = true
  await runPrivate(pgBinary(restored, 'pg_restore'), ['--dbname', restoreName, '--exit-on-error', '--single-transaction', '--no-owner', '--no-acl', path.join(first, 'database.dump')], { env: restored })
  assert.equal(Number(await query('select count(*) from public.orders;', restored)), result.counts.orders, 'Restored rows and manifest must share one snapshot')
  const replay = await createBackup({ env: source, destination: first, source: sourceName, storage, reuse: true,
    fetchImplementation: () => { throw new Error('Completed original bytes must not be downloaded again') } })
  assert.deepEqual(replay.counts, result.counts, 'Resume must preserve original counts after concurrent source writes')
  assert.equal(replay.storageFiles, 1)

  let requests = 0
  const retried = directory('retry')
  await createBackup({ env: source, destination: retried, source: sourceName, storage,
    fetchImplementation: () => ++requests === 1 ? new Response(null, { status: 503 }) : goodResponse() })
  assert.equal(requests, 2, 'Transient Storage read retries the same snapshot object')

  const changed = directory('changed')
  await assert.rejects(createBackup({ env: source, destination: changed, source: sourceName, storage, fetchImplementation: async () => {
    await query(`update storage.objects set version='replacement' where id='${objectId}';`)
    return goodResponse()
  } }), /changed since/)
  assert.equal(existsSync(path.join(changed, 'manifest.json')), false, 'No completed manifest may describe mismatching Storage')
  assert.equal(JSON.parse(readFileSync(path.join(changed, 'snapshot-checkpoint.json'), 'utf8')).assets.length, 0)
  await assert.rejects(createBackup({ env: source, destination: changed, source: sourceName, storage, reuse: true, fetchImplementation: goodResponse }), /changed since/)
  console.log(JSON.stringify({ passed: true, scenarios: ['concurrent writes match restored snapshot', 'resume retains original counts and verified bytes', 'transient Storage retry', 'replacement cannot publish manifest', 'resume cannot relabel changed objects'], networkRequests: 0, temporaryDirectory: root }))
} finally {
  writing = false
  if (writer) await writer
  if (restoreCreated) await query(`drop database "${restoreName}" with (force);`, base)
  if (sourceCreated) await query(`drop database "${sourceName}" with (force);`, base)
}
