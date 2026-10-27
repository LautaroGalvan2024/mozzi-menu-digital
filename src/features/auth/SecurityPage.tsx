import { KeyRound,ShieldCheck } from 'lucide-react'
import { Link } from 'react-router'
import { PageHeader } from '../../components/PageHeader'
import { useAuth } from './AuthProvider'

export function SecurityPage() {
  const auth = useAuth()
  return <><PageHeader eyebrow="Tu cuenta" title="Seguridad" description="Administrá tu contraseña y la protección de tu acceso." />
    <div className="grid gap-5 md:grid-cols-2">
      <article className="form-card"><ShieldCheck className="mb-4 h-5 w-5 text-stone-500" aria-hidden /><h2 className="form-card-title">Verificación en dos pasos</h2><p className="admin-muted">{auth.assuranceLevel === 'aal2' ? 'Tu sesión tiene la segunda verificación completa.' : 'Sumá una segunda verificación con una aplicación autenticadora.'}</p><Link className="button-secondary mt-5" to="/auth/mfa?returnTo=/admin/seguridad">Configurar o verificar MFA</Link></article>
      <article className="form-card"><KeyRound className="mb-4 h-5 w-5 text-stone-500" aria-hidden /><h2 className="form-card-title">Contraseña</h2><p className="admin-muted">Recibí un enlace por correo para elegir una contraseña nueva.</p><Link className="button-secondary mt-5" to="/auth/forgot-password">Solicitar cambio</Link></article>
    </div>
  </>
}
