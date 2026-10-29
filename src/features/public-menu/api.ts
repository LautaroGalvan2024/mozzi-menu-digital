import { env } from '../../lib/env'
import {
  catalogRevisionSchema,
  publicCatalogGroupResultSchema,
  publicCatalogMetaSchema,
  publicCatalogPageSchema,
  publicMenuSchema,
  publicProductsByIdsSchema,
} from '../../lib/validation/schemas'
import type {
  CatalogRevision,
  PublicCatalogGroup,
  PublicCatalogMeta,
  PublicCatalogPage,
  PublicMenu,
  PublicProduct,
} from '../../types/domain'
import type { CommerceChannel } from '../../lib/commerce-channel'

type JsonRpcResult = {
  data: unknown
  error: { code?: string; message: string } | null
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
