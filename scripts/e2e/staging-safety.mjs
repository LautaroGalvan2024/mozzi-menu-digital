// This module is deliberately pure: validate every input before starting a browser,
// opening a file, or contacting a service. Production identifiers are public and
// documented in docs/deployment.md; they are never valid acceptance targets.
const productionRef = 'coqkgyaekenxccbxlozo'
const productionDomains = ['mozzi-comercio.online', 'mozzi-menu-digital.vercel.app']
export const acceptedEnvironmentKeys = Object.freeze([
  'E2E_TARGET', 'E2E_STAGING_CONFIRM', 'E2E_LIVE', 'E2E_CREATE_ORDER',
  'E2E_BASE_URL', 'E2E_SUPABASE_URL', 'E2E_SUPABASE_PROJECT_REF',
  'E2E_RESTAURANT_ID', 'E2E_RESTAURANT_SLUG', 'E2E_PRODUCT_NAME', 'E2E_ADMIN_EMAIL', 'E2E_ADMIN_PASSWORD', 'E2E_ACTION_ID',
])

export class AcceptanceSafetyError extends Error {}
const requireValue = (condition, field) => {
  if (!condition) throw new AcceptanceSafetyError(`Invalid or missing ${field}; acceptance run refused`)
}

function origin(value, field) {
  let url
  try { url = new URL(value) } catch { throw new AcceptanceSafetyError(`Invalid ${field}; acceptance run refused`) }
  requireValue(url.origin === value && !url.username && !url.password && !url.search && !url.hash, field)
  requireValue(!productionDomains.some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`)), field)
  requireValue(url.hostname !== `${productionRef}.supabase.co`, field)
  return url
}

export function validateAcceptanceEnvironment(env) {
  for (const key of Object.keys(env)) {
    requireValue(!key.startsWith('E2E_') || acceptedEnvironmentKeys.includes(key), 'E2E environment key')
  }
  requireValue(env.E2E_TARGET === 'staging' || env.E2E_TARGET === 'local', 'E2E_TARGET')
  requireValue(env.E2E_STAGING_CONFIRM === 'isolated-synthetic-fixtures', 'E2E_STAGING_CONFIRM')
  requireValue(env.E2E_LIVE === '1' && env.E2E_CREATE_ORDER === '1', 'E2E_LIVE / E2E_CREATE_ORDER')
  const app = origin(env.E2E_BASE_URL, 'E2E_BASE_URL')
  const api = origin(env.E2E_SUPABASE_URL, 'E2E_SUPABASE_URL')
  requireValue(app.origin !== api.origin, 'separate application and API origins')
  if (env.E2E_TARGET === 'local') {
    requireValue(app.origin === 'http://127.0.0.1:4188' && api.origin === 'http://127.0.0.1:54821', 'explicit local QA origins')
    requireValue(!env.E2E_SUPABASE_PROJECT_REF || env.E2E_SUPABASE_PROJECT_REF === 'local', 'E2E_SUPABASE_PROJECT_REF')
  } else {
    requireValue(/^[a-z]{20}$/.test(env.E2E_SUPABASE_PROJECT_REF ?? '') && env.E2E_SUPABASE_PROJECT_REF !== productionRef, 'E2E_SUPABASE_PROJECT_REF')
    requireValue(api.origin === `https://${env.E2E_SUPABASE_PROJECT_REF}.supabase.co`, 'E2E_SUPABASE_URL')
    requireValue(app.protocol === 'https:' && !app.port && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(app.hostname)
      && app.hostname.includes('.') && !app.hostname.endsWith('.supabase.co') && !/^[\d.]+$/.test(app.hostname)
      && !app.hostname.endsWith('.localhost') && !app.hostname.endsWith('.local'), 'E2E_BASE_URL')
  }
  requireValue(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(env.E2E_RESTAURANT_SLUG ?? '') && env.E2E_RESTAURANT_SLUG.length <= 100, 'E2E_RESTAURANT_SLUG')
  requireValue(typeof env.E2E_PRODUCT_NAME === 'string' && env.E2E_PRODUCT_NAME.trim() === env.E2E_PRODUCT_NAME
    && env.E2E_PRODUCT_NAME.length > 0 && env.E2E_PRODUCT_NAME.length <= 200 && !/[\r\n\0]/.test(env.E2E_PRODUCT_NAME), 'E2E_PRODUCT_NAME')
  requireValue(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(env.E2E_ADMIN_EMAIL ?? '') && env.E2E_ADMIN_EMAIL.length <= 254, 'E2E_ADMIN_EMAIL')
  requireValue(typeof env.E2E_ADMIN_PASSWORD === 'string' && env.E2E_ADMIN_PASSWORD.length >= 8
    && env.E2E_ADMIN_PASSWORD.length <= 1024 && !/[\r\n\0]/.test(env.E2E_ADMIN_PASSWORD), 'E2E_ADMIN_PASSWORD')
  requireValue(/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(env.E2E_ACTION_ID ?? ''), 'E2E_ACTION_ID')
  if (env.E2E_RESTAURANT_ID !== undefined) requireValue(/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(env.E2E_RESTAURANT_ID), 'E2E_RESTAURANT_ID')
  return Object.freeze({ target: env.E2E_TARGET, appOrigin: app.origin, apiOrigin: api.origin, actionId: env.E2E_ACTION_ID })
}

export function allowedBrowserUrl(raw, safety, websocket = false) {
  try {
    const url = new URL(raw)
    if (url.username || url.password) return false
    if (websocket) {
      if (!['ws:', 'wss:'].includes(url.protocol)) return false
      url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'
    } else if (!['http:', 'https:'].includes(url.protocol)) return false
    return url.origin === safety.appOrigin || url.origin === safety.apiOrigin
  } catch { return false }
}

export function validateApiRequest(method, input, options, safety) {
  let url
  try { url = new URL(String(input), safety.appOrigin) } catch { throw new AcceptanceSafetyError('API request target refused') }
  requireValue(!url.username && !url.password && !url.search && !url.hash, 'API request target')
  const claim = method === 'get' && url.origin === safety.appOrigin && url.pathname === `/admin/pedidos/tomar/${safety.actionId}`
  const readOrder = method === 'post' && url.origin === safety.apiOrigin && url.pathname === '/rest/v1/rpc/get_order_by_action'
    && options?.data && typeof options.data === 'object' && !Array.isArray(options.data)
    && Object.keys(options.data).length === 1 && options.data.p_action_id === safety.actionId
  requireValue(claim || readOrder, 'API request method, path or fixture identity')
  requireValue(options?.maxRedirects === undefined || options.maxRedirects === 0, 'API redirect policy')
  requireValue(options?.ignoreHTTPSErrors !== true && options?.params === undefined && options?.form === undefined && options?.multipart === undefined, 'API request options')
  return url.href
}

export function guardedRequestContext(request, safety) {
  return new Proxy(request, {
    get(target, property) {
      if (property === 'then') return undefined // Fixture resolution must not treat the context as a Promise.
      if (property === 'get' || property === 'post') return async (input, options = {}) => {
        const url = validateApiRequest(property, input, options, safety)
        const response = await target[property](url, { ...options, maxRedirects: 0, maxRetries: 0, timeout: 30_000 })
        requireValue(response.status() < 300 || response.status() >= 400, 'API redirect response')
        return response
      }
      if (property === 'dispose') return target.dispose.bind(target)
      throw new AcceptanceSafetyError('API context operation refused by acceptance policy')
    },
  })
}

export async function installBrowserGuard(context, safety) {
  let denied = 0
  await context.route('**/*', async route => {
    if (!allowedBrowserUrl(route.request().url(), safety)) { denied++; await route.abort('blockedbyclient'); return }
    try {
      // Never let Playwright/Chromium follow an uninspected redirect. Fetching with
      // zero redirects also protects headers on 307/308 POST redirects.
      const response = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: 30_000 })
      if (response.status() >= 300 && response.status() < 400) { denied++; await route.abort('blockedbyclient'); return }
      await route.fulfill({ response })
    } catch { denied++; await route.abort('failed').catch(() => {}) }
  })
  await context.routeWebSocket(/.*/, route => {
    if (allowedBrowserUrl(route.url(), safety, true)) route.connectToServer()
    else { denied++; route.close({ code: 1008, reason: 'Acceptance network policy' }) }
  })
  return () => requireValue(denied === 0, 'browser network isolation (a request or redirect was blocked)')
}
