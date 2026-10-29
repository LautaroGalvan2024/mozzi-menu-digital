import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { env } from '../../lib/env'
import {
  fetchPublicCatalogMeta,
  fetchPublicCatalogRevision,
  fetchPublicProductsByIds,
} from './api'
import type { CommerceChannel } from '../../lib/commerce-channel'
import { queryKeys } from '../../lib/queryKeys'
import { subscribeCatalogInvalidations } from '../../lib/catalog-cache'
import type { PublicMenu } from '../../types/domain'

function normalizedProductIds(productIds: readonly string[]) {
  return [...new Set(productIds)].sort()
}

export function publicMenuQueryOptions(
  slug: string,
  channel: CommerceChannel = 'menu',
  productIds: readonly string[] = [],
) {
  const ids = normalizedProductIds(productIds)
  return queryOptions({
    queryKey: [...queryKeys.publicCatalog.menu(slug, channel), 'cart', ids.join(',')] as const,
    queryFn: async (): Promise<PublicMenu & { catalogRevision: number }> => {
      const [meta, selection] = await Promise.all([
        fetchPublicCatalogMeta(slug, channel),
        fetchPublicProductsByIds(slug, ids, channel),
      ])
      if (ids.length && selection.revision !== meta.revision) {
        throw new Error('El catálogo cambió mientras actualizábamos el carrito.')
      }
      const byCategory = new Map<string, typeof selection.products>()
      for (const product of selection.products) {
        const current = byCategory.get(product.categoryId) ?? []
        current.push(product)
        byCategory.set(product.categoryId, current)
      }
      return {
        restaurant: meta.restaurant,
        categories: meta.categories.map((category) => ({
          ...category,
          products: byCategory.get(category.id) ?? [],
        })),
        businessHours: meta.businessHours,
        specialHours: meta.specialHours,
        paymentMethods: meta.paymentMethods,
        deliveryZones: meta.deliveryZones,
        catalogRevision: meta.revision,
      }
    },
    // The small revision query below is the freshness clock. Keeping the full
    // payload fresh prevents focus/reconnect from downloading it unnecessarily.
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 30 * 60_000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: 1,
  })
}

export function usePublicMenu(
  slug: string | undefined,
  channel: CommerceChannel = 'menu',
  productIds: readonly string[] = [],
) {
  const client = useQueryClient()
  const observedRevision = useRef<number | null>(null)
  const productKey = normalizedProductIds(productIds).join(',')
  const options = publicMenuQueryOptions(slug ?? '', channel, productKey ? productKey.split(',') : [])
  const query = useQuery({
    ...options,
    enabled: Boolean(slug && env.isSupabaseConfigured),
  })
  const revision = useQuery({
    queryKey: queryKeys.publicCatalog.revision(slug, channel),
    queryFn: () => fetchPublicCatalogRevision(slug ?? '', channel),
    enabled: Boolean(slug && query.data && env.isSupabaseConfigured),
    staleTime: 15_000,
    refetchInterval: () =>
      typeof document === 'undefined' || document.visibilityState === 'visible' ? 20_000 : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    retry: false,
  })

  useEffect(() => {
    observedRevision.current = null
  }, [channel, slug])

  useEffect(() => {
    const next = revision.data?.revision
    if (next === undefined) return
    const payloadRevision = query.data?.catalogRevision
    const baseline = observedRevision.current ?? payloadRevision ?? next
    observedRevision.current = Math.max(baseline, next)
    if (next <= baseline) return
    void Promise.all([
      client.invalidateQueries({
        queryKey: [...queryKeys.publicCatalog.menu(slug, channel), 'cart', productKey],
        exact: true,
      }),
      client.invalidateQueries({ queryKey: queryKeys.publicCatalog.groups(slug, channel) }),
    ])
  }, [channel, client, productKey, query.data?.catalogRevision, revision.data?.revision, slug])

  useEffect(() => {
    const restaurantId = query.data?.restaurant.id
    if (!restaurantId) return
    return subscribeCatalogInvalidations((message) => {
      if (message.restaurantId !== restaurantId) return
      void Promise.all([
        client.invalidateQueries({
          queryKey: [...queryKeys.publicCatalog.menu(slug, channel), 'cart', productKey],
          exact: true,
        }),
        client.invalidateQueries({
          queryKey: queryKeys.publicCatalog.revision(slug, channel),
          exact: true,
        }),
        client.invalidateQueries({ queryKey: queryKeys.publicCatalog.groups(slug, channel) }),
      ])
    })
  }, [channel, client, productKey, query.data?.restaurant.id, slug])

  const refreshError = query.data ? query.error ?? revision.error : null
  return {
    ...query,
    error: query.data ? null : query.error,
    refreshError,
    catalogRevision: revision.data,
    refresh: () => Promise.all([query.refetch(), revision.refetch()]),
  }
}
