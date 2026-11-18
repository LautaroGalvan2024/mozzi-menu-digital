// Real PostgreSQL sessions + observed lock waits; synthetic loopback data only.
// Fixtures retain append-only history in an isolated test DB; no Storage HTTP or provider calls.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { localDatabaseEnvironment, pgBinary, run } from './connection.mjs'

const env = localDatabaseEnvironment()
const database = process.argv.find(value => value.startsWith('--database='))
if (database) env.PGDATABASE = database.slice('--database='.length)
if (!/^mozzi_[a-z0-9_]+$/.test(env.PGDATABASE) || env.PGDATABASE.startsWith('mozzi_restore_')) {
  throw new Error('Synthetic test database required; never seed a recovery database')
}
const executable = pgBinary(env, 'psql')
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

function fixture() {
  const f = Object.fromEntries(['tenant', 'actor', 'category', 'product', 'family', 'payment'].map(key => [key, randomUUID()]))
  f.slug = `asset-hours-race-${f.tenant}`
  f.path = `restaurants/${f.tenant}/products/race-1200.webp`
  query(`begin;
    insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data)
      values(${literal(f.actor)},${literal(`asset-hours-${f.actor}@example.test`)},now(),'{}');
    insert into public.restaurants(id,name,trade_name,slug,status,whatsapp_phone_e164,order_prefix,public_menu_enabled)
      values(${literal(f.tenant)},'Synthetic asset race','Synthetic',${literal(f.slug)},'active','+5491111111111','RAC',true);
    insert into public.restaurant_members(restaurant_id,user_id,role,status)
      values(${literal(f.tenant)},${literal(f.actor)},'restaurant_admin','active');
    insert into public.categories(id,restaurant_id,name,slug)
      values(${literal(f.category)},${literal(f.tenant)},'Cases','cases');
    insert into public.product_families(id,restaurant_id,category_id,code,name,axes)
      values(${literal(f.family)},${literal(f.tenant)},${literal(f.category)},'FAMILY','Family',array['Color']);
    insert into public.products(id,restaurant_id,category_id,code,name,base_price_cents,family_id,variant_attributes)
      values(${literal(f.product)},${literal(f.tenant)},${literal(f.category)},'CASE','Case',1000,${literal(f.family)},'{"Color":"Blue"}');
    insert into public.payment_methods(id,restaurant_id,code,name)
      values(${literal(f.payment)},${literal(f.tenant)},'cash','Cash');
    insert into public.business_hours(restaurant_id,day_of_week,slot_index,opens_at,closes_at)
      select ${literal(f.tenant)},d,0,'00:00'::time,'23:59:59.999999'::time from generate_series(0,6)d;
    insert into storage.objects(bucket_id,name,metadata)
      values('restaurant-assets',${literal(f.path)},'{"mimetype":"image/webp"}');
    commit;`)
  return f
}

function prepare(f) {
  return `${auth(f.actor)} select 'RESULT:'||public.prepare_image_asset_cleanup(${literal(f.tenant)},${literal(f.path)})::text;`
}
function attach(f) {
  return `${auth(f.actor)} update public.products set image_path=${literal(f.path)} where id=${literal(f.product)};`
}
function familySave(f) {
  return `${auth(f.actor)} select 'RESULT:'||public.save_product_family(${literal(f.tenant)},
    ${json({ id: f.family, categoryId: f.category, name: 'Edited family', code: 'FAMILY', axes: ['Color'] })},
    ${json([{ productId: f.product, attributes: { Color: 'Blue' } }])})::text;`
}
function checkout(f) {
  const request = { restaurantSlug: f.slug, idempotencyKey: randomUUID(),
    customer: { name: 'Synthetic Buyer', phone: '+5491111111111' }, fulfillment: { type: 'pickup' },
    paymentMethodId: f.payment, items: [{ productId: f.product, quantity: 1, optionIds: [] }] }
  return `set local role service_role; select 'RESULT:'||public.create_order_transaction(${json(request)},repeat('a',64),repeat('b',64),repeat('c',64))::text;`
}

async function race(firstSql, secondSql, expectedError, whileBlocked) {
  const name = `asset_hours_${randomUUID().slice(0, 8)}`
  const first = new Session(`${name}_holder`); const second = new Session(`${name}_waiter`)
  try {
    const firstResult = await first.command(`begin;set local statement_timeout='12s';${firstSql}`)
    const pending = second.command(`begin;set local statement_timeout='12s';${secondSql}commit;`)
    pending.catch(() => {})
    await barrier(`${name}_waiter`)
    if (whileBlocked) whileBlocked(`${name}_waiter`)
    await first.command('commit;')
    if (expectedError) { await assert.rejects(pending, expectedError); return [firstResult, null] }
    return [firstResult, await pending]
  } finally {
    await first.command('rollback;').catch(() => {})
    if (!second.closed) await second.command('rollback;').catch(() => {})
    first.close(); second.close()
  }
}

const assignmentFirst = fixture()
const [, retained] = await race(attach(assignmentFirst), prepare(assignmentFirst))
assert.equal(result(retained).retained, true)
assert.equal(query(`select count(*) from private.image_asset_cleanup_requests where restaurant_id=${literal(assignmentFirst.tenant)};`), '0')

const cleanupFirst = fixture()
await race(prepare(cleanupFirst), attach(cleanupFirst), /IMAGE_ASSET_RETIRED/)
assert.equal(query(`select count(*) from public.products where id=${literal(cleanupFirst.product)} and image_path is null;`), '1')
assert.equal(query(`select count(*) from storage.objects where name=${literal(cleanupFirst.path)};`), '1')

const closureFirst = fixture()
const closed = `${auth(closureFirst.actor)} insert into public.special_hours(restaurant_id,date,slot_index,is_closed)
  values(${literal(closureFirst.tenant)},'2099-01-01',0,true);`
const open = `${auth(closureFirst.actor)} insert into public.special_hours(restaurant_id,date,slot_index,is_closed,opens_at,closes_at)
  values(${literal(closureFirst.tenant)},'2099-01-01',1,false,'09:00','18:00');`
await race(closed, open, /special_hours_closed_date_exclusive/)
assert.equal(query(`select count(*) from public.special_hours where restaurant_id=${literal(closureFirst.tenant)};`), '1')

const checkoutFirst = fixture()
await race(checkout(checkoutFirst), familySave(checkoutFirst), undefined, name => {
  // A legacy implementation reached its family UPSERT before waiting. The fixed
  // RPC must wait on the restaurant before acquiring the family write relation.
  assert.equal(query(`select count(*) from pg_locks l join pg_stat_activity a on a.pid=l.pid
    where a.application_name=${literal(name)} and l.relation='public.product_families'::regclass
      and l.mode='RowExclusiveLock' and l.granted;`), '0')
})
assert.equal(query(`select count(*) from public.orders where restaurant_id=${literal(checkoutFirst.tenant)};`), '1')

const familyFirst = fixture()
await race(familySave(familyFirst), checkout(familyFirst))
assert.equal(query(`select product_name_snapshot from public.order_items where restaurant_id=${literal(familyFirst.tenant)};`), 'Edited family · Blue')

console.log(JSON.stringify({ database: env.PGDATABASE, passed: true, barriers: 5, scenarios: [
  'assignment commits first: cleanup waits then retains referenced file without a tombstone',
  'cleanup commits first: assignment waits then rejects retired path; no bytes deleted in test',
  'direct concurrent opening cannot bypass a committed full-day closure',
  'legacy family RPC waits for checkout at the restaurant before any family write lock',
  'checkout waits for legacy family edit and snapshots its committed metadata',
], fixtures: 'synthetic only; retained with immutable history; no external services' }))
