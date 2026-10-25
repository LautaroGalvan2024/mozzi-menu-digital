// Real PostgreSQL sessions with a lock-observation barrier; synthetic data only.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { localDatabaseEnvironment, run } from './connection.mjs'

const env = localDatabaseEnvironment()
const databaseArgument = process.argv.find(value => value.startsWith('--database='))
if (databaseArgument) env.PGDATABASE = databaseArgument.slice('--database='.length)
if (!/^mozzi_[a-z0-9_]+$/.test(env.PGDATABASE) || env.PGDATABASE.startsWith('mozzi_restore_')) throw new Error('Synthetic test database required; never seed a recovery database')
const executable = path.join(env.PG_BIN, 'psql.exe')
const args = ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose']
const query = sql => run(executable, args, { env, input: sql }).trim()
const literal = value => `'${String(value).replaceAll("'", "''")}'`
const restaurant = randomUUID()
const actor = randomUUID()
const category = randomUUID()
const auth = `select set_config('request.jwt.claim.sub',${literal(actor)},true);
select set_config('request.jwt.claims',${literal(JSON.stringify({ sub: actor, role: 'authenticated', aal: 'aal1' }))},true);
set local role authenticated;`
const parseResult = output => JSON.parse(output.split(/\r?\n/).find(line => line.startsWith('RESULT:')).slice(7))

class Session {
  constructor(name) {
    this.child = spawn(executable, args, { env: { ...env, PGAPPNAME: name }, windowsHide: true })
    this.buffer = ''
    this.errors = ''
    this.pending = null
    this.child.stdout.on('data', data => {
      this.buffer += data.toString()
      while (this.buffer.includes('\n')) {
        const index = this.buffer.indexOf('\n')
        const line = this.buffer.slice(0, index).trimEnd()
        this.buffer = this.buffer.slice(index + 1)
        if (!this.pending) continue
        if (line === this.pending.marker) {
          const pending = this.pending
          this.pending = null
          clearTimeout(pending.timer)
          pending.resolve(pending.lines.join('\n'))
        } else this.pending.lines.push(line)
      }
    })
    this.child.stderr.on('data', data => { this.errors += data.toString() })
    this.child.on('error', error => this.reject(error))
    this.child.on('close', code => { if (this.pending) this.reject(new Error(`SQL session ended (${code}): ${this.errors.slice(-1200)}`)) })
  }
  reject(error) {
    if (!this.pending) return
    clearTimeout(this.pending.timer)
    this.pending.reject(error)
    this.pending = null
  }
  command(sql) {
    if (this.pending) throw new Error('Session already has a pending command')
    return new Promise((resolve, reject) => {
      const marker = `DONE_${randomUUID().replaceAll('-', '')}`
      const timer = setTimeout(() => { this.reject(new Error('SQL session timeout')); this.child.kill() }, 15000)
      this.pending = { marker, resolve, reject, timer, lines: [] }
      this.child.stdin.write(`${sql}\n\\echo ${marker}\n`)
    })
  }
  close() { this.child.stdin.end('\\q\n') }
}

async function waitForLock(name) {
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    if (query(`select count(*) from pg_stat_activity where application_name=${literal(name)} and wait_event_type='Lock';`) === '1') return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('Contender did not reach a database lock; concurrency was not demonstrated')
}

async function race(firstSql, secondSql, rollback = false) {
  const label = `sku_${randomUUID().slice(0, 8)}`
  const first = new Session(`${label}_holder`)
  const second = new Session(`${label}_waiter`)
  try {
    const initial = parseResult(await first.command(`begin; set local statement_timeout='12s'; ${auth}\n${firstSql}`))
    const pending = second.command(`begin; set local statement_timeout='12s'; ${auth}\n${secondSql}\ncommit;`)
    // Attach a rejection observer immediately, including failures before the barrier.
    pending.catch(() => {})
    await waitForLock(`${label}_waiter`)
    await first.command(rollback ? 'rollback;' : 'commit;')
    const subsequent = parseResult(await pending)
    return [initial, subsequent]
  } finally {
    await first.command('rollback;').catch(() => {})
    await second.command('rollback;').catch(() => {})
    first.close()
    second.close()
  }
}

const manual = (id, code) => `select 'RESULT:' || public.save_product_catalog(${literal(restaurant)},
 ${literal(JSON.stringify({ id, ...(code === undefined ? {} : { code }), categoryId: category, name: 'Synthetic race product', basePriceCents: 1000 }))}::jsonb,'[]'::jsonb)::text;`
const batch = (id, overrides = {}) => ({ batchId: id, products: [{ rowRef: '2', name: 'Synthetic race import', category: 'Race', basePriceCents: 1000, ...overrides }] })
const imported = payload => `select 'RESULT:' || public.import_products_batch(${literal(restaurant)},${literal(JSON.stringify(payload))}::jsonb,'upsert')::text;`
const reports = []
query(`begin;
insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values(${literal(actor)},${literal(`sku-${actor}@example.test`)},now(),'{"full_name":"Synthetic concurrency admin"}');
insert into public.restaurants(id,name,trade_name,slug,status,whatsapp_phone_e164,address,city,order_prefix,public_menu_enabled,created_by)
values(${literal(restaurant)},'Synthetic concurrency','Synthetic',${literal(`sku-${restaurant}`)},'active','+5491111111111','Synthetic','Synthetic','SYC',true,${literal(actor)});
insert into public.restaurant_members(restaurant_id,user_id,role,status,invited_by)
values(${literal(restaurant)},${literal(actor)},'restaurant_admin','active',${literal(actor)});
insert into public.categories(id,restaurant_id,name,slug) values(${literal(category)},${literal(restaurant)},'Race','race');
commit;`)
{
  const stableId = randomUUID()
  const [manualFirst, manualSecond] = await race(manual(stableId), manual(stableId))
  assert.equal(manualFirst.code, manualSecond.code)
  assert.equal(manualFirst.productId, manualSecond.productId)
  assert.equal(query(`select count(*) from public.products where id=${literal(stableId)};`), '1')
  reports.push('same manual UUID: one product and one stable code')

  const allocatorHolder = new Session(`sku_code_holder_${randomUUID().slice(0, 8)}`)
  const directEditor = new Session(`sku_direct_denied_${randomUUID().slice(0, 8)}`)
  try {
    await allocatorHolder.command(`begin; set local statement_timeout='12s'; ${auth}\n${manual(stableId)}`)
    // Must fail while the allocator and product remain locked, not wait for release.
    await assert.rejects(directEditor.command(`begin; set local statement_timeout='2s'; ${auth}\nupdate public.products set code='DIRECT-BYPASS' where id=${literal(stableId)}; commit;`), /42501/)
    await allocatorHolder.command('commit;')
    reports.push('direct authenticated code UPDATE: permission denied before allocator/product wait')
  } finally {
    await allocatorHolder.command('rollback;').catch(() => {})
    allocatorHolder.close()
    directEditor.close()
  }

  const changedCode = `EDIT-${randomUUID().slice(0, 8)}`
  const [edited, importedAfterEdit] = await race(manual(stableId, changedCode), imported(batch(randomUUID(), { id: stableId })))
  assert.equal(edited.code, changedCode)
  assert.equal(importedAfterEdit.products[0].code, changedCode)
  assert.equal(importedAfterEdit.products[0].id, stableId)
  assert.equal(importedAfterEdit.summary.updated, 1)
  reports.push('concurrent code RPC and UUID import: common lock order, same UUID and preserved new code')

  const [differentFirst, differentSecond] = await race(manual(randomUUID()), manual(randomUUID()))
  assert.notEqual(differentFirst.code, differentSecond.code)
  reports.push('different manual UUIDs: distinct generated codes under contention')

  const samePayload = batch(randomUUID())
  const [importFirst, importSecond] = await race(imported(samePayload), imported(samePayload))
  assert.deepEqual(importFirst, importSecond)
  assert.equal(query(`select count(*) from private.catalog_import_batches where restaurant_id=${literal(restaurant)} and batch_id=${literal(samePayload.batchId)};`), '1')
  reports.push('same concurrent batch: one committed operation and identical response')

  // Simulate the client discarding a successful response, then changing product data elsewhere.
  query(`update public.products set name='Changed after response loss' where id=${literal(importFirst.products[0].id)};`)
  const replay = parseResult(query(`begin;${auth}\n${imported(samePayload)}\ncommit;`))
  assert.deepEqual(replay, importFirst)
  assert.equal(query(`select name from public.products where id=${literal(importFirst.products[0].id)};`), 'Changed after response loss')
  reports.push('response-loss replay: stable result without overwriting a later edit')

  const rollbackPayload = batch(randomUUID(), { code: `ROLLBACK-${randomUUID().slice(0, 8)}` })
  const [, retryAfterRollback] = await race(imported(rollbackPayload), imported(rollbackPayload), true)
  assert.equal(retryAfterRollback.summary.created, 1)
  assert.equal(query(`select count(*) from public.products where restaurant_id=${literal(restaurant)} and code=${literal(rollbackPayload.products[0].code)};`), '1')
  reports.push('holder rollback: waiting retry creates exactly once; claim and result are atomic')

  const [firstBatch, secondBatch] = await race(imported(batch(randomUUID())), imported(batch(randomUUID())))
  assert.notEqual(firstBatch.products[0].id, secondBatch.products[0].id)
  assert.notEqual(firstBatch.products[0].code, secondBatch.products[0].code)
  reports.push('deliberately different batches: new products despite identical names')

  // Committed race fixtures retain append-only audit history in this disposable test DB.
  // Do not disable ledger/audit protections merely to clean up a test.
  console.log(JSON.stringify({ database: env.PGDATABASE, fixtureTenant: restaurant,
    barriers: 6, scenarios: reports, passed: true, fixtures: 'synthetic; retained with audit history' }))
}
