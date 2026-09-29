import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router'
import { supabase } from '../../lib/supabase/client'
import { passwordSchema } from '../../lib/validation/schemas'
import { AuthShell } from './AuthShell'
import { PasswordStrength } from './PasswordStrength'

export function SetPasswordPage() {
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const navigate = useNavigate()

  async function submit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    const parsed = passwordSchema.safeParse(password)
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'La contraseña no cumple los requisitos.')
      return
    }
    if (password !== confirmation) {
      setError('Las contraseñas no coinciden.')
      return
    }
    setSaving(true)
    const { error: updateError } = await supabase.auth.updateUser({ password })
    setSaving(false)
    if (updateError) setError('No pudimos guardar la contraseña. Pedí un enlace nuevo.')
    else navigate('/auth/continue', { replace: true })
  }

  return (
    <AuthShell title="Definí tu contraseña" subtitle="La contraseña nunca se guarda en tablas de la aplicación ni se envía por WhatsApp.">
      <form className="space-y-5" onSubmit={submit}>
        <label className="field"><span>Nueva contraseña</span><input type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
        <PasswordStrength password={password} />
        <label className="field"><span>Repetir contraseña</span><input type="password" autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <button className="button-primary w-full" disabled={saving} type="submit">{saving ? 'Guardando…' : 'Guardar contraseña'}</button>
      </form>
    </AuthShell>
  )
}
