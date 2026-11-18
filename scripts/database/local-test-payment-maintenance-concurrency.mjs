// Synthetic loopback fixtures only. Real concurrent locks prove that maintenance
// skips busy merchants and that a late approval still reacquires stock atomically.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { localDatabaseEnvironment, pgBinary, run } from './connection.mjs'

const env = localDatabaseEnvironment()
const databaseArgument = process.argv.find(value => value.startsWith('--database='))
if (databaseArgument) env.PGDATABASE = databaseArgument.slice('--database='.length)
if (!/^mozzi_[a-z0-9_]+$/.test(env.PGDATABASE) || env.PGDATABASE.startsWith('mozzi_restore_')) {
  throw new Error('Synthetic test database required; never seed a recovery database')
}
const executable = pgBinary(env, 'psql')
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
        const index = this.buffer.indexOf('\n'); const line = this.buffer.slice(0, index).trimEnd()
        this.buffer = this.buffer.slice(index + 1)
        if (!this.pending) continue
        if (line === this.pending.marker) {
          const pending = this.pending; this.pending = null; clearTimeout(pending.timer)
          pending.resolve(pending.lines.join('\n'))
        } else this.pending.lines.push(line)
      }
    })
    this.child.stderr.on('data', data => { this.errors += data.toString() })
    this.child.on('error', error => this.reject(error))
    this.child.on('close', code => { this.closed = true; this.reject(new Error(`SQL session ended (${code}): ${this.errors.slice(-1200)}`)) })
  }
  reject(error) {
    if (!this.pending) return
    clearTimeout(this.pending.timer); this.pending.reject(error); this.pending = null
  }
  command(sql) {
    if (this.pending || this.closed) return Promise.reject(new Error('Session unavailable'))
    return new Promise((resolve, reject) => {
      const marker = `DONE_${randomUUID().replaceAll('-', '')}`
      const timer = setTimeout(() => { this.reject(new Error('SQL session timeout')); this.child.kill() }, 15000)
      this.pending = { marker, resolve, reject, timer, lines: [] }
      this.child.stdin.write(`${sql}\n\\echo ${marker}\n`)
    })
  }
  close() { if (!this.closed) this.child.stdin.end('\\q\n') }
}

function fixture() {
  const tenant = randomUUID(); const product = randomUUID(); const category = randomUUID()
  const slug = `maintenance-${tenant}`
  const request = { restaurantSlug: slug, idempotencyKey: randomUUID(), channel: 'store', checkoutMode: 'online',
    customer: { name: 'Synthetic Buyer', phone: '+5491111111111' }, fulfillment: { type: 'pickup' },
    paymentMethodId: '00000000-0000-4000-8000-000000000000', items: [{ productId: product, quantity: 1, optionIds: [] }] }
  const created = result(query(`begin;
    insert into public.restaurants(id,name,trade_name,slug,status,whatsapp_phone_e164,order_prefix,store_enabled,inventory_mode,inventory_activated_at,inventory_business_policy)
      values(${literal(tenant)},'Synthetic maintenance race','Synthetic',${literal(slug)},'active','+5491111111111','MNT',true,'enforced',now(),'{}');
    insert into public.categories(id,restaurant_id,name,slug) values(${literal(category)},${literal(tenant)},'Cases','cases');
    insert into public.products(id,restaurant_id,category_id,code,name,base_price_cents)
      values(${literal(product)},${literal(tenant)},${literal(category)},'ONE','One unit',1000);
    insert into public.inventory_balances(restaurant_id,product_id,on_hand) values(${literal(tenant)},${literal(product)},1);
    select public.save_payment_account(${literal(tenant)},${literal(tenant)},'synthetic-ciphertext',now()+interval '1 day',false);
    update public.restaurants set store_checkout_online_enabled=true where id=${literal(tenant)};
    select 'RESULT:'||public.begin_online_checkout(${literal(JSON.stringify(request))}::jsonb,repeat('a',64),repeat('b',64),repeat('c',64),repeat('d',64),false,
      (public.get_payment_account(${literal(tenant)})->>'accountId')::uuid)::text;
    commit;`))
  return { tenant, product, ...created }
}

const scenarios = []
for (const resource of ['restaurant', 'order', 'attempt', 'balance']) {
  const busy = fixture(); const healthy = fixture()
  query(`update private.online_payment_attempts set expires_at=now()-interval '2 minutes' where id=${literal(busy.attemptId)};
    update private.online_payment_attempts set expires_at=now()-interval '1 minute' where id=${literal(healthy.attemptId)};`)
  const target = {
    restaurant: `public.restaurants where id=${literal(busy.tenant)}`,
    order: `public.orders where id=${literal(busy.orderId)}`,
    attempt: `private.online_payment_attempts where id=${literal(busy.attemptId)}`,
    balance: `public.inventory_balances where product_id=${literal(busy.product)}`,
  }[resource]
  const holder = new Session(`maintenance_${resource}_${randomUUID().slice(0, 8)}`)
  try {
    await holder.command(`begin;select 1 from ${target} for update;`)
    const output = query(`begin;set local statement_timeout='2s';set local lock_timeout='2s';set local role service_role;
      select 'RESULT:'||public.expire_online_reservations_report(now(),1)::text;
      select 'LOCK_TIMEOUT:'||current_setting('lock_timeout');commit;`)
    const report = result(output)
    assert(output.includes('LOCK_TIMEOUT:2s'), 'maintenance must restore the caller lock timeout')
    assert.equal(report.expired, 1)
    assert.equal(report.locked, 1)
    assert.equal(report.failed, 0)
    assert.equal(query(`select reserved from public.inventory_balances where product_id=${literal(healthy.product)};`), '0')
    assert.equal(query(`select reserved from public.inventory_balances where product_id=${literal(busy.product)};`), '1')
    await holder.command('rollback;')
    assert.equal(query(`select public.expire_online_reservations(now(),1);`), '1')
    assert.equal(query(`select reserved from public.inventory_balances where product_id=${literal(busy.product)};`), '0')
    scenarios.push(`${resource} lock: healthy tenant expires before holder releases; skipped hold retries exactly once`)
  } finally {
    await holder.command('rollback;').catch(() => {})
    holder.close()
  }
}

const late = fixture()
query(`update private.online_payment_attempts set expires_at=now()-interval '1 minute' where id=${literal(late.attemptId)};`)
const expirer = new Session(`maintenance_expirer_${randomUUID().slice(0, 8)}`)
const approverName = `maintenance_approver_${randomUUID().slice(0, 8)}`
const approver = new Session(approverName)
try {
  const expired = await expirer.command("begin;set local role service_role;select 'RESULT:'||public.expire_online_reservations()::text;")
  assert.equal(result(expired), 1)
  const approval = approver.command(`begin;set local statement_timeout='12s';set local role service_role;
    select 'RESULT:'||public.reconcile_online_payment(${literal(late.attemptId)},${literal(`synthetic-${late.attemptId}`)},'approved',1000,'ARS',now())::text;commit;`)
  approval.catch(() => {})
  let observed = false
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    observed = query(`select count(*) from pg_stat_activity where application_name=${literal(approverName)} and wait_event_type='Lock';`) === '1'
    if (observed) break
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert(observed, 'approval must wait for the real expiration transaction')
  await expirer.command('commit;')
  assert.equal(result(await approval).paymentStatus, 'approved')
  assert.equal(query(`select reserved from public.inventory_balances where product_id=${literal(late.product)};`), '1')
  assert.equal(query(`select status::text from public.orders where id=${literal(late.orderId)};`), 'generated')
  scenarios.push('expiration first: approval waits, reacquires last unit and restores the order after commit')
} finally {
  await expirer.command('rollback;').catch(() => {})
  await approver.command('rollback;').catch(() => {})
  expirer.close(); approver.close()
}
console.log(JSON.stringify({ database: env.PGDATABASE, passed: true, barriers: 1, nonBlockingRaces: 4, scenarios,
  fixtures: 'synthetic only; retained in isolated database' }))
