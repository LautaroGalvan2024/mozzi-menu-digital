import type { CommerceChannel } from '../lib/commerce-channel'
import { env } from '../lib/env'
import {
  publicCatalogMetaQueryOptions,
  publicCatalogPagesQueryOptions,
} from '../features/public-menu/usePublicCatalog'
import { commerceQueryClient } from './CommerceProviders'

export function preloadPublicCatalog(slug: string, channel: CommerceChannel) {
  if (!env.isSupabaseConfigured) return
  void Promise.all([
    commerceQueryClient.prefetchQuery(publicCatalogMetaQueryOptions(slug, channel)),
    commerceQueryClient.prefetchInfiniteQuery(publicCatalogPagesQueryOptions(slug, channel)),
  ])
}
