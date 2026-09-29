import { createClient } from '@supabase/supabase-js'
import { env } from '../env'
import type { Database } from '../../types/database.generated'

// The placeholders keep static builds and documentation previews usable. Every
// network-facing screen checks isSupabaseConfigured before issuing a request.
export const supabase = createClient<Database>(
  env.supabaseUrl || 'https://configuration-required.invalid',
  env.supabasePublishableKey || 'publishable-key-required',
  {
    auth: {
      autoRefreshToken: true,
      detectSessionInUrl: true,
      persistSession: true,
    },
  },
)

export function publicAssetUrl(path: string | null): string | null {
  if (!path || !env.isSupabaseConfigured) return null
  const { data } = supabase.storage.from('restaurant-assets').getPublicUrl(path)
  return data.publicUrl
}
