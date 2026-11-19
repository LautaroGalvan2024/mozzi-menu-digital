import { KeyRound, ShieldCheck } from 'lucide-react'
import { Link } from 'react-router'
import { PageHeader } from '../../components/PageHeader'
import { useAuth } from './AuthProvider'

export function SecurityPage() {
  const auth = useAuth()
  return <>
    <PageHeader title="Seguridad" description="Administrá tu contraseña y la protección de tu acceso." />
    <div className="grid gap-3 md:grid-cols-2">
      <article className="form-card admin-account-card">
        <span className="admin-record-icon" aria-hidden><ShieldCheck size={20} /></span>
        <div>
          <h2 className="form-card-title">Verificación en dos pasos</h2>
          <p className="admin-muted">{auth.assuranceLevel === 'aal2' ? 'Tu sesión ya pasó la segunda verificación.' : 'Podés confirmar tu identidad con un código de una aplicación autenticadora.'}</p>
        </div>
        <Link className="button-primary" to="/auth/mfa?returnTo=/admin/seguridad">Abrir verificación en dos pasos</Link>
      </article>
      <article className="form-card admin-account-card">
        <span className="admin-record-icon" aria-hidden><KeyRound size={20} /></span>
        <div>
          <h2 className="form-card-title">Contraseña</h2>
          <p className="admin-muted">Recibí un enlace por correo para elegir una contraseña nueva.</p>
        </div>
        <Link className="button-secondary" to="/auth/forgot-password">Solicitar cambio</Link>
      </article>
    </div>
  </>
}
