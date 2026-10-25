// PostgreSQL integration/concurrency checks for a disposable loopback DB.
// Reads .env.database.local via the shared, local-only connection helper.
// Fixtures remain for inspection; no schema resets or remote access occur.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { localDatabaseEnvironment } from './database/connection.mjs'

const env = localDatabaseEnvironment()
if (env.PGSERVICE || env.PGSERVICEFILE || env.PGHOSTADDR && !['127.0.0.1', '::1'].includes(env.PGHOSTADDR)) throw new Error('libpq service and non-loopback address overrides are forbidden')
const sessions = new Set()
class Session {
  constructor(label) {
    this.name = `inventory_${label}_${randomUUID()}`
    this.output = ''; this.stderr = ''; this.pending = null; this.closed = false
    this.process = spawn(path.join(env.PG_BIN, 'psql.exe'), ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'], {
      env: { ...env, PGAPPNAME: this.name, PGCONNECT_TIMEOUT: '5', PGOPTIONS: '-c statement_timeout=15000 -c lock_timeout=10000' },
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    })
    sessions.add(this)
    this.process.stdout.on('data', chunk => {
      this.output += chunk.toString()
      if (this.pending && this.output.includes(this.pending.marker)) {
        const { marker, resolve } = this.pending
        const result = this.output.slice(0, this.output.indexOf(marker)).trim()
        this.output = this.output.slice(this.output.indexOf(marker) + marker.length).trim()
        this.pending = null; resolve(result)
      }
    })
    this.process.stderr.on('data', chunk => { this.stderr += chunk.toString() })
    this.process.on('error', error => { this.pending?.reject(error); this.pending = null })
    this.process.on('exit', code => {
      this.closed = true
      this.pending?.reject(new Error(`psql exited ${code}: ${this.stderr.trim()}`))
      this.pending = null; sessions.delete(this)
    })
  }
  query(sql) {
    assert.ok(!this.pending && !this.closed)
    this.stderr = ''
    const marker = `inventory_end_${randomUUID()}`
    return new Promise((resolve, reject) => {
      this.pending = { marker, resolve, reject }
      this.process.stdin.write(`${sql}\nselect '${marker}';\n`)
    })
  }
  close() { if (!this.closed && !this.process.stdin.writableEnded) this.process.stdin.end('rollback;\n\\q\n') }
}
const observer = new Session('observer')
function actor(f) {
  return `select set_config('request.jwt.claim.sub','${f.admin}',true);select set_config('request.jwt.claims','{"sub":"${f.admin}","role":"authenticated","aal":"aal1"}',true);set local role authenticated;`
}
function rpc(f, sql) { return `${actor(f)} ${sql} reset role;` }
function counts(f) {
  return `jsonb_build_array(jsonb_build_object('productId','${f.productA}','quantity',${f.stock},'countedAt',clock_timestamp()),jsonb_build_object('productId','${f.productB}','quantity',${f.stock},'countedAt',clock_timestamp()))`
}
function activate(f) {
  return rpc(f, `select public.confirm_inventory_business_policy('${f.tenant}','{"unitModel":"whole_product","sourceOfTruth":"app","otherChannels":"record_before_handoff","returns":"full_only","partialDeliveries":"none","physicalScope":"until_handoff_including_transit","acceptance":"reserve","delivery":"physical_handoff","acceptedReservationsExpire":false}');
    select public.begin_inventory_count('${f.tenant}','${f.count}','Synthetic initial frozen count');
    select public.finish_inventory_count('${f.count}',${counts(f)},array['${f.orderA}','${f.orderB}']::uuid[],true,'Synthetic immutable physical-count boundary',true);`)
}
function rawOrder(f, key, product, quantity, secondProduct, secondQuantity) {
  const total = (quantity + (secondQuantity || 0)) * 100
  return `insert into public.orders(id,action_id,restaurant_id,idempotency_key,display_number,customer_name,customer_phone,fulfillment_type,payment_method_id,payment_method_name_snapshot,payment_adjustment_type_snapshot,payment_adjustment_scope_snapshot,payment_adjustment_bps_snapshot,payment_adjustment_fixed_cents_snapshot,subtotal_cents,total_cents,currency_code)
    values('${f[`order${key}`]}','${f[`action${key}`]}','${f.tenant}','${randomUUID()}','IC-${key}','Synthetic','+5494444444444','pickup','${f.payment}','Cash','none','subtotal',0,0,${total},${total},'ARS');
    insert into public.order_items(restaurant_id,order_id,product_id,product_code_snapshot,product_name_snapshot,quantity,unit_price_cents,line_total_cents,base_subtotal_cents,pricing_mode_snapshot,pricing_breakdown_snapshot)
    values('${f.tenant}','${f[`order${key}`]}','${product}','SYNTHETIC','Synthetic product',${quantity},100,${quantity * 100},${quantity * 100},'unit','{}')${secondProduct ? `,('${f.tenant}','${f[`order${key}`]}','${secondProduct}','SYNTHETIC','Synthetic product',${secondQuantity},100,${secondQuantity * 100},${secondQuantity * 100},'unit','{}')` : ''};`
}
async function fixture({ active = true, multi = false } = {}) {
  const f = Object.fromEntries(['tenant', 'admin', 'category', 'productA', 'productB', 'payment', 'orderA', 'orderB', 'actionA', 'actionB', 'count', 'operation', 'newKey'].map(key => [key, randomUUID()]))
  f.stock = multi ? 10 : 5
  await observer.query(`begin;
    insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values('${f.admin}','stock-${f.admin}@example.test',now(),'{}');
    insert into public.restaurants(id,name,trade_name,slug,status,whatsapp_phone_e164,address,city,order_prefix,public_menu_enabled,created_by)
    values('${f.tenant}','Stock concurrency','Stock concurrency','stock-${f.tenant}','active','+5491111111111','Synthetic','Synthetic','SIC',true,'${f.admin}');
    insert into public.restaurant_members(restaurant_id,user_id,role,status,invited_by) values('${f.tenant}','${f.admin}','restaurant_admin','active','${f.admin}');
    insert into public.categories(id,restaurant_id,name,slug,created_by,updated_by) values('${f.category}','${f.tenant}','Stock','stock','${f.admin}','${f.admin}');
    insert into public.products(id,restaurant_id,category_id,code,name,base_price_cents,created_by,updated_by) values
    ('${f.productA}','${f.tenant}','${f.category}','A','Product A',100,'${f.admin}','${f.admin}'),('${f.productB}','${f.tenant}','${f.category}','B','Product B',100,'${f.admin}','${f.admin}');
    insert into public.payment_methods(id,restaurant_id,code,name) values('${f.payment}','${f.tenant}','cash','Cash');
    insert into public.business_hours(restaurant_id,day_of_week,slot_index,opens_at,closes_at) select '${f.tenant}',d,0,'00:00'::time,'23:59'::time from generate_series(0,6) d;
    ${rawOrder(f, 'A', f.productA, 4, multi ? f.productB : null, 3)}
    ${rawOrder(f, 'B', multi ? f.productB : f.productA, 4, multi ? f.productA : null, 3)}
    ${active ? activate(f) : ''}
    commit;`)
  return f
}
const claim = (f, key = 'A') => rpc(f, `select public.claim_order('${f[`action${key}`]}');`)
const complete = (f, key = 'A') => rpc(f, `select public.complete_order('${f[`order${key}`]}');`)
const cancel = (f, key = 'A') => rpc(f, `select public.cancel_order('${f[`order${key}`]}','Synthetic cancellation');`)
const pause = f => rpc(f, `select public.change_inventory_policy('${f.tenant}','paused','Synthetic contingency',(select inventory_version from public.restaurants where id='${f.tenant}'));`)
const policyLock = f => `select id from public.restaurants where id='${f.tenant}' for update;`
const orderLock = (f, key = 'A') => `select id from public.restaurants where id='${f.tenant}' for share;select id from public.orders where id='${f[`order${key}`]}' for update;`
const newOrder = f => `set local role service_role;select public.create_order_transaction('${JSON.stringify({ restaurantSlug: `stock-${f.tenant}`, idempotencyKey: f.newKey, customer: { name: 'Synthetic', phone: '+5494444444444' }, fulfillment: { type: 'pickup' }, paymentMethodId: f.payment, items: [{ productId: f.productA, quantity: 1, optionIds: [] }] })}',repeat('a',64),repeat('b',64),repeat('c',64));reset role;`
const receipt = f => rpc(f, `select public.inventory_adjust('${f.tenant}','${f.operation}','receipt','[{"productId":"${f.productA}","quantity":2,"expectedVersion":1}]','Synthetic supplier receipt');`)
const reverse = f => rpc(f, `select public.reverse_order_inventory('${f.orderA}','${f.operation}','correction',true,'Synthetic false handoff');`)
async function verifyBalance(f, onHand, reserved, product = f.productA) {
  assert.equal(await observer.query(`select on_hand::text||'/'||reserved::text from public.inventory_balances where restaurant_id='${f.tenant}' and product_id='${product}';`), `${onHand}/${reserved}`)
  assert.equal(await observer.query(`select count(*) from public.inventory_balances b where b.restaurant_id='${f.tenant}' and (b.on_hand<>(select coalesce(sum(delta_on_hand),0) from public.inventory_movements where restaurant_id=b.restaurant_id and product_id=b.product_id) or b.reserved<>(select coalesce(sum(delta_reserved),0) from public.inventory_movements where restaurant_id=b.restaurant_id and product_id=b.product_id));`), '0')
}
async function barrier(b) {
  const until = Date.now() + 8000
  while (Date.now() < until) {
    if (await observer.query(`select exists(select 1 from pg_catalog.pg_stat_activity where application_name='${b.name}' and state='active' and wait_event_type='Lock');`) === 't') return
    assert.ok(!b.closed, 'contender exited before reaching lock barrier')
    await delay(20)
  }
  throw new Error('No observable PostgreSQL lock wait')
}
let passed = 0
async function race(name, { options, prepare, lock = orderLock, first, second, error, result, verify }) {
  const f = await fixture(options)
  if (prepare) await observer.query(`begin;${prepare(f)}commit;`)
  const a = new Session('holder'), b = new Session('contender')
  try {
    await a.query(`begin;${lock(f)}`)
    const pending = b.query(`begin;${second(f)}commit;`).then(output => ({ output }), failure => ({ failure }))
    await barrier(b)
    await a.query(`${first(f)}commit;`)
    const outcome = await pending
    if (error) { assert.ok(outcome.failure, `${name}: contender unexpectedly succeeded`); assert.match(outcome.failure.message, new RegExp(error)) }
    else { if (outcome.failure) throw outcome.failure; if (result) assert.match(outcome.output, result) }
    await verify(f)
    passed += 1
    console.log(`PASS ${name} (independent connections; lock wait observed)`)
  } finally { a.close(); b.close() }
}

try {
  await race('two acceptances compete for last available units', {
    lock: f => `${orderLock(f)}select product_id from public.inventory_balances where restaurant_id='${f.tenant}' and product_id='${f.productA}' for update;`,
    first: claim, second: f => claim(f, 'B'), error: 'INSUFFICIENT_STOCK', verify: f => verifyBalance(f, 5, 4),
  })
  await race('same delivery commits only once', { prepare: claim, first: complete, second: complete, result: /"alreadyDelivered": true/, verify: f => verifyBalance(f, 1, 0) })
  await race('cancellation wins before physical delivery', { prepare: claim, first: cancel, second: complete, result: /"completed": false/, verify: f => verifyBalance(f, 5, 0) })
  await race('physical delivery wins before cancellation', { prepare: claim, first: complete, second: cancel, result: /"cancelled": false/, verify: f => verifyBalance(f, 1, 0) })
  await race('pause serializes before acceptance', { lock: policyLock, first: pause, second: claim, error: 'INVENTORY_PAUSED', verify: f => verifyBalance(f, 5, 0) })
  await race('pause serializes before delivery', { prepare: claim, lock: policyLock, first: pause, second: complete, error: 'INVENTORY_PAUSED', verify: f => verifyBalance(f, 5, 4) })
  await race('pause blocks current order-creation RPC', { lock: policyLock, first: pause, second: newOrder, error: 'INVENTORY_PAUSED', verify: async f => assert.equal(await observer.query(`select count(*) from public.orders where restaurant_id='${f.tenant}';`), '2') })
  await race('policy version is rechecked after a concurrent policy lock wait', { lock: policyLock, first: pause, second: pause, error: 'INVENTORY_VERSION_CONFLICT',
    verify: async f => assert.equal(await observer.query(`select inventory_mode::text||'/'||inventory_version::text from public.restaurants where id='${f.tenant}';`), 'paused/3') })
  await race('initial count blocks legacy order-creation RPC', { options: { active: false }, lock: policyLock,
    first: f => rpc(f, `select public.begin_inventory_count('${f.tenant}','${f.count}','Synthetic initial count');`), second: newOrder, error: 'INVENTORY_CUTOVER',
    verify: async f => assert.equal(await observer.query(`select count(*) from public.orders where restaurant_id='${f.tenant}';`), '2') })
  await race('activation serializes new orders into controlled snapshot', { options: { active: false }, lock: policyLock, first: activate, second: newOrder,
    verify: async f => assert.equal(await observer.query(`select inventory_tracked from public.orders where restaurant_id='${f.tenant}' and idempotency_key='${f.newKey}';`), 't') })
  await race('identical supplier receipts have one effect', {
    lock: f => `select id from public.restaurants where id='${f.tenant}' for share;select pg_advisory_xact_lock(hashtext('${f.tenant}'),hashtext('${f.operation}'));`,
    first: receipt, second: receipt, result: /"replayed": true/, verify: f => verifyBalance(f, 7, 0),
  })
  await race('same correction restores stock only once', { prepare: f => claim(f) + complete(f), first: reverse, second: reverse, result: /"replayed": true/, verify: f => verifyBalance(f, 5, 0) })
  await race('same external reference with distinct operation IDs cannot double count', {
    lock: f => `select id from public.restaurants where id='${f.tenant}' for share;select pg_advisory_xact_lock(hashtext('inventory-external:${f.tenant}'),hashtext('COUNTER-001'));`,
    first: f => rpc(f, `select public.inventory_adjust('${f.tenant}','${f.operation}','external_sale','[{"productId":"${f.productA}","quantity":1,"expectedVersion":1}]','Synthetic counter handoff','COUNTER-001');`),
    second: f => rpc(f, `select public.inventory_adjust('${f.tenant}','${f.newKey}','external_sale','[{"productId":"${f.productA}","quantity":1,"expectedVersion":1}]','Synthetic counter handoff','COUNTER-001');`),
    error: 'INVENTORY_EXTERNAL_REFERENCE_DUPLICATE', verify: f => verifyBalance(f, 4, 0),
  })
  await race('two orders with reversed SKU order acquire balances consistently', { options: { multi: true }, prepare: f => claim(f) + claim(f, 'B'),
    lock: f => `${orderLock(f)}select product_id from public.inventory_balances where restaurant_id='${f.tenant}' order by product_id for update;`,
    first: complete, second: f => complete(f, 'B'), verify: async f => { await verifyBalance(f, 3, 0); await verifyBalance(f, 3, 0, f.productB) },
  })
  await race('frozen recount blocks ordinary supplier receipt', { prepare: pause, lock: policyLock,
    first: f => rpc(f, `select public.begin_inventory_count('${f.tenant}','${randomUUID()}','Synthetic frozen recount');`), second: receipt, error: 'INVENTORY_CUTOVER', verify: f => verifyBalance(f, 5, 0) })
  console.log(`PASS ${passed} inventory concurrency scenarios; synthetic fixtures retained in isolated DB.`)
} finally {
  for (const session of sessions) session.close()
}
