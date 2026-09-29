import { useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { env } from '../../lib/env'
import { supabase } from '../../lib/supabase/client'
import { AuthShell } from './AuthShell'

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    if (!env.isSupabaseConfigured) {
      setError('Falta configurar Supabase.')
      return
    }
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${env.appBaseUrl}/auth/reset-password`,
    })
    if (resetError) setError('No pudimos enviar el correo. Intentá nuevamente.')
    else setSent(true)
  }

  return (
    <AuthShell title="Recuperar acceso" subtitle="Te enviaremos un enlace de uso único si el correo pertenece a una cuenta habilitada.">
      {sent ? (
        <div className="rounded-2xl bg-emerald-50 p-4 text-sm text-emerald-900" role="status">
          Revisá tu correo y seguí el enlace. Por seguridad, la respuesta no confirma si la cuenta existe.
          <div className="mt-4"><Link className="font-semibold underline" to="/login">Volver al ingreso</Link></div>
        </div>
      ) : (
        <form className="space-y-5" onSubmit={submit}>
          <label className="field"><span>Correo</span><input type="email" required autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
          {error ? <p className="form-error" role="alert">{error}</p> : null}
          <button className="button-primary w-full" type="submit">Enviar enlace seguro</button>
        </form>
      )}
    </AuthShell>
  )
}
