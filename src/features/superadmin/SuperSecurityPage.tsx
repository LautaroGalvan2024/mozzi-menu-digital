import { ShieldCheck } from 'lucide-react'
import { Link } from 'react-router'
import { PageHeader } from '../../components/PageHeader'
import { useAuth } from '../auth/AuthProvider'

export function SuperSecurityPage(){const auth=useAuth();return <><PageHeader eyebrow="Tu cuenta" title="Seguridad de Super Admin" description="La verificación en dos pasos protege las acciones de administración de la plataforma."/><section className="form-card max-w-2xl"><ShieldCheck className="mb-4 h-6 w-6 text-stone-500" aria-hidden/><h2 className="form-card-title">{auth.assuranceLevel==='aal2'?'Sesión verificada':'Verificación pendiente'}</h2><p className="admin-muted">Para administrar comercios y accesos, verificá tu identidad con el código de tu aplicación autenticadora.</p><Link className="button-secondary mt-5" to="/auth/mfa?returnTo=/superadmin/seguridad">Verificar MFA</Link></section></>}
