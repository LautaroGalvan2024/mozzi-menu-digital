import { zodResolver } from '@hookform/resolvers/zod'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { Link, Navigate, useSearchParams } from 'react-router'
import { z } from 'zod'
import { ErrorPanel, LoadingScreen } from '../../components/Feedback'
import { env } from '../../lib/env'
import { supabase } from '../../lib/supabase/client'
import { relativeReturnToSchema } from '../../lib/validation/schemas'
import { resolvePostLoginDestination } from './access-routing'
import { useAuth } from './AuthProvider'
import { AuthShell } from './AuthShell'

const schema = z.object({
  email: z.string().trim().email('Ingresá un correo válido.'),
  password: z.string().min(1, 'Ingresá tu contraseña.'),
})

type LoginValues = z.infer<typeof schema>

export function LoginPage() {
  const auth = useAuth()
  const [params] = useSearchParams()
  const [serverError, setServerError] = useState<string | null>(null)
  const returnCandidate = params.get('returnTo')
  const parsedReturnTo = relativeReturnToSchema.safeParse(returnCandidate)
  const requestedPath = parsedReturnTo.success ? parsedReturnTo.data : null
  const form = useForm<LoginValues>({
    resolver: zodResolver(schema),
    defaultValues: { email: '', password: '' },
  })

  if (auth.user && auth.loading) {
    return <LoadingScreen label="Verificando tu acceso…" />
  }
  if (auth.user && auth.accessError) {
    return (
      <main className="page-shell py-16">
        <ErrorPanel
          action={
            <button
              className="button-secondary"
              type="button"
              onClick={() => void auth.refreshAccess()}
            >
              Reintentar
            </button>
          }
        >
          {auth.accessError}
        </ErrorPanel>
      </main>
    )
  }
  if (auth.user) {
    return (
      <Navigate
        to={resolvePostLoginDestination({
          isSuperAdmin: auth.isSuperAdmin,
          assuranceLevel: auth.assuranceLevel,
          memberships: auth.memberships,
          requestedPath,
        })}
        replace
      />
    )
  }

  const submit = form.handleSubmit(async (values) => {
    setServerError(null)
    if (!env.isSupabaseConfigured) {
      setServerError('Configurá las variables públicas de Supabase para iniciar sesión.')
      return
    }
    const { error } = await supabase.auth.signInWithPassword(values)
    if (error) setServerError('Correo o contraseña incorrectos.')
  })

  return (
    <AuthShell
      title="Ingresá al panel"
      subtitle="El acceso es únicamente por invitación. Tu sesión y permisos se validan con Supabase Auth."
      footer={
        <Link className="text-sm font-semibold text-orange-700 hover:text-orange-900" to="/auth/forgot-password">
          ¿Olvidaste tu contraseña?
        </Link>
      }
    >
      <form className="space-y-5" onSubmit={submit} noValidate>
        <label className="field">
          <span>Correo</span>
          <input type="email" autoComplete="email" {...form.register('email')} />
          {form.formState.errors.email ? <small>{form.formState.errors.email.message}</small> : null}
        </label>
        <label className="field">
          <span>Contraseña</span>
          <input type="password" autoComplete="current-password" {...form.register('password')} />
          {form.formState.errors.password ? <small>{form.formState.errors.password.message}</small> : null}
        </label>
        {serverError ? <p className="form-error" role="alert">{serverError}</p> : null}
        <button className="button-primary w-full" disabled={form.formState.isSubmitting} type="submit">
          {form.formState.isSubmitting ? 'Ingresando…' : 'Ingresar'}
        </button>
      </form>
    </AuthShell>
  )
}
