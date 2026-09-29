const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim() ?? ''
const supabasePublishableKey =
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim() ?? ''
const appBaseUrl =
  import.meta.env.VITE_APP_BASE_URL?.trim() || window.location.origin
const turnstileSiteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY?.trim() ?? ''

function isSafeSupabaseUrl(value: string) {
  try {
    const url = new URL(value)
    if (url.protocol === 'https:') return true
    return (
      url.protocol === 'http:' &&
      (url.hostname === '127.0.0.1' || url.hostname === 'localhost')
    )
  } catch {
    return false
  }
}

export const env = {
  supabaseUrl,
  supabasePublishableKey,
  appBaseUrl: appBaseUrl.replace(/\/$/, ''),
  turnstileSiteKey,
  isTurnstileConfigured: turnstileSiteKey.length > 0,
  isSupabaseConfigured:
    isSafeSupabaseUrl(supabaseUrl) &&
    supabasePublishableKey.length > 20,
} as const
