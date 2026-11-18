import { spawn } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

// Never echo libpq/pg_dump stderr: connection details and COPY rows can be sensitive.
export function runPrivate(binary, args, { env, input, timeout = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let output = ''; let failed = false
    const stop = message => { if (failed) return; failed = true; child.kill(); reject(new Error(message)) }
    const timer = setTimeout(() => stop('PostgreSQL operation timed out; raw diagnostics withheld'), timeout)
    child.stdout.on('data', chunk => {
      output += chunk.toString()
      if (output.length > 64 * 1024 * 1024) stop('PostgreSQL result exceeded the output limit')
    })
    child.stderr.resume()
    child.on('error', () => stop('Cannot launch PostgreSQL operation; raw diagnostics withheld'))
    child.on('close', code => {
      clearTimeout(timer)
      if (!failed) {
        if (code === 0) resolve(output)
        else reject(new Error(`PostgreSQL ${path.basename(binary)} failed; raw diagnostics withheld`))
      }
    })
    child.stdin.on('error', () => stop('PostgreSQL input closed unexpectedly'))
    child.stdin.end(input ?? '')
  })
}

export class SnapshotSession {
  constructor(binary, env, { queryTimeout = 120_000 } = {}) {
    this.child = spawn(binary, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '--no-password'], {
      env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.queryTimeout = queryTimeout; this.pending = null; this.buffer = ''; this.closed = false
    this.child.stdout.on('data', chunk => {
      this.buffer += chunk.toString()
      if (this.buffer.length > 64 * 1024 * 1024) return this.fail('Snapshot query exceeded the output limit')
      const pending = this.pending
      if (!pending) return
      const position = this.buffer.indexOf(`${pending.marker}\n`)
      const windowsPosition = this.buffer.indexOf(`${pending.marker}\r\n`)
      const at = position >= 0 ? position : windowsPosition
      if (at < 0) return
      const output = this.buffer.slice(0, at).trim()
      this.buffer = this.buffer.slice(at + pending.marker.length).replace(/^\r?\n/, '')
      clearTimeout(pending.timer); this.pending = null; pending.resolve(output)
    })
    this.child.stderr.resume()
    this.child.stdin.on('error', () => this.fail('Snapshot input closed unexpectedly'))
    this.child.on('error', () => this.fail('Cannot launch snapshot session'))
    this.exit = new Promise(resolve => this.child.on('close', () => {
      this.closed = true; this.fail('Snapshot session ended before completion'); resolve()
    }))
  }
  fail(message) {
    this.failure = new Error(`${message}; raw diagnostics withheld`)
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(this.failure); this.pending = null }
  }
  query(sql) {
    if (this.closed || this.failure || this.pending) return Promise.reject(this.failure ?? new Error('Snapshot session unavailable'))
    return new Promise((resolve, reject) => {
      const marker = `DONE_${randomUUID().replaceAll('-', '')}`
      const timer = setTimeout(() => { this.fail('Snapshot query timed out'); this.child.kill() }, this.queryTimeout)
      this.pending = { marker, timer, resolve, reject }
      this.child.stdin.write(`${sql}\n\\echo ${marker}\n`)
    })
  }
  async begin() {
    await this.query("begin isolation level repeatable read read only; set local role postgres; set local statement_timeout='60s'; set local idle_in_transaction_session_timeout='30min';")
    const snapshot = await this.query('select pg_export_snapshot();')
    if (!/^[0-9A-Fa-f]+-[0-9A-Fa-f]+-\d+$/.test(snapshot)) throw new Error('Invalid exported snapshot identifier')
    return snapshot
  }
  async close() {
    if (!this.closed && !this.child.stdin.writableEnded) this.child.stdin.end('rollback;\n\\q\n')
    const timer = setTimeout(() => this.child.kill(), 5_000)
    try { await this.exit } finally { clearTimeout(timer) }
  }
}

export function atomicJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`
  writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' })
  renameSync(temporary, file)
}
export function checksum(file) { return createHash('sha256').update(readFileSync(file)).digest('hex') }
export function storageIdentity(object) {
  return JSON.stringify([object.id, object.bucket, object.name, object.version, object.updatedAt, object.metadata])
}
export function assertStorageUnchanged(expected, actual) {
  if (!actual || storageIdentity(expected) !== storageIdentity(actual)) {
    throw new Error('Storage object changed since the database snapshot; retain this checkpoint and restart a new backup if the original version is unavailable')
  }
}
function normalizeEtag(value) { return value?.replace(/^W\//, '').replace(/^"|"$/g, '') }
export function validateStorageResponse(object, response, bytes) {
  if (!response.ok) throw new Error(`Storage backup failed: HTTP ${response.status}`)
  const size = object.metadata?.size
  if (Number.isSafeInteger(size) && bytes.length !== size) throw new Error('Storage response size differs from the snapshot')
  const expectedEtag = normalizeEtag(object.metadata?.eTag ?? object.metadata?.etag)
  if (expectedEtag && normalizeEtag(response.headers.get('etag')) !== expectedEtag) {
    throw new Error('Storage response ETag differs from the snapshot')
  }
}

export function validateCheckpoint(state, source, verifyFile) {
  if (state?.formatVersion !== 2 || state.source !== source || !state.counts || !Array.isArray(state.objects)
    || !Array.isArray(state.assets) || !Array.isArray(state.files) || state.files.length !== 3) {
    throw new Error('A compatible snapshot checkpoint is required; legacy dumps cannot be relabeled with current counts')
  }
  const expectedFiles = ['application.dump', 'database.dump', 'managed-schema.sql']
  if (state.files.map(file => file.file).sort().join('|') !== expectedFiles.join('|')
    || state.counts.storage_objects !== state.objects.length
    || new Set(state.objects.map(object => object.id)).size !== state.objects.length) {
    throw new Error('Invalid snapshot checkpoint inventory')
  }
  for (const file of [...state.files, ...state.assets]) {
    if (typeof file.file !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256 ?? '') || !verifyFile(file.file, file.sha256)) {
      throw new Error('Backup checkpoint checksum mismatch')
    }
  }
  const ids = new Set(state.objects.map(object => object.id))
  const completed = new Set()
  for (const asset of state.assets) {
    const object = state.objects.find(value => value.id === asset.id)
    if (!object || !ids.has(asset.id) || completed.has(asset.id) || asset.file !== `storage/${asset.id}.bin`
      || (Number.isSafeInteger(object.metadata?.size) && asset.bytes !== object.metadata.size)) throw new Error('Invalid Storage checkpoint inventory')
    assertStorageUnchanged(object, asset); completed.add(asset.id)
  }
}
