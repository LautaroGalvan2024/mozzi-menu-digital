// Two real PostgreSQL writers share an editor revision. Release the winner only
// after PostgreSQL confirms that it is blocking the other writer.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { localDatabaseEnvironment, pgBinary, run, validateLocalDatabaseEnvironment } from './connection.mjs'

const env = localDatabaseEnvironment()
const database = process.argv.find(arg => arg.startsWith('--database='))?.slice('--database='.length)
if (database) env.PGDATABASE = database
validateLocalDatabaseEnvironment(env)
if (env.PGDATABASE.startsWith('mozzi_restore_')) throw new Error('Synthetic fixture database required')
const psql = pgBinary(env, 'psql')
const args = ['-X', '-qAt', '--no-password', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose']
const query = sql => run(psql, args, { env, input: sql }).trim()

const tenant = randomUUID()
const actor = randomUUID()
const category = randomUUID()
const products = [randomUUID(), randomUUID(), randomUUID()]
const slug = `offer-race-${tenant}`
const claims = `set local role authenticated; set local request.jwt.claim.sub='${actor}';`
const winner = [products[2], products[0], products[1]]
const loser = [products[1], products[2], products[0]]
const asArray = ids => `array[${ids.map(id => `'${id}'`).join(',')}]::uuid[]`
const sessions = []

function session(name) {
  const child = spawn(psql, args, { env: { ...env, PGAPPNAME: name }, windowsHide: true, timeout: 20000 })
  const state = { child, name, stdout: '', stderr: '', closed: false }
  child.stdout.on('data', chunk => { state.stdout += chunk })
  child.stderr.on('data', chunk => { state.stderr += chunk })
  state.done = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', code => { state.closed = true; resolve(code) })
  })
  // A spawn error can precede the check of this promise in the barrier.
  state.done.catch(() => {})
  sessions.push(state)
  return state
}

async function until(predicate, description) {
  const deadline = Date.now() + 12000
  while (!predicate()) {
    if (sessions.some(s => s.closed)) throw new Error(`SQL session closed before ${description}: ${sessions.map(s => s.stderr).join(' ')}`)
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}`)
    await delay(50)
  }
}

query(`begin;
  insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data)
    values ('${actor}','${actor}@example.test',now(),'{}');
  insert into public.restaurants(id,name,trade_name,slug,status,whatsapp_phone_e164,order_prefix,store_enabled)
    values ('${tenant}','Offer race','Offer race','${slug}','active','+5491111111111','OFR',true);
  insert into public.restaurant_members(restaurant_id,user_id,role,status) values ('${tenant}','${actor}','restaurant_admin','active');
  insert into public.categories(id,restaurant_id,name,slug) values ('${category}','${tenant}','Offers','offers');
  insert into public.products(id,restaurant_id,category_id,code,name,base_price_cents,promotional_price_cents,sort_order)
    select p,'${tenant}','${category}','SKU-'||i,'Item '||i,2000,1500,i from unnest(${asArray(products)}) with ordinality t(p,i);
  commit;`)

try {
  const revision = query(`begin; ${claims} select public.get_store_offer_order('${tenant}')->>'revision'; commit;`)
  assert.match(revision, /^[0-9a-f]{32}$/)
  const save = ids => `select public.save_store_offer_order('${tenant}','${revision}',${asArray(ids)});`
  const holder = session(`offer-holder-${tenant}`)
  holder.child.stdin.write(`begin; ${claims} ${save(winner)}\n\\echo ORDER_HELD\n`)
  await until(() => holder.stdout.includes('ORDER_HELD'), 'first uncommitted order')
  const waiter = session(`offer-waiter-${tenant}`)
  waiter.child.stdin.end(`begin; ${claims} ${save(loser)} commit;\n`)
  await until(() => query(`select exists (
    select 1 from pg_stat_activity w join pg_stat_activity h on h.pid = any(pg_blocking_pids(w.pid))
    where w.application_name='${waiter.name}' and h.application_name='${holder.name}'
  );`) === 't', 'second writer to wait for the first')
  holder.child.stdin.end('commit;\n')
  assert.equal(await holder.done, 0, holder.stderr)
  assert.equal(await waiter.done, 3, waiter.stderr)
  assert.match(waiter.stderr, /PT409: +STORE_OFFER_ORDER_STALE/)

  const visible = JSON.parse(query(`select public.get_public_store_catalog_page('${slug}','offers')->'items';`))
  assert.deepEqual(visible.map(item => item.id), winner)
} finally {
  for (const s of sessions) if (!s.closed) s.child.kill()
  await Promise.allSettled(sessions.map(s => s.done))
  query(`begin; delete from public.restaurants where id='${tenant}'; delete from auth.users where id='${actor}'; commit;`)
}
console.log(JSON.stringify({ database: env.PGDATABASE, passed: true, blockedWriterRejected: true, publicOrderVerified: true, fixturesRemoved: true }))
