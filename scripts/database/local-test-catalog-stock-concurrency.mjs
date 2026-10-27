// Real PostgreSQL sessions + observed lock waits; synthetic loopback data only.
// Fixtures retain append-only history in an isolated test DB and never call MP.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { localDatabaseEnvironment, run } from './connection.mjs'

const env = localDatabaseEnvironment()
const database = process.argv.find(value => value.startsWith('--database='))
if (database) env.PGDATABASE = database.slice('--database='.length)
if (!/^mozzi_[a-z0-9_]+$/.test(env.PGDATABASE) || env.PGDATABASE.startsWith('mozzi_restore_')) {
  throw new Error('Synthetic test database required; never seed a recovery database')
}
const executable = path.join(env.PG_BIN, 'psql.exe')
const args = ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1']
const query = sql => run(executable, args, { env, input: sql }).trim()
const literal = value => `'${String(value).replaceAll("'", "''")}'`
const result = output => JSON.parse(output.split(/\r?\n/).find(line => line.startsWith('RESULT:')).slice(7))
const json = value => `${literal(JSON.stringify(value))}::jsonb`
function auth(user) {
  return `select set_config('request.jwt.claim.sub',${literal(user)},true);
    select set_config('request.jwt.claims',${literal(JSON.stringify({ sub: user, role: 'authenticated', aal: 'aal1' }))},true);
    set local role authenticated;`
}

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

function save(f, onHand, expectedVersion, operation = randomUUID(), name = 'Edited case') {
  return `select 'RESULT:'||public.save_product_catalog_with_stock(${literal(f.tenant)},
    ${json({ id: f.product, categoryId: f.category, name, basePriceCents: 1000 })},'[]','{}','{}',
    ${literal(operation)},${json({ onHand: String(onHand), expectedVersion })})::text;`
}

function fixture() {
  const f = { tenant: randomUUID(), actor: randomUUID(), product: randomUUID(), category: randomUUID() }
  f.slug = `stock-race-${f.tenant}`
  query(`begin;
    insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data)
    values(${literal(f.actor)},${literal(`stock-race-${f.actor}@example.test`)},now(),'{}');
    insert into public.restaurants(id,name,trade_name,slug,status,whatsapp_phone_e164,order_prefix,store_enabled)
    values(${literal(f.tenant)},'Synthetic stock race','Synthetic',${literal(f.slug)},'active','+5491111111111','STK',true);
    insert into public.restaurant_members(restaurant_id,user_id,role,status,invited_by)
    values(${literal(f.tenant)},${literal(f.actor)},'restaurant_admin','active',${literal(f.actor)});
    insert into public.categories(id,restaurant_id,name,slug) values(${literal(f.category)},${literal(f.tenant)},'Cases','cases');
    ${auth(f.actor)}
    ${save(f, 5, null, randomUUID(), 'Original case')}
    select public.activate_inventory_from_product_stock(${literal(f.tenant)},${literal(randomUUID())},0);
    reset role;
    select public.save_payment_account(${literal(f.tenant)},${literal(f.tenant)},'encrypted-synthetic',now()+interval '1 day',false);
    update public.restaurants set store_checkout_online_enabled=true where id=${literal(f.tenant)};
    commit;`)
  return f
}

function checkout(f) {
  const request = { restaurantSlug: f.slug, idempotencyKey: randomUUID(), channel: 'store', checkoutMode: 'online',
    customer: { name: 'Synthetic Buyer', phone: '+5491111111111' }, fulfillment: { type: 'pickup' },
    paymentMethodId: '00000000-0000-4000-8000-000000000000', items: [{ productId: f.product, quantity: 1, optionIds: [] }] }
  return `set local role service_role; select 'RESULT:'||public.begin_online_checkout(${json(request)},
    repeat('a',64),repeat('b',64),repeat('c',64),repeat('d',64),false,
    (public.get_payment_account(p_restaurant_id=>${literal(f.tenant)})->>'accountId')::uuid)::text;`
}

async function race(firstSql, secondSql, expectedError) {
  const name = `catalog_stock_${randomUUID().slice(0, 8)}`
  const first = new Session(`${name}_holder`); const second = new Session(`${name}_waiter`)
  try {
    const firstResult = await first.command(`begin;set local statement_timeout='12s';${firstSql}`)
    const pending = second.command(`begin;set local statement_timeout='12s';${secondSql}commit;`)
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

function assertBalance(f, onHand, reserved, version, orders) {
  const actual = JSON.parse(query(`select jsonb_build_object('onHand',on_hand,'reserved',reserved,'version',version)
    from public.inventory_balances where restaurant_id=${literal(f.tenant)} and product_id=${literal(f.product)};`))
  assert.deepEqual(actual, { onHand, reserved, version })
  assert.equal(query(`select count(*) from public.orders where restaurant_id=${literal(f.tenant)};`), String(orders))
  assert.equal(query(`select count(*) from public.inventory_balances b where b.restaurant_id=${literal(f.tenant)}
    and (b.on_hand<>(select coalesce(sum(m.delta_on_hand),0) from public.inventory_movements m where m.restaurant_id=b.restaurant_id and m.product_id=b.product_id)
      or b.reserved<>(select coalesce(sum(m.delta_reserved),0) from public.inventory_movements m where m.restaurant_id=b.restaurant_id and m.product_id=b.product_id));`), '0')
}

const reservationFirst = fixture()
await race(checkout(reservationFirst), auth(reservationFirst.actor) + save(reservationFirst, 3, '1'), /INVENTORY_VERSION_CONFLICT/)
assertBalance(reservationFirst, 5, 1, 2, 1)
assert.equal(query(`select name from public.products where id=${literal(reservationFirst.product)};`), 'Original case')

const editorFirst = fixture()
const [, payment] = await race(auth(editorFirst.actor) + save(editorFirst, 3, '1'), checkout(editorFirst))
assert.ok(result(payment).attemptId)
assertBalance(editorFirst, 3, 1, 3, 1)

const zeroFirst = fixture()
await race(auth(zeroFirst.actor) + save(zeroFirst, 0, '1'), checkout(zeroFirst), /INSUFFICIENT_STOCK/)
assertBalance(zeroFirst, 0, 0, 2, 0)

const duplicate = fixture(); const commandId = randomUUID()
const command = auth(duplicate.actor) + save(duplicate, 4, '1', commandId)
const [saved, replay] = await race(command, command)
assert.equal(result(saved).replayed, false)
assert.equal(result(replay).replayed, true)
assert.equal(result(saved).stock.operationId, result(replay).stock.operationId)
assertBalance(duplicate, 4, 0, 2, 0)
assert.equal(query(`select count(*) from public.inventory_operations where restaurant_id=${literal(duplicate.tenant)} and idempotency_key=${literal(commandId)};`), '1')

const twoEditors = fixture()
await race(auth(twoEditors.actor) + save(twoEditors, 4, '1'), auth(twoEditors.actor) + save(twoEditors, 9, '1'), /INVENTORY_VERSION_CONFLICT/)
assertBalance(twoEditors, 4, 0, 2, 0)

console.log(JSON.stringify({ database: env.PGDATABASE, passed: true, barriers: 5, scenarios: [
  'checkout first: stale absolute edit waits then fails version check; reservation and catalogue remain intact',
  'editor first: checkout waits, then reserves against newly committed quantity without lost units',
  'editor sets zero first: checkout waits then fails wholly with no order or reservation',
  'same command from two sessions: one catalogue/stock operation and durable replay',
  'two editors with same version: one succeeds and stale quantity cannot overwrite it',
], fixtures: 'synthetic only; retained with immutable history; physical and reserved ledger sums checked' }))
