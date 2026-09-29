import { useQuery } from '@tanstack/react-query'
import { env } from '../../lib/env'
import { fetchPublicMenu } from './api'

export function usePublicMenu(slug: string | undefined) {
  return useQuery({
    queryKey: ['public-menu', slug],
    queryFn: () => fetchPublicMenu(slug ?? ''),
    enabled: Boolean(slug && env.isSupabaseConfigured),
    staleTime: 60_000,
    retry: 1,
  })
}
