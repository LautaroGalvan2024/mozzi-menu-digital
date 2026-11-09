import { env } from '../../lib/env'
import {
  catalogRevisionSchema,
  publicCatalogGroupResultSchema,
  publicCatalogMetaSchema,
  publicCatalogPageSchema,
  publicStoreCatalogPageSchema,
  publicMenuSchema,
  publicProductsByIdsSchema,
} from '../../lib/validation/schemas'
import type {
  CatalogRevision,
  PublicCatalogGroup,
  PublicCatalogMeta,
  PublicCatalogPage,
  PublicStoreCatalogPage,
  PublicStoreCatalogCursor,
  PublicStoreCatalogSection,
  PublicMenu,
  PublicProduct,
} from '../../types/domain'
import type { CommerceChannel } from '../../lib/commerce-channel'

type JsonRpcResult = {
  data: unknown
  error: { code?: string; message: string } | null
}

export class PublicCatalogCursorStaleError extends Error {
  constructor() {
    super('El catálogo cambió mientras lo estabas recorriendo.')
    this.name = 'PublicCatalogCursorStaleError'
  }
}

export class PublicCatalogCategoryInvalidError extends Error {
  constructor() {
    super('La categoría seleccionada ya no está disponible.')
    this.name = 'PublicCatalogCategoryInvalidError'
  }
}

async function jsonRpc(
  name: string,
  args: Record<string, unknown>,
): Promise<JsonRpcResult> {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), 15_000)
  try {
    const response = await fetch(`${env.supabaseUrl}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        apikey: env.supabasePublishableKey,
        authorization: `Bearer ${env.supabasePublishableKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(args),
      signal: controller.signal,
    })
    const payload: unknown = response.status === 204 ? null : await response.json().catch(() => null)
    if (response.ok) return { data: payload, error: null }
    const problem = payload && typeof payload === 'object' ? payload as { code?: unknown; message?: unknown } : null
    return {
      data: null,
      error: {
        ...(typeof problem?.code === 'string' ? { code: problem.code } : {}),
        message: typeof problem?.message === 'string' ? problem.message : `HTTP ${response.status}`,
      },
    }
  } catch (error) {
    return {
      data: null,
      error: { message: error instanceof Error ? error.message : 'NETWORK_ERROR' },
    }
  } finally {
    window.clearTimeout(timeout)
  }
}

function publicCatalogError(error: { code?: string; message: string }, fallback: string) {
  if (error.code === 'PGRST116' || error.message.includes('not found')) {
    return new Error('No encontramos un catálogo publicado con esa dirección.')
  }
  return new Error(fallback)
}

export async function fetchPublicMenu(slug: string, channel: CommerceChannel = 'menu'): Promise<PublicMenu> {
  const { data, error } = channel === 'store'
    ? await jsonRpc('get_public_catalog', { p_restaurant_slug: slug, p_channel: channel })
    : await jsonRpc('get_public_menu', { p_restaurant_slug: slug })
  if (error) {
    if (error.code === 'PGRST116' || error.message.includes('not found')) {
      throw new Error('No encontramos un menú publicado con esa dirección.')
    }
    throw new Error('No pudimos cargar el menú. Volvé a intentar.')
  }
  const parsed = publicMenuSchema.safeParse(data)
  if (!parsed.success) {
    throw new Error('El menú publicado tiene una configuración inválida. Avisale al comercio.')
  }
  return parsed.data
}

export async function fetchPublicCatalogRevision(
  slug: string,
  channel: CommerceChannel = 'menu',
): Promise<CatalogRevision> {
  const { data, error } = await jsonRpc('get_public_catalog_revision', {
    p_restaurant_slug: slug,
    p_channel: channel,
  })
  if (error) throw publicCatalogError(error, 'No pudimos comprobar si el catálogo cambió.')
  const parsed = catalogRevisionSchema.safeParse(data)
  if (!parsed.success) throw new Error('La revisión publicada tiene un formato inválido.')
  return parsed.data
}

export async function fetchPublicCatalogMeta(
  slug: string,
  channel: CommerceChannel = 'menu',
): Promise<PublicCatalogMeta> {
  const { data, error } = await jsonRpc('get_public_catalog_meta', {
    p_restaurant_slug: slug,
    p_channel: channel,
  })
  if (error) throw publicCatalogError(error, 'No pudimos cargar la información del comercio.')
  const parsed = publicCatalogMetaSchema.safeParse(data)
  if (!parsed.success) throw new Error('El catálogo publicado tiene una configuración inválida.')
  return parsed.data
}

export interface PublicCatalogPageRequest {
  slug: string
  channel?: CommerceChannel
  categoryId?: string
  search?: string
  cursor?: string
  limit?: number
}

export async function fetchPublicCatalogPage({
  slug,
  channel = 'menu',
  categoryId,
  search,
  cursor,
  limit = 24,
}: PublicCatalogPageRequest): Promise<PublicCatalogPage> {
  const { data, error } = await jsonRpc('get_public_catalog_page', {
    p_restaurant_slug: slug,
    p_channel: channel,
    p_category_id: categoryId ?? null,
    p_search: search?.trim() || null,
    p_after_group_id: cursor ?? null,
    p_limit: Math.min(48, Math.max(1, limit)),
  })
  if (error) throw publicCatalogError(error, 'No pudimos cargar los productos.')
  const parsed = publicCatalogPageSchema.safeParse(data)
  if (!parsed.success) throw new Error('La página de productos publicada tiene un formato inválido.')
  return parsed.data
}

export interface PublicStoreCatalogPageRequest {
  slug: string
  section?: PublicStoreCatalogSection
  categoryId?: string
  search?: string
  cursor?: PublicStoreCatalogCursor
  limit?: number
}

export async function fetchPublicStoreCatalogPage({
  slug,
  section = 'all',
  categoryId,
  search,
  cursor,
  limit = 24,
}: PublicStoreCatalogPageRequest): Promise<PublicStoreCatalogPage> {
  // Anchor before the network trip: latency may refresh a price early, but it
  // must never keep an expired promotion visible for longer.
  const clientAnchorAt = Date.now()
  const { data, error } = await jsonRpc('get_public_store_catalog_page', {
    p_restaurant_slug: slug,
    p_section: section,
    p_category_id: categoryId ?? null,
    p_search: search?.trim() || null,
    p_cursor: cursor ?? null,
    p_limit: Math.min(48, Math.max(1, limit)),
  })
  if (error) {
    // Local development often points at a shared Supabase project where the
    // migration is intentionally deployed after review. Keep the complete
    // catalogue browsable in that narrow window; production still requires
    // the curated RPC and merchandising sections never use partial legacy data.
    if (
      import.meta.env.DEV &&
      section === 'all' &&
      error.code === 'PGRST202' &&
      error.message.includes('get_public_store_catalog_page')
    ) {
      const legacyCursor = typeof cursor?.legacyAfterGroupId === 'string'
        ? cursor.legacyAfterGroupId
        : undefined
      const legacy = await fetchPublicCatalogPage({
        slug,
        channel: 'store',
        ...(categoryId ? { categoryId } : {}),
        ...(search ? { search } : {}),
        ...(legacyCursor ? { cursor: legacyCursor } : {}),
        limit,
      })
      return {
        revision: legacy.revision,
        items: legacy.items,
        nextCursor: legacy.nextCursor ? { legacyAfterGroupId: legacy.nextCursor } : null,
        serverNow: new Date(clientAnchorAt).toISOString(),
        validUntil: null,
        categoryIcons: {},
        clientAnchorAt,
      }
    }
    if ((error.code === '22023' || error.code === 'P0001') && error.message.includes('CATALOG_CURSOR_')) {
      throw new PublicCatalogCursorStaleError()
    }
    if ((error.code === '22023' || error.code === 'P0001') && error.message.includes('CATALOG_CATEGORY_INVALID')) {
      throw new PublicCatalogCategoryInvalidError()
    }
    throw publicCatalogError(error, 'No pudimos cargar los productos de la tienda.')
  }
  const parsed = publicStoreCatalogPageSchema.safeParse(data)
  if (!parsed.success) throw new Error('La página de la tienda tiene un formato inválido.')
  return { ...parsed.data, clientAnchorAt }
}

export async function fetchPublicCatalogGroup(
  slug: string,
  groupId: string,
  channel: CommerceChannel = 'menu',
): Promise<{ revision: number; group: PublicCatalogGroup }> {
  const { data, error } = await jsonRpc('get_public_catalog_group', {
    p_restaurant_slug: slug,
    p_channel: channel,
    p_group_id: groupId,
  })
  if (error) throw publicCatalogError(error, 'No pudimos cargar el producto.')
  const parsed = publicCatalogGroupResultSchema.safeParse(data)
  if (!parsed.success) throw new Error('El producto publicado tiene un formato inválido.')
  return parsed.data
}

export async function fetchPublicProductsByIds(
  slug: string,
  productIds: string[],
  channel: CommerceChannel = 'menu',
): Promise<{ revision: number; products: PublicProduct[] }> {
  if (!productIds.length) return { revision: 0, products: [] }
  const { data, error } = await jsonRpc('get_public_products_by_ids', {
    p_restaurant_slug: slug,
    p_channel: channel,
    p_product_ids: productIds,
  })
  if (error) throw publicCatalogError(error, 'No pudimos actualizar los productos del carrito.')
  const parsed = publicProductsByIdsSchema.safeParse(data)
  if (!parsed.success) throw new Error('Los productos publicados tienen un formato inválido.')
  return parsed.data
}
