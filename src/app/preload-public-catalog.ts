import type { CommerceChannel } from '../lib/commerce-channel'
import { env } from '../lib/env'
import {
  publicCatalogMetaQueryOptions,
  publicCatalogPagesQueryOptions,
  publicStoreCatalogPagesQueryOptions,
} from '../features/public-menu/usePublicCatalog'
import { commerceQueryClient } from './CommerceProviders'

export function preloadPublicCatalog(slug: string, channel: CommerceChannel) {
  if (!env.isSupabaseConfigured) return
  const meta = commerceQueryClient.prefetchQuery(publicCatalogMetaQueryOptions(slug, channel))
  const products = channel === 'store'
    ? commerceQueryClient.prefetchInfiniteQuery(publicStoreCatalogPagesQueryOptions(slug, 'all'))
    : commerceQueryClient.prefetchInfiniteQuery(publicCatalogPagesQueryOptions(slug, channel))
  void Promise.all([meta, products])
}
