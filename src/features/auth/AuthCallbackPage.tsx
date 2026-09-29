import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { LoadingScreen } from '../../components/Feedback'
import { supabase } from '../../lib/supabase/client'
import { relativeReturnToSchema } from '../../lib/validation/schemas'

export function AuthCallbackPage() {
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const url = new URL(window.location.href)
    const code = url.searchParams.get('code')
    // Supabase invite links use `next`, while normal login flows use
    // `returnTo`. Both are restricted to an application-relative path.
    const nextCandidate =
      url.searchParams.get('returnTo') ?? url.searchParams.get('next') ?? '/auth/continue'
    const parsed = relativeReturnToSchema.safeParse(nextCandidate)
    const next = parsed.success ? parsed.data : '/auth/continue'
    if (!code) {
      // Invite/recovery links using hash tokens are consumed by the SDK.
      void supabase.auth.getSession().then(({ data }) => {
        if (data.session) navigate('/auth/set-password', { replace: true })
        else setError('El enlace no es válido o expiró.')
      })
      return
    }
    void supabase.auth.exchangeCodeForSession(code).then(({ error: exchangeError }) => {
      if (exchangeError) setError('El enlace no es válido o expiró.')
      else navigate(next, { replace: true })
    })
  }, [navigate])

  if (error) return <main className="page-shell py-20"><p className="form-error" role="alert">{error}</p></main>
  return <LoadingScreen label="Validando el enlace seguro…" />
}
