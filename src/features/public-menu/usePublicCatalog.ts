import {
  infiniteQueryOptions,
  queryOptions,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { subscribeCatalogInvalidations } from '../../lib/catalog-cache'
import type { CommerceChannel } from '../../lib/commerce-channel'
import { env } from '../../lib/env'
import { queryKeys } from '../../lib/queryKeys'
import { fetchPublicCatalogMeta, fetchPublicCatalogPage, fetchPublicCatalogRevision } from './api'

export function publicCatalogMetaQueryOptions(slug: string, channel: CommerceChannel) {
  return queryOptions({
    queryKey: queryKeys.publicCatalog.meta(slug, channel),
    queryFn: () => fetchPublicCatalogMeta(slug, channel),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 30 * 60_000,
    retry: 1,
  })
}

export function publicCatalogPagesQueryOptions(
  slug: string,
  channel: CommerceChannel,
  categoryId = '',
  search = '',
) {
  return infiniteQueryOptions({
    queryKey: queryKeys.publicCatalog.page(slug, channel, categoryId, search),
    queryFn: ({ pageParam }) => fetchPublicCatalogPage({
      slug,
      channel,
      ...(categoryId ? { categoryId } : {}),
      ...(search ? { search } : {}),
      ...(pageParam ? { cursor: pageParam } : {}),
      limit: 24,
    }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 30 * 60_000,
    retry: 1,
  })
}

export function usePublicCatalog(
  slug: string | undefined,
  channel: CommerceChannel,
  categoryId = '',
  search = '',
) {
  const client = useQueryClient()
  const observedRevision = useRef<number | null>(null)
  const enabled = Boolean(slug && env.isSupabaseConfigured)
  const normalizedSearch = search.trim().slice(0, 120)
  const resultKey = `${slug ?? ''}:${channel}:${categoryId}:${normalizedSearch}`
  const meta = useQuery({
    ...publicCatalogMetaQueryOptions(slug ?? '', channel),
    enabled,
  })
  const pages = useInfiniteQuery({
    ...publicCatalogPagesQueryOptions(slug ?? '', channel, categoryId, normalizedSearch),
    enabled,
  })
  const revision = useQuery({
    queryKey: queryKeys.publicCatalog.revision(slug, channel),
    queryFn: () => fetchPublicCatalogRevision(slug ?? '', channel),
    enabled: Boolean(enabled && meta.data),
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

  const pageRevisionKey = pages.data?.pages.map((page) => page.revision).join(',') ?? ''

  useEffect(() => {
    const revisions = [
      meta.data?.revision,
      revision.data?.revision,
      ...(pages.data?.pages.map((page) => page.revision) ?? []),
    ].filter((value): value is number => value !== undefined)
    if (!revisions.length) return
    const target = Math.max(...revisions)
    const metaMismatch = meta.data !== undefined && meta.data.revision !== target
    const pagesMismatch = pages.data !== undefined && pages.data.pages.some((page) => page.revision !== target)
    const baseline = observedRevision.current ?? target
    observedRevision.current = Math.max(baseline, target)
    if (!metaMismatch && !pagesMismatch && target <= baseline) return
    const invalidations: Array<Promise<unknown>> = []
    if (metaMismatch || target > baseline) {
      invalidations.push(client.invalidateQueries({ queryKey: queryKeys.publicCatalog.meta(slug, channel), exact: true }))
    }
    if (pagesMismatch || target > baseline) {
      invalidations.push(client.invalidateQueries({ queryKey: queryKeys.publicCatalog.pages(slug, channel) }))
    }
    invalidations.push(client.invalidateQueries({ queryKey: queryKeys.publicCatalog.groups(slug, channel) }))
    void Promise.all(invalidations)
  }, [channel, client, meta.data, pageRevisionKey, pages.data, revision.data?.revision, slug])

  useEffect(() => {
    const restaurantId = meta.data?.restaurant.id
    if (!restaurantId) return
    return subscribeCatalogInvalidations((message) => {
      if (message.restaurantId !== restaurantId) return
      void Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.publicCatalog.meta(slug, channel), exact: true }),
        client.invalidateQueries({ queryKey: queryKeys.publicCatalog.pages(slug, channel) }),
        client.invalidateQueries({ queryKey: queryKeys.publicCatalog.revision(slug, channel), exact: true }),
      ])
    })
  }, [channel, client, meta.data?.restaurant.id, slug])

  const consistent = Boolean(
    meta.data &&
    pages.data &&
    pages.data.pages.every((page) => page.revision === meta.data!.revision),
  )
  const [lastSnapshot, setLastSnapshot] = useState<{
    key: string
    meta: NonNullable<typeof meta.data>
    pages: NonNullable<typeof pages.data>
  } | null>(null)
  const currentSnapshot = consistent && meta.data && pages.data
    ? { key: resultKey, meta: meta.data, pages: pages.data }
    : null
  useEffect(() => {
    if (consistent && meta.data && pages.data) {
      setLastSnapshot({ key: resultKey, meta: meta.data, pages: pages.data })
    }
  }, [consistent, meta.data, pages.data, resultKey])
  const snapshot = currentSnapshot ?? (lastSnapshot?.key === resultKey ? lastSnapshot : null)
  const visibleMeta = { ...meta, data: snapshot?.meta }
  const visiblePages = { ...pages, data: snapshot?.pages }

  return {
    meta: visibleMeta,
    pages: visiblePages,
    groups: snapshot?.pages.pages.flatMap((page) => page.items) ?? [],
    isLoading: !snapshot && !meta.error && !pages.error,
    isUpdating:
      !consistent ||
      (meta.isFetching && !meta.isLoading) ||
      (pages.isFetching && !pages.isFetchingNextPage),
    refreshError: snapshot ? meta.error ?? pages.error ?? revision.error : null,
    catalogRevision: revision.data,
  }
}
