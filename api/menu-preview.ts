const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const PUBLISHABLE_KEY_PATTERN = /^sb_publishable_[A-Za-z0-9_-]{20,}$/
const REQUEST_TIMEOUT_MS = 4_000

export interface MenuPreviewEnvironment {
  supabaseUrl: string | undefined
  supabasePublishableKey: string | undefined
  appBaseUrl: string | undefined
  nodeEnv?: string | undefined
}

export interface MenuPreviewDependencies {
  environment?: MenuPreviewEnvironment
  fetch?: typeof fetch
}

interface RestaurantPreview {
  tradeName: string
  description: string
  slug: string
  logoPath: string | null
  coverPath: string | null
}

interface PreviewConfiguration {
  supabaseUrl: URL
  publishableKey: string
  appBaseUrl: URL
}

function runtimeEnvironment(): MenuPreviewEnvironment {
  const runtime = globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> }
  }
  const environment = runtime.process?.env ?? {}
  return {
    supabaseUrl: environment.VITE_SUPABASE_URL,
    supabasePublishableKey: environment.VITE_SUPABASE_PUBLISHABLE_KEY,
    appBaseUrl: environment.VITE_APP_BASE_URL,
    nodeEnv: environment.NODE_ENV,
  }
}

export function isValidRestaurantSlug(value: string): boolean {
  return value.length >= 2 && value.length <= 80 && SLUG_PATTERN.test(value)
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }
    return entities[character] ?? character
  })
}

export function buildPublicAssetUrl(supabaseUrl: URL, path: string | null): string | null {
  if (!path || path.includes('\\')) return null
  const segments = path.split('/')
  if (
    segments.length < 2 ||
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    return null
  }

  const encodedPath = segments.map((segment) => encodeURIComponent(segment)).join('/')
  return new URL(
    `/storage/v1/object/public/restaurant-assets/${encodedPath}`,
    supabaseUrl,
  ).toString()
}

export function renderMenuPreviewHtml({
  restaurant,
  canonicalUrl,
  imageUrl,
  faviconUrl,
}: {
  restaurant: RestaurantPreview
  canonicalUrl: string
  imageUrl: string
  faviconUrl: string
}): string {
  const title = `${restaurant.tradeName} · Menú digital`
  const description =
    restaurant.description.trim().slice(0, 300) ||
    `Mirá el menú digital de ${restaurant.tradeName} y hacé tu pedido por WhatsApp.`
  const imageAlt = `Imagen de ${restaurant.tradeName}`
  const safe = {
    title: escapeHtml(title),
    description: escapeHtml(description),
    canonicalUrl: escapeHtml(canonicalUrl),
    imageUrl: escapeHtml(imageUrl),
    imageAlt: escapeHtml(imageAlt),
    faviconUrl: escapeHtml(faviconUrl),
    tradeName: escapeHtml(restaurant.tradeName),
  }

  return `<!doctype html>
<html lang="es">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${safe.title}</title>
    <meta name="description" content="${safe.description}" />
    <link rel="canonical" href="${safe.canonicalUrl}" />
    <link rel="icon" href="${safe.faviconUrl}" />
    <meta property="og:title" content="${safe.title}" />
    <meta property="og:description" content="${safe.description}" />
    <meta property="og:type" content="website" />
    <meta property="og:url" content="${safe.canonicalUrl}" />
    <meta property="og:image" content="${safe.imageUrl}" />
    <meta property="og:image:secure_url" content="${safe.imageUrl}" />
    <meta property="og:image:alt" content="${safe.imageAlt}" />
    <meta property="og:site_name" content="Mozzi" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${safe.title}" />
    <meta name="twitter:description" content="${safe.description}" />
    <meta name="twitter:image" content="${safe.imageUrl}" />
    <meta name="twitter:image:alt" content="${safe.imageAlt}" />
  </head>
  <body>
    <main>
      <h1>${safe.tradeName}</h1>
      <p>${safe.description}</p>
      <a href="${safe.canonicalUrl}">Abrir menú digital</a>
    </main>
  </body>
</html>`
}

function parseBaseUrl(value: string | undefined, allowLocalHttp: boolean): URL | null {
  if (!value) return null
  try {
    const url = new URL(value.trim())
    const isLocalhost =
      url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
    if (url.protocol !== 'https:' && !(allowLocalHttp && url.protocol === 'http:' && isLocalhost)) {
      return null
    }
    if (url.username || url.password || url.search || url.hash) return null
    return url
  } catch {
    return null
  }
}

function getConfiguration(environment: MenuPreviewEnvironment): PreviewConfiguration | null {
  const allowLocalHttp = environment.nodeEnv !== 'production'
  const supabaseUrl = parseBaseUrl(environment.supabaseUrl, allowLocalHttp)
  const appBaseUrl = parseBaseUrl(environment.appBaseUrl, allowLocalHttp)
  const publishableKey = environment.supabasePublishableKey?.trim() ?? ''
  if (!supabaseUrl || !appBaseUrl || !PUBLISHABLE_KEY_PATTERN.test(publishableKey)) return null
  return { supabaseUrl, publishableKey, appBaseUrl }
}

function parseRestaurantPreview(value: unknown): RestaurantPreview | null {
  if (!value || typeof value !== 'object') return null
  const restaurant = (value as { restaurant?: unknown }).restaurant
  if (!restaurant || typeof restaurant !== 'object') return null
  const candidate = restaurant as Record<string, unknown>
  if (
    typeof candidate.tradeName !== 'string' ||
    candidate.tradeName.trim().length < 2 ||
    candidate.tradeName.length > 120 ||
    typeof candidate.description !== 'string' ||
    candidate.description.length > 1_200 ||
    typeof candidate.slug !== 'string' ||
    !isValidRestaurantSlug(candidate.slug) ||
    (candidate.logoPath !== null && typeof candidate.logoPath !== 'string') ||
    (candidate.coverPath !== null && typeof candidate.coverPath !== 'string')
  ) {
    return null
  }
  if (
    (typeof candidate.logoPath === 'string' && candidate.logoPath.length > 500) ||
    (typeof candidate.coverPath === 'string' && candidate.coverPath.length > 500)
  ) {
    return null
  }

  return {
    tradeName: candidate.tradeName.trim(),
    description: candidate.description,
    slug: candidate.slug,
    logoPath: candidate.logoPath as string | null,
    coverPath: candidate.coverPath as string | null,
  }
}

async function fetchRestaurantPreview(
  slug: string,
  configuration: PreviewConfiguration,
  fetchImplementation: typeof fetch,
): Promise<RestaurantPreview | null> {
  const endpoint = new URL('/rest/v1/rpc/get_public_menu', configuration.supabaseUrl)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetchImplementation(endpoint, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        apikey: configuration.publishableKey,
        authorization: `Bearer ${configuration.publishableKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ p_restaurant_slug: slug }),
      signal: controller.signal,
    })
    if (!response.ok) throw new Error('PUBLIC_MENU_UNAVAILABLE')
    return parseRestaurantPreview(await response.json())
  } finally {
    clearTimeout(timeout)
  }
}

function errorResponse(status: 404 | 405 | 503, isHeadRequest: boolean): Response {
  const labels = {
    404: 'Not found',
    405: 'Method not allowed',
    503: 'Service unavailable',
  } as const
  const headers = new Headers({
    'cache-control': 'no-store',
    'content-type': 'text/plain; charset=utf-8',
  })
  if (status === 405) headers.set('allow', 'GET, HEAD')
  return new Response(isHeadRequest ? null : labels[status], { status, headers })
}

export async function handleMenuPreviewRequest(
  request: Request,
  dependencies: MenuPreviewDependencies = {},
): Promise<Response> {
  const isHeadRequest = request.method === 'HEAD'
  if (request.method !== 'GET' && !isHeadRequest) return errorResponse(405, false)

  const slug = new URL(request.url).searchParams.get('slug')?.trim() ?? ''
  if (!isValidRestaurantSlug(slug)) return errorResponse(404, isHeadRequest)

  const environment = dependencies.environment ?? runtimeEnvironment()
  const configuration = getConfiguration(environment)
  if (!configuration) return errorResponse(503, isHeadRequest)

  try {
    const restaurant = await fetchRestaurantPreview(
      slug,
      configuration,
      dependencies.fetch ?? fetch,
    )
    if (!restaurant || restaurant.slug !== slug) return errorResponse(404, isHeadRequest)

    const canonicalUrl = new URL(`/r/${encodeURIComponent(restaurant.slug)}`, configuration.appBaseUrl)
      .toString()
    const faviconUrl = new URL('/favicon.svg', configuration.appBaseUrl).toString()
    const imageUrl =
      buildPublicAssetUrl(configuration.supabaseUrl, restaurant.coverPath) ??
      buildPublicAssetUrl(configuration.supabaseUrl, restaurant.logoPath) ??
      faviconUrl
    const html = renderMenuPreviewHtml({
      restaurant,
      canonicalUrl,
      imageUrl,
      faviconUrl,
    })
    return new Response(isHeadRequest ? null : html, {
      status: 200,
      headers: {
        'cache-control': 'public, max-age=0, s-maxage=300, stale-while-revalidate=60',
        'content-type': 'text/html; charset=utf-8',
        'vercel-cdn-cache-control': 'public, s-maxage=300, stale-while-revalidate=60',
      },
    })
  } catch {
    return errorResponse(503, isHeadRequest)
  }
}

export default {
  fetch(request: Request) {
    return handleMenuPreviewRequest(request)
  },
}
