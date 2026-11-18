import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { chromium, request } from '@playwright/test'
import { validateAcceptanceEnvironment, allowedBrowserUrl, guardedRequestContext, installBrowserGuard } from './staging-safety.mjs'

const valid = () => ({ E2E_TARGET: 'local', E2E_STAGING_CONFIRM: 'isolated-synthetic-fixtures',
  E2E_LIVE: '1', E2E_CREATE_ORDER: '1', E2E_BASE_URL: 'http://127.0.0.1:4188', E2E_SUPABASE_URL: 'http://127.0.0.1:54821',
  E2E_RESTAURANT_SLUG: 'synthetic-qa', E2E_PRODUCT_NAME: 'Synthetic item', E2E_ADMIN_EMAIL: 'fixture@example.test',
  E2E_ADMIN_PASSWORD: 'synthetic-test-only', E2E_ACTION_ID: '11111111-1111-4111-8111-111111111111' })

test('acceptance configuration refuses production, incomplete fixtures, ambiguous URLs and unsolicited overrides before launch', () => {
  assert.equal(validateAcceptanceEnvironment(valid()).target, 'local')
  for (const key of Object.keys(valid())) assert.throws(() => validateAcceptanceEnvironment({ ...valid(), [key]: '' }))
  for (const patch of [
    { E2E_BASE_URL: 'https://www.mozzi-comercio.online' }, { E2E_BASE_URL: 'https://preview.mozzi-comercio.online' },
    { E2E_BASE_URL: 'https://mozzi-menu-digital.vercel.app' }, { E2E_SUPABASE_URL: 'https://coqkgyaekenxccbxlozo.supabase.co' },
    { E2E_BASE_URL: 'http://127.0.0.1:4188/' }, { E2E_BASE_URL: 'http://localhost:4188' },
    { E2E_BASE_URL: 'http://user:password@127.0.0.1:4188' }, { E2E_BASE_URL: 'http://127.0.0.1:4188?redirect=remote' },
    { E2E_ACTION_ID: '../../remote' }, { E2E_RESTAURANT_SLUG: '../production' }, { E2E_UNKNOWN: '1' },
  ]) assert.throws(() => validateAcceptanceEnvironment({ ...valid(), ...patch }))
  const staging = { ...valid(), E2E_TARGET: 'staging', E2E_BASE_URL: 'https://qa.example.test',
    E2E_SUPABASE_PROJECT_REF: 'abcdefghijklmnopqrst', E2E_SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co' }
  assert.equal(validateAcceptanceEnvironment(staging).target, 'staging')
  assert.throws(() => validateAcceptanceEnvironment({ ...staging, E2E_SUPABASE_PROJECT_REF: 'coqkgyaekenxccbxlozo' }))
  assert.throws(() => validateAcceptanceEnvironment({ ...staging, E2E_SUPABASE_URL: 'https://different.example.test' }))
})

test('CLI invalid configuration returns a sanitized refusal without starting Playwright', () => {
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith('E2E_')) delete env[key]
  const result = spawnSync(process.execPath, ['scripts/e2e/run-staging.mjs'], { env, encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Invalid or missing E2E_TARGET/)
  assert.equal(result.stdout, '')
  const validated = spawnSync(process.execPath, ['scripts/e2e/run-staging.mjs', '--validate-only'], {
    env: { ...env, ...valid() }, encoding: 'utf8', windowsHide: true,
  })
  assert.equal(validated.status, 0)
  assert.match(validated.stdout, /configuration valid; no services contacted/)
  assert.ok(!validated.stdout.includes(valid().E2E_ADMIN_PASSWORD))
})

test('browser allowlist compares full origins for HTTP and WebSocket, never prefixes or embedded credentials', () => {
  const safety = validateAcceptanceEnvironment(valid())
  for (const url of ['http://127.0.0.1:4188/path', 'http://127.0.0.1:54821/auth/v1/token']) assert.equal(allowedBrowserUrl(url, safety), true)
  for (const url of ['http://127.0.0.1:4189', 'http://127.0.0.1:4188.evil.test', 'https://127.0.0.1:4188', 'http://u:p@127.0.0.1:4188', 'data:text/plain,x']) assert.equal(allowedBrowserUrl(url, safety), false)
  assert.equal(allowedBrowserUrl('ws://127.0.0.1:54821/realtime/v1/websocket', safety, true), true)
  assert.equal(allowedBrowserUrl('wss://evil.example.test/socket', safety, true), false)
})

async function fixture() {
  let forbiddenHits = 0
  const forbidden = createServer((_request, response) => { forbiddenHits++; response.end('outside allowed origins') })
  forbidden.on('upgrade', (_request, socket) => { forbiddenHits++; socket.destroy() })
  forbidden.listen(0, '127.0.0.1'); await once(forbidden, 'listening')
  const forbiddenOrigin = `http://127.0.0.1:${forbidden.address().port}`
  const server = createServer((incoming, response) => {
    if (incoming.url.startsWith('/redirect') || incoming.url.startsWith('/admin/pedidos/tomar/')) {
      response.writeHead(307, { Location: `${forbiddenOrigin}/received` }); response.end(); return
    }
    response.setHeader('Content-Type', incoming.url === '/worker.js' ? 'text/javascript' : 'text/html')
    response.end(incoming.url === '/worker.js' ? `fetch('${forbiddenOrigin}/service-worker')` : '<!doctype html><title>synthetic local fixture</title>')
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const origin = `http://127.0.0.1:${server.address().port}`
  return { origin, forbiddenOrigin, hits: () => forbiddenHits,
    safety: { appOrigin: origin, apiOrigin: origin, actionId: valid().E2E_ACTION_ID },
    close: async () => { server.closeAllConnections(); forbidden.closeAllConnections(); await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => forbidden.close(resolve))]) },
  }
}

test('real APIRequestContext cannot follow GET redirects or post to arbitrary methods, endpoints or fixture IDs', async () => {
  const local = await fixture()
  const raw = await request.newContext()
  try {
    const guarded = guardedRequestContext(raw, local.safety)
    await assert.rejects(guarded.get(`/admin/pedidos/tomar/${local.safety.actionId}`), /API redirect response/)
    assert.equal(local.hits(), 0)
    await assert.rejects(guarded.get(`${local.forbiddenOrigin}/received`), /API request method/)
    await assert.rejects(guarded.post('/rest/v1/rpc/get_order_by_action', { data: { p_action_id: 'different' } }), /fixture identity/)
    assert.throws(() => guarded.fetch, /context operation refused/)
    await assert.rejects(guarded.get(`/admin/pedidos/tomar/${local.safety.actionId}`, { maxRedirects: 2 }), /redirect policy/)
    assert.equal(local.hits(), 0)
  } finally { await raw.dispose(); await local.close() }
})

test('real Chromium blocks direct requests, redirect escapes, WebSockets and service workers before reaching forbidden listener', async () => {
  const local = await fixture()
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ serviceWorkers: 'block' })
  try {
    const verify = await installBrowserGuard(context, local.safety)
    const page = await context.newPage()
    await page.goto(local.origin)
    const escaped = await page.evaluate(async endpoint => {
      try { await fetch(endpoint); return true } catch { return false }
    }, `${local.forbiddenOrigin}/direct`)
    assert.equal(escaped, false)
    await assert.rejects(page.goto(`${local.origin}/redirect`))
    const secondPage = await context.newPage()
    await secondPage.goto(local.origin)
    await secondPage.evaluate(endpoint => new Promise(resolve => {
      const socket = new WebSocket(endpoint.replace('http:', 'ws:'))
      socket.onclose = () => resolve(false); socket.onerror = () => resolve(false); socket.onopen = () => resolve(true)
    }), `${local.forbiddenOrigin}/socket`)
    await secondPage.evaluate(async () => { try { await navigator.serviceWorker.register('/worker.js') } catch { /* Expected policy denial. */ } })
    assert.equal(context.serviceWorkers().length, 0)
    assert.equal(local.hits(), 0)
    assert.throws(verify, /browser network isolation/)
  } finally { await browser.close(); await local.close() }
})
