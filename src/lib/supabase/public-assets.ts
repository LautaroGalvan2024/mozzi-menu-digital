import { env } from '../env'

export function publicAssetUrl(path: string | null): string | null {
  if (!path || !env.isSupabaseConfigured) return null
  const segments = path.split('/')
  if (
    segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.includes('\\'))
  ) return null
  const encodedPath = segments.map((segment) => encodeURIComponent(segment)).join('/')
  return `${env.supabaseUrl}/storage/v1/object/public/restaurant-assets/${encodedPath}`
}
