import { ShieldCheck } from 'lucide-react'
import { Link } from 'react-router'
import { PageHeader } from '../../components/PageHeader'
import { useAuth } from '../auth/AuthProvider'

export function SuperSecurityPage(){const auth=useAuth();return <><PageHeader eyebrow="Protección" title="Seguridad de Super Admin" description="Las políticas y funciones críticas verifican el claim AAL2 además del rol de plataforma."/><section className="max-w-2xl rounded-3xl border border-slate-800 bg-slate-900 p-6"><ShieldCheck className="h-10 w-10 text-emerald-400"/><h2 className="mt-5 font-display text-2xl font-bold">Nivel actual: {auth.assuranceLevel}</h2><p className="mt-3 text-sm leading-6 text-slate-400">Una redirección de frontend mejora la experiencia, pero no autoriza. PostgreSQL y las Edge Functions vuelven a validar rol, usuario real y AAL2.</p><Link className="button-primary mt-5" to="/auth/mfa?returnTo=/superadmin/seguridad">Verificar MFA</Link></section></>}
