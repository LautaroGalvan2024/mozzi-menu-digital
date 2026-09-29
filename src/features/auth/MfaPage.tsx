import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Navigate, useNavigate, useSearchParams } from 'react-router'
import { LoadingScreen } from '../../components/Feedback'
import { supabase } from '../../lib/supabase/client'
import { relativeReturnToSchema } from '../../lib/validation/schemas'
import { resolveMfaStep, SUPER_ADMIN_HOME } from './access-routing'
import { useAuth } from './AuthProvider'
import { AuthShell } from './AuthShell'

interface TotpEnrollment {
  factorId: string
  qrCode: string
  secret: string
}

type MfaPreparation =
  | { kind: 'complete' }
  | { kind: 'challenge'; factorId: string }
  | { kind: 'enroll'; enrollment: TotpEnrollment }

async function prepareMfa(
  assuranceLevel: 'aal1' | 'aal2' | null,
): Promise<MfaPreparation> {
  const { data, error: listError } = await supabase.auth.mfa.listFactors()
  if (listError) throw new Error('MFA_LIST_FAILED')

  const verified = data.totp[0]
  const step = resolveMfaStep(assuranceLevel, Boolean(verified))
  if (step === 'complete') return { kind: 'complete' }
  if (step === 'challenge' && verified) {
    return { kind: 'challenge', factorId: verified.id }
  }

  const unverified = data.all.filter(
    (factor) => factor.factor_type === 'totp' && factor.status === 'unverified',
  )
  const cleanup = await Promise.all(
    unverified.map((factor) => supabase.auth.mfa.unenroll({ factorId: factor.id })),
  )
  if (cleanup.some((result) => result.error)) throw new Error('MFA_CLEANUP_FAILED')

  const { data: enrolled, error: enrollError } = await supabase.auth.mfa.enroll({
    factorType: 'totp',
    friendlyName: 'Mozzi TOTP',
  })
  if (enrollError) throw new Error('MFA_ENROLL_FAILED')

  return {
    kind: 'enroll',
    enrollment: {
      factorId: enrolled.id,
      qrCode: enrolled.totp.qr_code,
      secret: enrolled.totp.secret,
    },
  }
}

export function MfaPage() {
  const auth = useAuth()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const parsedReturnTo = relativeReturnToSchema.safeParse(params.get('returnTo') ?? SUPER_ADMIN_HOME)
  const returnTo = parsedReturnTo.success ? parsedReturnTo.data : SUPER_ADMIN_HOME
  const [factorId, setFactorId] = useState<string | null>(null)
  const [enrollment, setEnrollment] = useState<TotpEnrollment | null>(null)
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const preparation = useRef<{
    userId: string
    promise: Promise<MfaPreparation>
  } | null>(null)

  useEffect(() => {
    const userId = auth.user?.id
    if (!userId) {
      preparation.current = null
      setFactorId(null)
      setEnrollment(null)
      setLoading(false)
      return
    }

    if (!preparation.current || preparation.current.userId !== userId) {
      setFactorId(null)
      setEnrollment(null)
      setError(null)
      preparation.current = {
        userId,
        promise: prepareMfa(auth.assuranceLevel),
      }
    }

    let active = true
    setLoading(true)
    void preparation.current.promise
      .then((result) => {
        if (!active) return
        if (result.kind === 'challenge') {
          setFactorId(result.factorId)
        }
        if (result.kind === 'enroll') {
          setFactorId(result.enrollment.factorId)
          setEnrollment(result.enrollment)
        }
        setLoading(false)
      })
      .catch(() => {
        if (!active) return
        setError('No pudimos consultar tus factores de seguridad.')
        setLoading(false)
      })

    return () => {
      active = false
    }
  }, [auth.assuranceLevel, auth.user])

  if (auth.loading) return <LoadingScreen label="Preparando autenticación de dos pasos…" />
  if (!auth.user) return <Navigate to="/login" replace />
  if (loading) return <LoadingScreen label="Preparando autenticación de dos pasos…" />
  if (auth.assuranceLevel === 'aal2') return <Navigate to={returnTo} replace />

  async function verify(event: FormEvent) {
    event.preventDefault()
    setError(null)
    if (!factorId) return
    const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({ factorId })
    if (challengeError) {
      setError('No pudimos iniciar la verificación.')
      return
    }
    const { error: verifyError } = await supabase.auth.mfa.verify({
      factorId,
      challengeId: challenge.id,
      code: code.replace(/\D/g, ''),
    })
    if (verifyError) {
      setError('El código no es válido. Esperá el próximo código e intentá nuevamente.')
      return
    }
    await auth.refreshAccess()
    navigate(returnTo, { replace: true })
  }

  return (
    <AuthShell
      title={enrollment ? 'Activá la protección MFA' : 'Segundo factor'}
      subtitle={enrollment ? 'Escaneá el QR con una app TOTP. Esta protección es obligatoria para Super Admin.' : 'Ingresá el código de seis dígitos de tu app autenticadora.'}
    >
      {enrollment ? (
        <div className="mb-6 rounded-2xl border border-stone-200 p-4 text-center">
          <img className="mx-auto h-48 w-48" src={enrollment.qrCode} alt="Código QR para enrolar autenticador TOTP" />
          <p className="mt-3 text-xs text-stone-500">Clave manual</p>
          <code className="break-all text-xs">{enrollment.secret}</code>
        </div>
      ) : null}
      <form className="space-y-5" onSubmit={verify}>
        <label className="field"><span>Código TOTP</span><input inputMode="numeric" pattern="[0-9]*" autoComplete="one-time-code" maxLength={6} value={code} onChange={(event) => setCode(event.target.value)} /></label>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <button className="button-primary w-full" type="submit" disabled={code.replace(/\D/g, '').length !== 6}>Verificar y continuar</button>
      </form>
    </AuthShell>
  )
}
