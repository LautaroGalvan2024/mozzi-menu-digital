// Real local Supabase services only. Run after `supabase start` and `supabase db reset --local`.
// Fixtures are synthetic and retained with their append-only audit trail until `supabase stop --no-backup`.
// No response bodies, credentials, user identities, capability tokens or function logs are printed.
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

class SmokeFailure extends Error {}
const check = (condition, message) => { if (!condition) throw new SmokeFailure(message) }
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
const withEdgeHost = process.argv.includes('--with-edge-host')
const withEdge = withEdgeHost || process.argv.includes('--with-edge')
const cli = existsSync('node_modules/supabase/dist/supabase.js')
  ? { binary: process.execPath, prefix: ['node_modules/supabase/dist/supabase.js'] }
  : { binary: 'supabase', prefix: [] }
const cliEnvironment = { ...process.env }
for (const key of Object.keys(cliEnvironment)) {
  if (/^(SUPABASE_|PG(?:HOST|HOSTADDR|PORT|USER|PASSWORD|DATABASE|SERVICE|SERVICEFILE))/.test(key)) delete cliEnvironment[key]
}
let stage = 'local status validation'
let assertions = 0
let edgeProcess
let temporaryDirectory
let temporaryEnvironmentFile
let temporaryLauncherFile
const hostEdgeProcesses = []
const hostEdgeTargets = new Map()
let api
let anonymousKey
let serviceKey
const origin = 'http://127.0.0.1:5173'

function localUrl(raw, protocols) {
  let url
  try { url = new URL(raw) } catch { throw new SmokeFailure('Local CLI URL is missing or malformed') }
  check(protocols.includes(url.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Refusing non-loopback Supabase endpoint')
  return url
}

function pass(label) {
  assertions++
  console.log(`HTTP smoke: PASS ${label}`)
}

async function http(route, { method = 'POST', token, service = false, body, headers = {}, raw = false } = {}) {
  // All routes are relative to the validated local API, and redirects can never forward credentials.
  check(route.startsWith('/') && !route.startsWith('//'), 'Relative local route required')
  if (withEdgeHost && route.startsWith('/functions/')) check(hostEdgeTargets.has(route), 'Unknown host Edge route is forbidden')
  const target = hostEdgeTargets.get(route) ?? new URL(route, api)
  check(target.origin === api.origin || hostEdgeTargets.get(route) === target, 'Refusing endpoint outside local API or assigned handler')
  const key = service ? serviceKey : anonymousKey
  const response = await fetch(target, {
    method, redirect: 'error', signal: AbortSignal.timeout(20_000),
    headers: { apikey: key, ...(token || service ? { Authorization: `Bearer ${token ?? serviceKey}` } : {}),
      ...(body !== undefined && !raw ? { 'Content-Type': 'application/json' } : {}), ...headers },
    ...(body === undefined ? {} : { body: raw ? body : JSON.stringify(body) }),
  })
  const bytes = new Uint8Array(await response.arrayBuffer())
  let data = null
  try { data = JSON.parse(new TextDecoder().decode(bytes)) } catch { /* Binary Storage response or empty success. */ }
  return { status: response.status, ok: response.ok, data, bytes, headers: response.headers }
}

function accepted(result, label) {
  check(result.ok, `${label}: HTTP ${result.status}${/^[A-Z0-9_]{1,50}$/.test(result.data?.code ?? '') ? ` (${result.data.code})` : ''}`)
  return result.data
}

function denied(result, label, statuses = [401, 403]) {
  check(statuses.includes(result.status), `${label}: expected access denial, received HTTP ${result.status}`)
}

async function rpc(name, body, token, service = false) {
  return http(`/rest/v1/rpc/${name}`, { body, token, service })
}

async function seed(table, body) {
  accepted(await http(`/rest/v1/${table}`, { service: true, body, headers: { Prefer: 'return=minimal' } }), `synthetic ${table} fixture`)
}

async function startEdge(status) {
  const values = Object.values(status).filter(value => typeof value === 'string')
  check(values.some(value => value.startsWith('sb_publishable_')) && values.some(value => value.startsWith('sb_secret_')),
    'Edge smoke requires modern local publishable/secret keys from Supabase CLI status; no legacy-key workaround or skip')
  temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'mozzi-http-smoke-'))
  temporaryEnvironmentFile = path.join(temporaryDirectory, 'edge.env')
  // CLI injects its own local SUPABASE_* key maps. Do not override production authentication behavior.
  writeFileSync(temporaryEnvironmentFile, [
    `APP_BASE_URL=${origin}`, `APP_ALLOWED_ORIGINS=${origin}`, 'APP_SECRET_KEY_NAME=default',
    `RATE_LIMIT_HASH_SECRET=${randomBytes(48).toString('hex')}`, 'TURNSTILE_ENABLED=false',
  ].join('\n'), { mode: 0o600 })
  edgeProcess = spawn(cli.binary, [...cli.prefix, 'functions', 'serve', '--env-file', temporaryEnvironmentFile], {
    env: cliEnvironment, windowsHide: true, stdio: 'ignore',
  })
  let failed = false
  edgeProcess.on('error', () => { failed = true })
  for (let attempt = 0; attempt < 45; attempt++) {
    check(!failed && edgeProcess.exitCode === null, 'Local Edge server exited; raw process logs withheld')
    try {
      const ready = await http('/functions/v1/recover-order', { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' } })
      if (ready.status === 204 && ready.headers.get('access-control-allow-origin') === origin) return
    } catch { /* Bounded readiness retry, before any business request. */ }
    await pause(2_000)
  }
  throw new SmokeFailure('Local Edge server readiness timeout; no tests skipped')
}

async function startHostEdge(status) {
  const values = Object.values(status).filter(value => typeof value === 'string')
  const publishable = values.find(value => value.startsWith('sb_publishable_'))
  const secret = values.find(value => value.startsWith('sb_secret_'))
  check(publishable && secret, 'Host Edge smoke requires modern local publishable/secret keys; no legacy-key workaround or skip')
  temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'mozzi-http-smoke-'))
  temporaryLauncherFile = path.join(temporaryDirectory, 'edge-host.mjs')
  // This changes only the HTTP listener's host/port. The imported handler and all service clients are original.
  writeFileSync(temporaryLauncherFile, `const originalServe = Deno.serve.bind(Deno);
Object.defineProperty(Deno, 'serve', { configurable: true, value(handler) {
  if (typeof handler !== 'function') throw new Error('Unexpected original Deno.serve contract');
  return originalServe({ hostname: '127.0.0.1', port: 0, onListen({ port }) {
    Deno.stdout.writeSync(new TextEncoder().encode('MOZZI_EDGE_READY:' + port + '\\n'));
  } }, handler);
} });
await import(Deno.args[0]);
`, { mode: 0o600 })
  const env = { ...cliEnvironment, SUPABASE_URL: api.origin,
    SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: publishable }),
    SUPABASE_SECRET_KEYS: JSON.stringify({ default: secret }), APP_SECRET_KEY_NAME: 'default',
    APP_BASE_URL: origin, APP_ALLOWED_ORIGINS: origin,
    RATE_LIMIT_HASH_SECRET: randomBytes(48).toString('hex'), TURNSTILE_ENABLED: 'false',
  }
  for (const handler of ['import-products', 'create-order', 'recover-order']) {
    const child = spawn('deno', ['run', '--no-prompt', '--allow-env', '--allow-net=127.0.0.1,localhost,[::1]',
      `--allow-read=${process.cwd()},${temporaryDirectory}`, '--config', path.resolve('supabase/functions/deno.json'),
      '--lock', path.resolve('supabase/functions/deno.lock'), '--frozen', temporaryLauncherFile,
      pathToFileURL(path.resolve(`supabase/functions/${handler}/index.ts`)).href,
    ], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    hostEdgeProcesses.push(child)
    const port = await new Promise((resolve, reject) => {
      let buffered = ''
      const timeout = setTimeout(() => reject(new SmokeFailure(`Host handler ${handler} startup timed out; raw logs withheld`)), 90_000)
      const fail = () => { clearTimeout(timeout); reject(new SmokeFailure(`Host handler ${handler} exited before ready; raw logs withheld`)) }
      child.once('error', fail)
      child.once('exit', fail)
      child.stdout.on('data', chunk => {
        buffered = (buffered + chunk.toString('utf8')).slice(-4096)
        const lines = buffered.split('\n'); buffered = lines.pop() ?? ''
        for (const line of lines) {
          const match = /^MOZZI_EDGE_READY:([0-9]{1,5})\r?$/.exec(line)
          if (!match) continue // Never relay application logs or other stdout.
          const value = Number(match[1])
          if (value > 0 && value <= 65535) { clearTimeout(timeout); resolve(value) }
        }
      })
    })
    const route = `/functions/v1/${handler}`
    hostEdgeTargets.set(route, localUrl(`http://127.0.0.1:${port}${route}`, ['http:']))
    const preflight = await http(route, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' } })
    check(preflight.status === 204 && preflight.headers.get('access-control-allow-origin') === origin, `Host handler ${handler} CORS contract mismatch`)
  }
}

async function main() {
  check(process.argv.slice(2).every(value => ['--with-edge', '--with-edge-host'].includes(value)) && !(withEdgeHost && process.argv.includes('--with-edge')),
    'Only one explicit Edge mode is accepted; remote URL/credential overrides are forbidden')
  const statusResult = spawnSync(cli.binary, [...cli.prefix, 'status', '-o', 'json'], {
    env: cliEnvironment, windowsHide: true, encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
  })
  check(!statusResult.error && statusResult.status === 0, 'Local Supabase status unavailable; start the disposable local stack first (raw output withheld)')
  let status
  try { status = JSON.parse(statusResult.stdout) } catch { throw new SmokeFailure('Supabase status did not return JSON; raw output withheld') }
  api = localUrl(status.API_URL, ['http:'])
  check(!api.username && !api.password && api.pathname === '/' && !api.search && !api.hash, 'Unexpected local API URL components')
  localUrl(status.DB_URL, ['postgres:', 'postgresql:'])
  anonymousKey = status.ANON_KEY ?? status.PUBLISHABLE_KEY
  serviceKey = status.SERVICE_ROLE_KEY ?? status.SECRET_KEY
  check(typeof anonymousKey === 'string' && typeof serviceKey === 'string', 'Local API credentials unavailable')
  pass('API and database endpoints are loopback; CLI credentials remain in memory')
  if (withEdge) {
    stage = withEdgeHost ? 'host Edge handler startup' : 'local Edge startup'
    if (withEdgeHost) await startHostEdge(status)
    else await startEdge(status)
    pass(withEdgeHost ? 'original Deno handlers on exclusive loopback listeners and CORS preflight' : 'real Edge runtime and CORS preflight')
  }

  stage = 'Auth fixtures and login'
  const suffix = randomUUID().replaceAll('-', '').slice(0, 14)
  const users = []
  for (const role of ['admin', 'other', 'manager']) {
    const password = `Aa1!${randomBytes(24).toString('hex')}`
    const email = `http-smoke-${suffix}-${role}@example.test`
    const created = accepted(await http('/auth/v1/admin/users', { service: true,
      body: { email, password, email_confirm: true, user_metadata: { full_name: 'Synthetic HTTP smoke' } } }), 'Auth admin fixture')
    const login = accepted(await http('/auth/v1/token?grant_type=password', { body: { email, password } }), 'password login')
    check(login.user?.id === created.id && typeof login.access_token === 'string', 'Login identity/token mismatch')
    const current = accepted(await http('/auth/v1/user', { method: 'GET', token: login.access_token }), 'Auth getUser')
    check(current.id === created.id, 'Auth session identity mismatch')
    users.push({ id: created.id, token: login.access_token })
  }
  const [admin, other, manager] = users
  pass('three synthetic users log in through GoTrue and validate real sessions')
  const a = randomUUID(), b = randomUUID(), category = randomUUID(), product = randomUUID(), payment = randomUUID()
  const slug = `http-smoke-${suffix}`
  stage = 'synthetic tenant fixture'
  await seed('restaurants', [a, b].map((id, index) => ({ id, name: 'Synthetic HTTP smoke', trade_name: 'Synthetic HTTP smoke',
    slug: index === 0 ? slug : `${slug}-other`, status: 'active', whatsapp_phone_e164: '+5491111111111',
    address: 'Synthetic', city: 'Synthetic', timezone: 'UTC', order_prefix: 'HSM', public_menu_enabled: true,
    created_by: index === 0 ? admin.id : other.id })))
  await seed('restaurant_members', [
    { restaurant_id: a, user_id: admin.id, role: 'restaurant_admin', status: 'active', invited_by: admin.id },
    { restaurant_id: b, user_id: other.id, role: 'restaurant_admin', status: 'active', invited_by: other.id },
    { restaurant_id: a, user_id: manager.id, role: 'order_manager', status: 'active', invited_by: admin.id },
  ])
  await seed('categories', { id: category, restaurant_id: a, name: 'Smoke', slug: 'smoke', created_by: admin.id, updated_by: admin.id })
  await seed('payment_methods', { id: payment, restaurant_id: a, code: 'cash', name: 'Synthetic cash' })
  await seed('business_hours', Array.from({ length: 7 }, (_, day) => ({ restaurant_id: a, day_of_week: day, slot_index: 0, opens_at: '00:00', closes_at: '24:00' })))

  stage = 'membership and tenant isolation'
  const authorization = accepted(await rpc('get_actor_authorization', {}, admin.token), 'actor authorization')
  check(authorization.userId === admin.id && authorization.memberships?.length === 1 && authorization.memberships[0].restaurantId === a, 'JWT membership contract mismatch')
  const own = accepted(await http(`/rest/v1/restaurants?select=id&id=eq.${a}`, { method: 'GET', token: admin.token }), 'own tenant select')
  const hidden = accepted(await http(`/rest/v1/restaurants?select=id&id=eq.${a}`, { method: 'GET', token: other.token }), 'other tenant select')
  check(own.length === 1 && hidden.length === 0, 'Tenant RLS boundary mismatch')
  denied(await rpc('get_inventory', { p_restaurant_id: a }, other.token), 'foreign inventory')
  denied(await http('/rest/v1/profiles?select=id', { method: 'GET' }), 'anonymous profile read')
  pass('JWT-derived memberships, RLS tenant isolation and anonymous privilege denial')

  stage = 'catalogue RPC and SKU'
  const save = { p_restaurant_id: a, p_product: { id: product, categoryId: category, name: 'Synthetic product', basePriceCents: 1000 }, p_groups: [] }
  const saved = accepted(await rpc('save_product_catalog', save, admin.token), 'save catalogue')
  check(saved.productId === product && /^P-[0-9]{6,}$/.test(saved.code), 'Generated SKU response mismatch')
  const repeated = accepted(await rpc('save_product_catalog', save, admin.token), 'save same draft UUID')
  check(repeated.productId === product && repeated.code === saved.code, 'Draft retry changed product/SKU')
  denied(await rpc('save_product_catalog', save, manager.token), 'manager catalogue write')
  denied(await rpc('save_product_catalog', save, other.token), 'foreign catalogue write')
  denied(await http(`/rest/v1/products?id=eq.${product}`, { method: 'PATCH', token: admin.token, body: { code: 'BYPASS' } }), 'direct SKU write')
  pass('catalogue RPC allocates stable SKU and rejects role/tenant/direct-write bypasses')

  stage = 'import batch replay'
  const batch = randomUUID()
  const products = [{ rowRef: '2', name: 'Synthetic imported product', category: 'Smoke', basePriceCents: 1200 }]
  const importBody = { p_restaurant_id: a, p_rows: { batchId: batch, products, optionGroups: [], options: [] }, p_mode: 'upsert' }
  const imported = accepted(await rpc('import_products_batch', importBody, admin.token), 'import batch')
  const replay = accepted(await rpc('import_products_batch', importBody, admin.token), 'replay batch')
  const recoveredImport = accepted(await rpc('get_catalog_import_result', { p_restaurant_id: a, p_batch_id: batch }, admin.token), 'recover import result')
  check(imported.summary?.created === 1 && imported.products?.length === 1 && JSON.stringify(imported) === JSON.stringify(replay) && JSON.stringify(imported) === JSON.stringify(recoveredImport), 'Import replay/recovery contract mismatch')
  const changed = structuredClone(importBody); changed.p_rows.products[0].name = 'Changed request'
  const conflict = await rpc('import_products_batch', changed, admin.token)
  check(!conflict.ok && conflict.data?.message === 'IMPORT_IDEMPOTENCY_CONFLICT', 'Changed batch did not reject conflicting content')
  pass('HTTP import replay/recovery preserve IDs and conflicting content is rejected')
  if (withEdge) {
    const edgeImport = { restaurantId: a, batchId: batch, mode: 'create_or_update', products, groups: [], options: [] }
    const edgeReplay = accepted(await http('/functions/v1/import-products', { token: admin.token, body: edgeImport, headers: { Origin: origin } }), 'Edge import replay')
    check(edgeReplay.batchId === batch && edgeReplay.products?.[0]?.id === imported.products[0].id, 'Edge import response lost batch/product identity')
    denied(await http('/functions/v1/import-products', { token: manager.token, body: edgeImport, headers: { Origin: origin } }), 'Edge manager import')
    pass('Edge validates real Auth session, imports through user RPC and denies manager')
  }

  stage = 'Storage service and policies'
  const image = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j/aQAAAAASUVORK5CYII=', 'base64'))
  const objectPath = `restaurants/${a}/products/http-smoke-${suffix}.png`
  accepted(await http(`/storage/v1/object/restaurant-assets/${objectPath}`, { token: admin.token, body: image, raw: true, headers: { 'Content-Type': 'image/png' } }), 'Storage authorized upload')
  const publicImage = await http(`/storage/v1/object/public/restaurant-assets/${objectPath}`, { method: 'GET' })
  check(publicImage.ok && Buffer.from(publicImage.bytes).equals(Buffer.from(image)), 'Public Storage image bytes mismatch')
  for (const [label, token] of [['other tenant', other.token], ['manager', manager.token], ['anonymous', undefined]]) {
    denied(await http(`/storage/v1/object/restaurant-assets/restaurants/${a}/products/${randomUUID()}.png`, {
      token, body: image, raw: true, headers: { 'Content-Type': 'image/png' },
    }), `Storage ${label} write`, [400, 401, 403])
  }
  accepted(await http('/storage/v1/object/restaurant-assets', { method: 'DELETE', token: admin.token, body: { prefixes: [objectPath] } }), 'Storage owner delete')
  const removedImage = await http(`/storage/v1/object/public/restaurant-assets/${objectPath}`, { method: 'GET' })
  check([400, 404].includes(removedImage.status), 'Storage owner delete did not remove the uploaded image')
  pass('Storage real upload/public bytes/delete and unauthorized write denials')

  stage = 'stock activation in synthetic tenant'
  accepted(await rpc('confirm_inventory_business_policy', { p_restaurant_id: a, p_policy: {
    unitModel: 'whole_product', sourceOfTruth: 'app', otherChannels: 'none', returns: 'full_only', partialDeliveries: 'none',
    physicalScope: 'until_handoff_including_transit', acceptance: 'reserve', delivery: 'physical_handoff', acceptedReservationsExpire: false,
  } }, admin.token), 'synthetic policy confirmation')
  const countId = randomUUID()
  const count = accepted(await rpc('begin_inventory_count', { p_restaurant_id: a, p_operation_id: countId, p_reason: 'Synthetic HTTP opening count' }, admin.token), 'begin physical count')
  const inventory = accepted(await rpc('get_inventory', { p_restaurant_id: a }, admin.token), 'inventory contract')
  check(inventory.items.length === 2 && inventory.policy.cutoverId === countId, 'Count scope/cutover response mismatch')
  const countedAt = count.startedAt // Database clock establishes the valid boundary, independent of CI clock skew.
  accepted(await rpc('finish_inventory_count', { p_count_id: countId, p_rows: inventory.items.map(item => ({ productId: item.productId, quantity: 5, countedAt })),
    p_pending_order_ids: [], p_no_movements_confirmed: true, p_note: 'Synthetic fixtures only; no physical channel has movements', p_activate: true,
  }, admin.token), 'finish synthetic count')
  pass('authenticated inventory policy/count contracts activate only the synthetic tenant')

  stage = 'order creation, recovery and inventory transitions'
  const request = { restaurantSlug: slug, idempotencyKey: randomUUID(), customer: { name: 'Synthetic HTTP customer', phone: '+5492222222222' },
    fulfillment: { type: 'pickup' }, paymentMethodId: payment, items: [{ productId: product, quantity: 2, optionIds: [] }] }
  let created
  if (withEdge) {
    const body = { ...request, antiSpam: { formStartedAt: new Date(Date.now() - 5_000).toISOString() } }
    created = accepted(await http('/functions/v1/create-order', { body, headers: { Origin: origin } }), 'Edge create order')
    const retry = accepted(await http('/functions/v1/create-order', { body, headers: { Origin: origin } }), 'Edge order retry')
    check(retry.order?.actionId === created.order?.actionId && retry.idempotentReplay === true && created.recoveryToken !== retry.recoveryToken, 'Edge idempotency/capability retry mismatch')
    const recovered = accepted(await http('/functions/v1/recover-order', { body: { actionId: created.order.actionId, recoveryToken: created.recoveryToken }, headers: { Origin: origin } }), 'Edge recovery')
    check(recovered.order.actionId === created.order.actionId && recovered.whatsapp.url === created.whatsapp.url && recovered.clientEventToken === null, 'Recovery response/readonly capability mismatch')
    const unavailable = await http('/functions/v1/recover-order', { body: { actionId: randomUUID(), recoveryToken: created.recoveryToken }, headers: { Origin: origin } })
    check(unavailable.status === 404 && unavailable.data?.error?.code === 'RECOVERY_NOT_AVAILABLE', 'Recovery allowed wrong action ID or changed uniform error contract')
    pass('Edge creation/retry/recovery connects canonical DB response with distinct readonly capability')
  } else {
    created = accepted(await rpc('create_order_transaction', { p_request: request, p_ip_hash: 'a'.repeat(64), p_phone_hash: 'b'.repeat(64), p_client_event_token_hash: 'c'.repeat(64) }, undefined, true), 'service-only order RPC')
  }
  const actionId = created.order.actionId
  const found = accepted(await http(`/rest/v1/orders?select=id,status,inventory_tracked&action_id=eq.${actionId}`, { method: 'GET', token: admin.token }), 'operator order read')
  check(found.length === 1 && found[0].status === 'generated' && found[0].inventory_tracked, 'Generated inventory order contract mismatch')
  denied(await rpc('claim_order', { p_action_id: actionId }, other.token), 'foreign claim')
  accepted(await rpc('claim_order', { p_action_id: actionId }, manager.token), 'manager claim')
  const reserved = accepted(await rpc('get_inventory', { p_restaurant_id: a }, admin.token), 'reserved stock')
  const item = reserved.items.find(value => value.productId === product)
  check(item.onHand === '5' && item.reserved === '2' && item.available === '3', 'Reservation balance contract mismatch')
  accepted(await rpc('complete_order', { p_order_id: found[0].id }, manager.token), 'manager handoff')
  const completed = accepted(await rpc('get_inventory', { p_restaurant_id: a }, admin.token), 'delivered stock')
  const finalItem = completed.items.find(value => value.productId === product)
  check(finalItem.onHand === '3' && finalItem.reserved === '0' && finalItem.available === '3', 'Handoff stock balance contract mismatch')
  pass('order managers reserve and hand off over HTTP; foreign tenant cannot claim')
  console.log(JSON.stringify({ passed: true, assertions, edge: withEdgeHost ? 'original handlers on host Deno; hosted container not covered' : withEdge ? 'local CLI runtime' : 'not run',
    services: ['Auth', 'PostgREST', 'Storage', ...(withEdge ? ['Edge handlers'] : [])], fixtures: 'synthetic; discarded with local stack' }))
}

try { await main() }
catch (error) {
  console.error(`HTTP smoke: FAIL ${stage}: ${error instanceof SmokeFailure ? error.message : 'request/process failure; raw diagnostics withheld'}`)
  process.exitCode = 1
} finally {
  for (const child of [...hostEdgeProcesses, ...(edgeProcess ? [edgeProcess] : [])]) {
    if (child.exitCode !== null) continue
    child.kill('SIGTERM')
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), pause(5_000)])
    if (child.exitCode === null) child.kill('SIGKILL')
  }
  if (temporaryEnvironmentFile) unlinkSync(temporaryEnvironmentFile)
  if (temporaryLauncherFile) unlinkSync(temporaryLauncherFile)
  if (temporaryDirectory) rmdirSync(temporaryDirectory)
}
