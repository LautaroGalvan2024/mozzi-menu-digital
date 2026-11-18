import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { assertStorageUnchanged, validateCheckpoint, validateStorageResponse } from './backup-core.mjs'
import { createBackup } from './backup-linked.mjs'

const object = { id: 'd37b5278-8b07-480d-9573-f70ca950977d', bucket: 'restaurant-assets', name: 'tenant/image.webp',
  version: 'original', updatedAt: '2026-11-17T00:00:00Z', metadata: { size: 3, eTag: 'abc' } }
test('Storage verification rejects replacement, deletion and stale CDN bytes', () => {
  assert.doesNotThrow(() => assertStorageUnchanged(object, structuredClone(object)))
  for (const changed of [undefined, { ...object, version: 'replacement' }, { ...object, updatedAt: 'later' },
    { ...object, metadata: { ...object.metadata, size: 4 } }]) assert.throws(() => assertStorageUnchanged(object, changed), /changed since/)
  const valid = new Response('abc', { headers: { etag: '"abc"' } })
  assert.doesNotThrow(() => validateStorageResponse(object, valid, Buffer.from('abc')))
  assert.throws(() => validateStorageResponse(object, valid, Buffer.from('ab')), /size differs/)
  assert.throws(() => validateStorageResponse(object, new Response('abc', { headers: { etag: '"old"' } }), Buffer.from('abc')), /ETag differs/)
})

test('resume accepts only original source, verified dumps and matching object identities', () => {
  const file = name => ({ file: name, sha256: 'a'.repeat(64) })
  const state = { formatVersion: 2, source: 'test', counts: { storage_objects: 1 }, objects: [object], assets: [{ ...object, ...file(`storage/${object.id}.bin`), bytes: 3 }],
    files: ['database.dump', 'application.dump', 'managed-schema.sql'].map(file) }
  assert.doesNotThrow(() => validateCheckpoint(state, 'test', () => true))
  assert.throws(() => validateCheckpoint({ ...state, formatVersion: 1 }, 'test', () => true), /compatible snapshot/)
  assert.throws(() => validateCheckpoint(state, 'different-project', () => true), /compatible snapshot/)
  assert.throws(() => validateCheckpoint(state, 'test', () => false), /checksum mismatch/)
  assert.throws(() => validateCheckpoint({ ...state, counts: { storage_objects: 2 } }, 'test', () => true), /Invalid snapshot/)
  assert.throws(() => validateCheckpoint({ ...state, assets: [...state.assets, ...state.assets] }, 'test', () => true), /Invalid Storage/)
  assert.throws(() => validateCheckpoint({ ...state, assets: [{ ...state.assets[0], version: 'new' }] }, 'test', () => true), /changed since/)
})

test('another backup writer cannot overwrite the same destination or remove its lock', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'mozzi-backup-lock-'))
  const lock = path.join(directory, 'backup.lock')
  try {
    writeFileSync(lock, 'another-writer')
    await assert.rejects(createBackup({ destination: directory, env: {}, source: 'test' }), { code: 'EEXIST' })
    assert.equal(readFileSync(lock, 'utf8'), 'another-writer')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
