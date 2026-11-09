import type { Page, Route } from '@playwright/test'

type JsonRecord = Record<string, unknown>

function catalogGroups(catalog: JsonRecord, categoryId: string | null, search: string | null) {
  const categories = Array.isArray(catalog.categories) ? catalog.categories as JsonRecord[] : []
  const phrase = search?.trim().toLocaleLowerCase('es') ?? ''
  const groups = new Map<string, JsonRecord>()
  for (const category of categories) {
    if (categoryId && category.id !== categoryId) continue
    const products = Array.isArray(category.products) ? category.products as JsonRecord[] : []
    for (const product of products) {
      const family = product.family && typeof product.family === 'object' ? product.family as JsonRecord : null
      const attributes = product.variantAttributes && typeof product.variantAttributes === 'object'
        ? Object.values(product.variantAttributes as JsonRecord).join(' ')
        : ''
      const searchable = `${family?.name ?? ''} ${family?.description ?? ''} ${product.name ?? ''} ${product.description ?? ''} ${product.code ?? ''} ${attributes}`.toLocaleLowerCase('es')
      if (phrase && !searchable.includes(phrase)) continue
      const id = String(family?.id ?? product.id)
      const current = groups.get(id) ?? { id, categoryId: product.categoryId, family, variants: [] }
      ;(current.variants as JsonRecord[]).push(product)
      groups.set(id, current)
    }
  }
  return [...groups.values()]
}

const storeServerNow = '2026-11-08T12:00:00.000Z'

function isCurrentPromotion(product: JsonRecord) {
  if (typeof product.promotionalPriceCents !== 'number') return false
  const promotional = Number(product.promotionalPriceCents)
  const base = Number(product.basePriceCents)
  if (!Number.isFinite(promotional) || !Number.isFinite(base) || promotional >= base) return false
  const now = Date.parse(storeServerNow)
  const starts = typeof product.promotionStartsAt === 'string' ? Date.parse(product.promotionStartsAt) : Number.NEGATIVE_INFINITY
  const ends = typeof product.promotionEndsAt === 'string' ? Date.parse(product.promotionEndsAt) : Number.POSITIVE_INFINITY
  return starts <= now && now < ends
}

function hasQuantitySaving(product: JsonRecord) {
  const base = Number(isCurrentPromotion(product) ? product.promotionalPriceCents : product.basePriceCents)
  const threshold = product.quantityThreshold && typeof product.quantityThreshold === 'object'
    ? product.quantityThreshold as JsonRecord
    : null
  if (threshold && Number(threshold.unitPriceCents) < base) return true
  const rules = Array.isArray(product.quantityPrices) ? product.quantityPrices as JsonRecord[] : []
  return rules.some(rule => Number(rule.totalPriceCents) < Number(rule.quantity) * base)
}

function storeSectionGroups(
  catalog: JsonRecord,
  section: string,
  categoryId: string | null,
  search: string | null,
) {
  const groups = catalogGroups(catalog, categoryId, search)
  if (section === 'featured') {
    return groups.filter(group => (group.variants as JsonRecord[]).some(product => product.available !== false && product.featured === true))
  }
  if (section === 'offers') {
    return groups.filter(group => (group.variants as JsonRecord[]).some(product => product.available !== false && (isCurrentPromotion(product) || hasQuantitySaving(product))))
  }
  return groups
}

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

export async function routePublicCatalog(
  page: Page,
  catalog: JsonRecord,
  slug: string,
  _channel: 'menu' | 'store' = 'menu',
) {
  await page.route('**/rest/v1/rpc/get_public_*', async (route) => {
    const name = new URL(route.request().url()).pathname.split('/').at(-1)
    const request = (route.request().postDataJSON() ?? {}) as JsonRecord
    if (request.p_restaurant_slug !== slug) return json(route, { code: 'PGRST116', message: 'not found' }, 404)
    const revision = 1
    if (name === 'get_public_catalog_revision') return json(route, { revision, updatedAt: '2026-10-29T12:00:00Z' })
    if (name === 'get_public_catalog_meta') {
      const categories = (catalog.categories as JsonRecord[]).map(({ products: _products, ...category }) => category)
      return json(route, { ...catalog, revision, categories })
    }
    if (name === 'get_public_catalog_page') {
      const all = catalogGroups(catalog, request.p_category_id as string | null, request.p_search as string | null)
      const after = request.p_after_group_id ? all.findIndex((group) => group.id === request.p_after_group_id) + 1 : 0
      const limit = Math.min(48, Math.max(1, Number(request.p_limit ?? 24)))
      const items = all.slice(after, after + limit)
      return json(route, { revision, items, nextCursor: after + limit < all.length ? items.at(-1)?.id : null })
    }
    if (name === 'get_public_store_catalog_page') {
      const section = typeof request.p_section === 'string' ? request.p_section : 'all'
      const categoryId = typeof request.p_category_id === 'string' ? request.p_category_id : null
      const search = typeof request.p_search === 'string' && request.p_search.trim()
        ? request.p_search.trim().toLocaleLowerCase('es')
        : null
      const scope = { restaurantSlug: slug.toLocaleLowerCase('es'), section, categoryId, search }
      const validUntil = null
      const all = storeSectionGroups(catalog, section, categoryId, search)
      const categoryIcons = Object.fromEntries((catalog.categories as JsonRecord[])
        .filter(category => typeof category.id === 'string' && typeof category.iconKey === 'string')
        .map(category => [category.id as string, category.iconKey as string]))
      const cursor = request.p_cursor && typeof request.p_cursor === 'object' ? request.p_cursor as JsonRecord : null
      let after = 0
      if (cursor) {
        const cursorScope = cursor.scope && typeof cursor.scope === 'object' ? cursor.scope as JsonRecord : null
        const cursorId = typeof cursor.afterGroupId === 'string' ? cursor.afterGroupId : null
        if (!cursorId || !Object.hasOwn(cursor, 'revision') || !Object.hasOwn(cursor, 'validUntil') || !cursorScope) {
          return json(route, { code: '22023', message: 'CATALOG_CURSOR_INVALID' }, 400)
        }
        const scopeMatches = cursorScope.restaurantSlug === scope.restaurantSlug &&
          cursorScope.section === scope.section &&
          cursorScope.categoryId === scope.categoryId &&
          cursorScope.search === scope.search
        if (Number(cursor.revision) !== revision || cursor.validUntil !== validUntil || !scopeMatches) {
          return json(route, { code: '22023', message: 'CATALOG_CURSOR_STALE' }, 400)
        }
        const anchor = all.findIndex(group => group.id === cursorId)
        if (anchor < 0) return json(route, { code: '22023', message: 'CATALOG_CURSOR_INVALID' }, 400)
        after = anchor + 1
      }
      const limit = Math.min(48, Math.max(1, Number(request.p_limit ?? 24)))
      const items = all.slice(after, after + limit)
      const nextCursor = after + limit < all.length && items.length
        ? { afterGroupId: items.at(-1)?.id, revision, validUntil, scope }
        : null
      return json(route, { revision, serverNow: storeServerNow, validUntil, categoryIcons, items, nextCursor })
    }
    if (name === 'get_public_catalog_group') {
      const group = catalogGroups(catalog, null, null).find((item) => item.id === request.p_group_id || (item.variants as JsonRecord[]).some((variant) => variant.id === request.p_group_id))
      return group ? json(route, { revision, group }) : json(route, { code: 'PGRST116', message: 'not found' }, 404)
    }
    if (name === 'get_public_products_by_ids') {
      const ids = new Set(Array.isArray(request.p_product_ids) ? request.p_product_ids : [])
      const products = catalogGroups(catalog, null, null).flatMap((group) => group.variants as JsonRecord[]).filter((product) => ids.has(product.id))
      return json(route, { revision, products })
    }
    if (name === 'get_public_menu' || name === 'get_public_catalog') return json(route, catalog)
    return route.fallback()
  })
}
