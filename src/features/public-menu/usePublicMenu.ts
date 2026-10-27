import { useQuery } from '@tanstack/react-query'
import { env } from '../../lib/env'
import { fetchPublicMenu } from './api'
import type { CommerceChannel } from '../../lib/commerce-channel'

export function usePublicMenu(slug: string | undefined, channel: CommerceChannel = 'menu') {
  return useQuery({
    queryKey: channel === 'menu' ? ['public-menu', slug] : ['public-menu', slug, channel],
    queryFn: () => fetchPublicMenu(slug ?? '', channel),
    enabled: Boolean(slug && env.isSupabaseConfigured),
    staleTime: 60_000,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
    retry: 1,
  })
}
