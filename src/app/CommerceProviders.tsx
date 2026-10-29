import { QueryClientProvider, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { Outlet, useLocation, useParams } from 'react-router'
import { CartProvider } from '../features/cart/CartProvider'
import type { CommerceChannel } from '../lib/commerce-channel'
import { env } from '../lib/env'
import { createAppQueryClient } from './query-client'

export const commerceQueryClient = createAppQueryClient()

function PublicCatalogPreloader() {
  const client = useQueryClient()
  const { restaurantSlug } = useParams()
  const { pathname } = useLocation()
  const channel: CommerceChannel = pathname.startsWith('/t/') ? 'store' : 'menu'
  const isCatalogRoute = Boolean(
    restaurantSlug && (
      pathname === `/r/${restaurantSlug}` ||
      pathname === `/t/${restaurantSlug}` ||
      pathname.startsWith(`/t/${restaurantSlug}/producto/`)
    ),
  )

  useEffect(() => {
    if (!restaurantSlug || !isCatalogRoute || !env.isSupabaseConfigured) return
    void import('../features/public-menu/usePublicCatalog').then((catalog) => Promise.all([
      client.prefetchQuery(catalog.publicCatalogMetaQueryOptions(restaurantSlug, channel)),
      client.prefetchInfiniteQuery(catalog.publicCatalogPagesQueryOptions(restaurantSlug, channel)),
    ]))
  }, [channel, client, isCatalogRoute, restaurantSlug])

  return null
}

export function CommerceProviders() {
  return (
    <QueryClientProvider client={commerceQueryClient}>
      <CartProvider>
        <PublicCatalogPreloader />
        <Outlet />
      </CartProvider>
    </QueryClientProvider>
  )
}
