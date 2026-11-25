import { expect, type Page } from '@playwright/test'
import { resolve } from 'node:path'
import { routePublicCatalog } from './public-catalog-fixture'
import { disabledStageOneFeatures } from './stage-one-fixture'

const id = (n: number) => `36000000-0000-4000-8000-${String(n).padStart(12, '0')}`
export const restaurantId = id(1)
const userId = id(2)
const categoryId = id(3)
export const slug = 'despensa-del-parque'
const timestamp = '2026-11-08T12:00:00.000Z'
export const items = [
  { id: id(10), name: 'Pizza mozzarella congelada', price: 850000, image_path: 'products/pizza-mozzarella.webp' },
  { id: id(11), name: 'Limonada artesanal', price: 250000, image_path: 'products/limonada.webp' },
  { id: id(12), name: 'Empanadas de horno', price: 630000, image_path: null },
  { id: id(13), name: 'Papas prefritas', price: 390000, image_path: 'products/papas-fritas.webp' },
]

export function offerOrderState(count = items.length) {
  return { ids: items.slice(0, count).map(item => item.id), revision: 1, writes: 0 }
}

export async function offerOrderFixture(page: Page, state = offerOrderState(), storeEnabled = true) {
  const restaurant = {
    id: restaurantId, name: 'Despensa del Parque', trade_name: 'Despensa del Parque', slug,
    description: 'Alimentos y bebidas para todos los días.', status: 'active',
    whatsapp_phone_e164: '+5493492123456', address: 'San Martín 123', city: 'Rafaela',
    timezone: 'America/Argentina/Cordoba', currency_code: 'ARS', locale: 'es-AR', logo_path: null, cover_path: null,
    primary_color: '#246748', secondary_color: '#edf6ef', delivery_enabled: true, pickup_enabled: true,
    minimum_order_cents: 0, default_preparation_minutes: 30, public_menu_enabled: true, store_enabled: storeEnabled,
    updated_at: timestamp,
  }
  const products = items.map((item, index) => ({
    id: item.id, categoryId, name: item.name, description: '', code: `ALM-${index + 1}`,
    basePriceCents: Math.ceil(item.price * 1.2), promotionalPriceCents: state.ids.includes(item.id) ? item.price : null,
    promotionStartsAt: null, promotionEndsAt: null, imagePath: item.image_path, available: true, featured: false,
    sortOrder: index, quantityPrices: [], optionGroups: [], family: null, variantAttributes: {},
  }))
  const user = { id: userId, aud: 'authenticated', role: 'authenticated', email: 'admin@example.invalid', app_metadata: {}, user_metadata: {}, factors: [], created_at: timestamp }
  const expiresAt = Math.floor(Date.now() / 1000) + 3600
  const token = [
    Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify({ sub: userId, aud: 'authenticated', role: 'authenticated', aal: 'aal1', exp: expiresAt })).toString('base64url'),
    Buffer.from('synthetic-signature').toString('base64url'),
  ].join('.')
  await page.addInitScript(({ session, selected }) => {
    localStorage.setItem('sb-e2e-auth-token', JSON.stringify(session))
    localStorage.setItem('mozzi:selected-restaurant', selected)
  }, { session: { user, access_token: token, refresh_token: 'synthetic-refresh', token_type: 'bearer', expires_in: 3600, expires_at: expiresAt }, selected: restaurantId })
  await page.routeWebSocket('wss://e2e.invalid/**', socket => socket.close())
  const unexpected: string[] = []
  await page.route('https://e2e.invalid/**', async route => {
    const req = route.request()
    const path = new URL(req.url()).pathname
    const membership = { restaurantId, status: 'active', role: 'restaurant_admin' }
    if (req.method() === 'GET') {
      if (path === '/auth/v1/user') return route.fulfill({ json: user })
      if (path === '/rest/v1/profiles') return route.fulfill({ json: { id: userId, full_name: 'Administración Despensa', email: user.email, active: true } })
      if (path === '/rest/v1/restaurants') return route.fulfill({ json: restaurant })
      if (path === '/rest/v1/restaurant_members') return route.fulfill({ json: [{ id: id(4), restaurant_id: restaurantId, role: membership.role, status: membership.status, restaurants: restaurant }] })
      if (path === '/rest/v1/products') return route.fulfill({ json: products.map(product => ({
        id: product.id, name: product.name, code: product.code, description: product.description, image_path: product.imagePath,
        base_price_cents: product.basePriceCents, promotional_price_cents: product.promotionalPriceCents, category_id: categoryId,
        active: true, available: true, featured: false, sort_order: product.sortOrder, categories: { name: 'Almacén' },
      })) })
      const image = items.find(item => item.image_path && path.endsWith('/' + item.image_path))?.image_path
      if (image) return route.fulfill({ path: resolve('scripts/catalog-seed/images', image.split('/').pop()!), contentType: 'image/webp' })
    }
    if (req.method() === 'POST') {
      if (path.endsWith('/get_actor_authorization')) return route.fulfill({ json: { userId, isSuperAdmin: false, aal: 'aal1', memberships: [membership] } })
      if (path.endsWith('/get_stage_one_features')) return route.fulfill({ json: disabledStageOneFeatures })
      if (path.endsWith('/get_public_campaigns')) return route.fulfill({ json: { items: [], serverNow: timestamp, validUntil: null } })
      if (path.endsWith('/get_store_offer_order')) {
        expect(req.postDataJSON()).toEqual({ p_restaurant_id: restaurantId })
        return route.fulfill({ json: { revision: String(state.revision), items: state.ids.map(key => items.find(item => item.id === key)!) } })
      }
      if (path.endsWith('/save_store_offer_order')) {
        const input = req.postDataJSON()
        expect(input.p_restaurant_id).toBe(restaurantId)
        if (input.p_expected_revision !== String(state.revision)) {
          return route.fulfill({ status: 409, json: { code: '40001', message: 'STORE_OFFER_ORDER_STALE' } })
        }
        expect([...input.p_group_ids].sort()).toEqual([...state.ids].sort())
        state.ids = input.p_group_ids
        state.revision += 1
        state.writes += 1
        return route.fulfill({ json: null })
      }
    }
    unexpected.push(req.method() + ' ' + path)
    return route.fulfill({ status: 404, json: { message: 'Unexpected request in offer order fixture' } })
  })
  await routePublicCatalog(page, {
    restaurant: { id: restaurantId, name: restaurant.name, tradeName: restaurant.trade_name, slug, description: restaurant.description,
      whatsappPhone: restaurant.whatsapp_phone_e164, address: restaurant.address, city: restaurant.city, timezone: restaurant.timezone,
      currencyCode: restaurant.currency_code, locale: restaurant.locale, logoPath: null, coverPath: null, primaryColor: restaurant.primary_color,
      secondaryColor: restaurant.secondary_color, deliveryEnabled: true, pickupEnabled: true, minimumOrderCents: 0, defaultPreparationMinutes: 30,
      isOpen: true, acceptsOrders: true, nextOpeningAt: null, channel: 'store', storeCheckoutWhatsappEnabled: true, storeCheckoutOnlineEnabled: false },
    categories: [{ id: categoryId, name: 'Almacén', slug: 'almacen', description: '', imagePath: null, sortOrder: 0, products }],
    businessHours: [], specialHours: [], deliveryZones: [], paymentMethods: [],
  }, slug, 'store', () => state.ids)
  return { state, unexpected }
}
