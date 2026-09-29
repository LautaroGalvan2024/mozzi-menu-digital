import { describe, expect, it, vi } from 'vitest'
import {
  buildPublicAssetUrl,
  escapeHtml,
  handleMenuPreviewRequest,
  isValidRestaurantSlug,
  renderMenuPreviewHtml,
} from '../../api/menu-preview'

const environment = {
  supabaseUrl: 'https://project.supabase.co',
  supabasePublishableKey: `sb_publishable_${'a'.repeat(24)}`,
  appBaseUrl: 'https://menu.example.com',
  nodeEnv: 'production',
}

function publicMenuPayload(paths: { coverPath?: string | null; logoPath?: string | null } = {}) {
  return {
    restaurant: {
      tradeName: 'La Rotisería',
      description: 'Comida casera para compartir.',
      slug: 'la-rotiseria',
      coverPath:
        'coverPath' in paths ? paths.coverPath ?? null : 'restaurants/demo/cover/portada.webp',
      logoPath: 'logoPath' in paths ? paths.logoPath ?? null : 'restaurants/demo/logo/logo.webp',
    },
    categories: [],
  }
}

describe('menu preview metadata', () => {
  it('validates slugs with the same public restaurant contract', () => {
    expect(isValidRestaurantSlug('la-rotiseria')).toBe(true)
    expect(isValidRestaurantSlug('A-Rotiseria')).toBe(false)
    expect(isValidRestaurantSlug('../rotiseria')).toBe(false)
    expect(isValidRestaurantSlug('a'.repeat(81))).toBe(false)
  })

  it('escapes restaurant content and encodes public asset path segments', () => {
    expect(escapeHtml('Mozzi <script> & "amigos"')).toBe(
      'Mozzi &lt;script&gt; &amp; &quot;amigos&quot;',
    )
    expect(
      buildPublicAssetUrl(
        new URL('https://project.supabase.co'),
        'restaurants/demo/cover/foto principal.webp',
      ),
    ).toBe(
      'https://project.supabase.co/storage/v1/object/public/restaurant-assets/restaurants/demo/cover/foto%20principal.webp',
    )
    expect(
      buildPublicAssetUrl(new URL('https://project.supabase.co'), '../private/secret.webp'),
    ).toBeNull()
  })

  it('renders the required Open Graph metadata without raw HTML from the database', () => {
    const html = renderMenuPreviewHtml({
      restaurant: {
        ...publicMenuPayload().restaurant,
        tradeName: 'Mozzi <script>alert(1)</script>',
      },
      canonicalUrl: 'https://menu.example.com/r/la-rotiseria',
      imageUrl: 'https://project.supabase.co/cover.webp',
      faviconUrl: 'https://menu.example.com/favicon.svg',
    })

    expect(html).toContain('property="og:title"')
    expect(html).toContain('property="og:image"')
    expect(html).toContain('https://project.supabase.co/cover.webp')
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('Mozzi &lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('uses the published cover and canonical production URL through the public RPC', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(publicMenuPayload()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const response = await handleMenuPreviewRequest(
      new Request('https://menu.example.com/api/menu-preview?slug=la-rotiseria'),
      { environment, fetch: fetchMock },
    )
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toContain('s-maxage=300')
    expect(html).toContain('https://menu.example.com/r/la-rotiseria')
    expect(html).toContain(
      'https://project.supabase.co/storage/v1/object/public/restaurant-assets/restaurants/demo/cover/portada.webp',
    )
    expect(fetchMock).toHaveBeenCalledOnce()
    const [endpoint, options] = fetchMock.mock.calls[0] ?? []
    expect(endpoint?.toString()).toBe('https://project.supabase.co/rest/v1/rpc/get_public_menu')
    expect(options?.method).toBe('POST')
    expect(options?.body).toBe(JSON.stringify({ p_restaurant_slug: 'la-rotiseria' }))
  })

  it('falls back to the logo, rejects unpublished menus and never serves unsupported methods', async () => {
    const logoFetch = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(publicMenuPayload({ coverPath: null })),
    )
    const logoResponse = await handleMenuPreviewRequest(
      new Request('https://menu.example.com/api/menu-preview?slug=la-rotiseria'),
      { environment, fetch: logoFetch },
    )
    expect(await logoResponse.text()).toContain('/restaurants/demo/logo/logo.webp')

    const missingResponse = await handleMenuPreviewRequest(
      new Request('https://menu.example.com/api/menu-preview?slug=la-rotiseria'),
      {
        environment,
        fetch: vi.fn<typeof fetch>().mockResolvedValue(Response.json(null)),
      },
    )
    expect(missingResponse.status).toBe(404)

    const methodResponse = await handleMenuPreviewRequest(
      new Request('https://menu.example.com/api/menu-preview?slug=la-rotiseria', {
        method: 'POST',
      }),
      { environment, fetch: logoFetch },
    )
    expect(methodResponse.status).toBe(405)
    expect(methodResponse.headers.get('allow')).toBe('GET, HEAD')
  })
})
