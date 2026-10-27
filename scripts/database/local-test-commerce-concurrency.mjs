// Commerce payment races: independent sessions, observed lock waits, synthetic local data only.
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

function fixture() {
  const tenant = randomUUID(); const product = randomUUID(); const category = randomUUID()
  const slug = `pay-${tenant}`
  query(`begin;
    insert into public.restaurants(id,name,trade_name,slug,status,whatsapp_phone_e164,order_prefix,store_enabled,inventory_mode,inventory_activated_at,inventory_business_policy)
    values(${literal(tenant)},'Synthetic payment race','Synthetic',${literal(slug)},'active','+5491111111111','PAY',true,'enforced',now(),'{}');
    insert into public.categories(id,restaurant_id,name,slug) values(${literal(category)},${literal(tenant)},'Cases','cases');
    insert into public.products(id,restaurant_id,category_id,code,name,base_price_cents)
    values(${literal(product)},${literal(tenant)},${literal(category)},'LAST','Last case',1000);
    insert into public.inventory_balances(restaurant_id,product_id,on_hand) values(${literal(tenant)},${literal(product)},1);
    select public.save_payment_account(${literal(tenant)},${literal(tenant)},'encrypted-synthetic',now()+interval '1 day');
    update public.restaurants set store_checkout_online_enabled=true where id=${literal(tenant)};
    commit;`)
  return { tenant, product, slug }
}
function beginCheckout(f, key) {
  const request = { restaurantSlug: f.slug, idempotencyKey: key, channel: 'store', checkoutMode: 'online',
    customer: { name: 'Synthetic Buyer', phone: '+5491111111111' }, fulfillment: { type: 'pickup' },
    paymentMethodId: '00000000-0000-4000-8000-000000000000', items: [{ productId: f.product, quantity: 1, optionIds: [] }] }
  return `select 'RESULT:'||public.begin_online_checkout(${literal(JSON.stringify(request))}::jsonb,repeat('a',64),repeat('b',64),repeat('c',64),repeat('d',64))::text;`
}
async function race(firstSql, secondSql, expectedError) {
  const name = `commerce_${randomUUID().slice(0, 8)}`
  const first = new Session(`${name}_holder`); const second = new Session(`${name}_waiter`)
  try {
    const firstResult = await first.command(`begin;set local statement_timeout='12s';set local role service_role;${firstSql}`)
    const pending = second.command(`begin;set local statement_timeout='12s';set local role service_role;${secondSql}commit;`)
    pending.catch(() => {})
    await barrier(`${name}_waiter`)
    await first.command('commit;')
    if (expectedError) { await assert.rejects(pending, expectedError); return [firstResult, null] }
    return [firstResult, await pending]
  } finally {
    await first.command('rollback;').catch(() => {})
    if (!second.closed) await second.command('rollback;').catch(() => {})
    first.close(); second.close()
  }
}

const replayFixture = fixture(); const key = randomUUID()
const [first, replay] = await race(beginCheckout(replayFixture, key), beginCheckout(replayFixture, key))
assert.equal(result(first).attemptId, result(replay).attemptId)
assert.equal(result(first).preferenceLeaseAcquired, true)
assert.equal(result(replay).preferenceLeaseAcquired, false)
assert.equal(query(`select reserved from public.inventory_balances where product_id=${literal(replayFixture.product)};`), '1')

const lastUnit = fixture()
await race(beginCheckout(lastUnit, randomUUID()), beginCheckout(lastUnit, randomUUID()), /INSUFFICIENT_STOCK/)
assert.equal(query(`select count(*) from public.orders where restaurant_id=${literal(lastUnit.tenant)};`), '1')
assert.equal(query(`select reserved from public.inventory_balances where product_id=${literal(lastUnit.product)};`), '1')

const expiry = fixture()
const created = result(query(`begin;set local role service_role;${beginCheckout(expiry, randomUUID())}commit;`))
query(`update private.online_payment_attempts set expires_at=now()-interval '1 minute' where id=${literal(created.attemptId)};`)
const approval = `select 'RESULT:'||public.reconcile_online_payment(${literal(created.attemptId)},'synthetic-${created.attemptId}','approved',1000,'ARS',now())::text;`
const [, expirationResult] = await race(approval, "select 'RESULT:'||public.expire_online_reservations()::text;")
assert.equal(result(expirationResult), 0)
assert.equal(query(`select payment_status from public.orders where id=${literal(created.orderId)};`), 'approved')
assert.equal(query(`select reserved from public.inventory_balances where product_id=${literal(expiry.product)};`), '1')
console.log(JSON.stringify({ database: env.PGDATABASE, passed: true, barriers: 3, scenarios: [
  'concurrent retry: one order, one stock hold, one preference creator',
  'different buyers: only one can reserve last unit; losing order rolls back',
  'approval racing expiration: approved reservation remains held',
], fixtures: 'synthetic only; retained with immutable history' }))
