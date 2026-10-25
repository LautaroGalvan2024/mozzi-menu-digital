// O03 integration: independent PostgreSQL sessions, observed lock barriers, synthetic data.
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
const args = ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1']
const query = sql => run(executable, args, { env, input: sql }).trim()
const literal = value => `'${String(value).replaceAll("'", "''")}'`
const result = output => JSON.parse(output.split(/\r?\n/).find(line => line.startsWith('RESULT:')).slice(7))
class Session {
  constructor(name) {
    this.child = spawn(executable, args, { env: { ...env, PGAPPNAME: name }, windowsHide: true })
    this.buffer = ''; this.errors = ''; this.pending = null; this.closed = false
    this.child.stdout.on('data', data => {
      this.buffer += data.toString()
      while (this.buffer.includes('\n')) {
        const at = this.buffer.indexOf('\n'); const line = this.buffer.slice(0, at).trimEnd()
        this.buffer = this.buffer.slice(at + 1)
        if (!this.pending) continue
        if (line === this.pending.marker) {
          const pending = this.pending; this.pending = null; clearTimeout(pending.timer)
          pending.resolve(pending.lines.join('\n'))
        } else this.pending.lines.push(line)
      }
    })
    this.child.stderr.on('data', data => { this.errors += data.toString() })
    this.child.on('error', error => this.reject(error))
    this.child.on('close', code => {
      this.closed = true
      this.reject(new Error(`SQL session ended (${code}): ${this.errors.slice(-1200)}`))
    })
  }
  reject(error) {
    if (!this.pending) return
    clearTimeout(this.pending.timer); this.pending.reject(error); this.pending = null
  }
  command(sql) {
    if (this.pending || this.closed) return Promise.reject(new Error('Session is unavailable'))
    return new Promise((resolve, reject) => {
      const marker = `DONE_${randomUUID().replaceAll('-', '')}`
      const timer = setTimeout(() => { this.reject(new Error('SQL session timeout')); this.child.kill() }, 15000)
      this.pending = { marker, resolve, reject, timer, lines: [] }
      this.child.stdin.write(`${sql}\n\\echo ${marker}\n`)
    })
  }
  close() { if (!this.closed) this.child.stdin.end('\\q\n') }
}
async function barrier(name) {
  const until = Date.now() + 8000
  while (Date.now() < until) {
    if (query(`select count(*) from pg_stat_activity where application_name=${literal(name)} and wait_event_type='Lock';`) === '1') return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('Expected real PostgreSQL lock contention was not observed')
}

const restaurant = randomUUID(); const category = randomUUID(); const product = randomUUID(); const payment = randomUUID()
const slug = `intent-${restaurant}`
query(`begin;
insert into public.restaurants(id,name,trade_name,slug,status,whatsapp_phone_e164,address,city,order_prefix,public_menu_enabled)
values(${literal(restaurant)},'Synthetic intent concurrency','Synthetic',${literal(slug)},'active','+5491111111111','Synthetic','Synthetic','IOC',true);
insert into public.categories(id,restaurant_id,name,slug) values(${literal(category)},${literal(restaurant)},'Food','food');
insert into public.products(id,restaurant_id,category_id,code,name,base_price_cents)
values(${literal(product)},${literal(restaurant)},${literal(category)},'RACE','Synthetic race product',1000);
insert into public.payment_methods(id,restaurant_id,code,name) values(${literal(payment)},${literal(restaurant)},'cash','Cash');
insert into public.business_hours(restaurant_id,day_of_week,slot_index,opens_at,closes_at,spans_next_day)
select ${literal(restaurant)}::uuid,d,0,'00:00'::time,'23:59'::time,false from generate_series(0,6)d
union all select ${literal(restaurant)}::uuid,d,1,'23:58'::time,'00:01'::time,true from generate_series(0,6)d;
commit;`)
const payload = key => ({ restaurantSlug: slug, idempotencyKey: key,
  customer: { name: 'Synthetic customer', phone: '+5491111111111' }, fulfillment: { type: 'pickup' },
  paymentMethodId: payment, notes: 'Synthetic intent', items: [{ productId: product, quantity: 2, notes: '', optionIds: [] }] })
const create = (request, token) => `select 'RESULT:'||public.create_order_transaction(${literal(JSON.stringify(request))}::jsonb,repeat('1',64),repeat('2',64),repeat('${token}',64))::text;`
const call = sql => result(query(`begin;set local role service_role;${sql}commit;`))
async function race(firstRequest, secondRequest, { rollback = false, conflict = false } = {}) {
  const name = `order_${randomUUID().slice(0, 8)}`
  const first = new Session(`${name}_holder`); const second = new Session(`${name}_waiter`)
  try {
    const initial = result(await first.command(`begin;set local statement_timeout='12s';set local role service_role;${create(firstRequest, '3')}`))
    const pending = second.command(`begin;set local statement_timeout='12s';set local role service_role;${create(secondRequest, '4')}commit;`)
    pending.catch(() => {})
    await barrier(`${name}_waiter`)
    await first.command(rollback ? 'rollback;' : 'commit;')
    if (conflict) {
      await assert.rejects(pending, /IDEMPOTENCY_CONFLICT/)
      return [initial, null]
    }
    return [initial, result(await pending)]
  } finally {
    await first.command('rollback;').catch(() => {})
    if (!second.closed) await second.command('rollback;').catch(() => {})
    first.close(); second.close()
  }
}

const reports = []
const same = payload(randomUUID())
const [first, second] = await race(same, same)
assert.equal(first.order.actionId, second.order.actionId)
assert.equal(second.idempotentReplay, true)
assert.equal(query(`select count(*) from public.orders where restaurant_id=${literal(restaurant)} and idempotency_key=${literal(same.idempotencyKey)};`), '1')
reports.push('same key and business request: one order with replay after lock wait')
for (const token of ['3', '4']) {
  assert.equal(call(`select 'RESULT:'||public.register_whatsapp_opened(${literal(first.order.actionId)},repeat('${token}',64))::text;`).registered, true)
}
assert.equal(query(`select count(*) from public.order_events e join public.orders o on o.id=e.order_id where o.action_id=${literal(first.order.actionId)} and e.event_type='whatsapp_opened';`), '1')
reports.push('tokens from both concurrent responses remain valid; one WhatsApp event')

const original = payload(randomUUID())
await race(original, { ...original, customer: { ...original.customer, phone: '+5492222222222' } }, { conflict: true })
assert.equal(query(`select count(*) from public.orders where restaurant_id=${literal(restaurant)} and idempotency_key=${literal(original.idempotencyKey)};`), '1')
assert.equal(query(`select count(*) from private.order_client_event_token_history h join public.orders o on o.id=h.order_id where o.restaurant_id=${literal(restaurant)} and o.idempotency_key=${literal(original.idempotencyKey)} and h.token_hash=repeat('4',64);`), '0')
reports.push('same key with changed phone: conflict after lock wait; no second order or token')

const rollback = payload(randomUUID())
const [aborted, committed] = await race(rollback, rollback, { rollback: true })
assert.notEqual(aborted.order.actionId, committed.order.actionId)
assert.equal(committed.idempotentReplay, false)
assert.equal(query(`select count(*) from public.orders where restaurant_id=${literal(restaurant)} and idempotency_key=${literal(rollback.idempotencyKey)};`), '1')
assert.equal(query(`select count(*) from private.order_request_receipts where restaurant_id=${literal(restaurant)} and idempotency_key=${literal(rollback.idempotencyKey)};`), '1')
reports.push('rollback before commit: waiting retry commits one order and matching receipt')

const afterLoss = call(create(rollback, '5'))
assert.equal(afterLoss.order.actionId, committed.order.actionId)
assert.equal(afterLoss.idempotentReplay, true)
reports.push('discarded response: same full request recovers original order')
console.log(JSON.stringify({ database: env.PGDATABASE, fixtureTenant: restaurant, barriers: 3,
  scenarios: reports, passed: true, fixtures: 'synthetic; retained with immutable audit history' }))
