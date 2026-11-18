import { ArrowLeft, Building2, LayoutDashboard, ScrollText, ShieldCheck, Users } from 'lucide-react'
import { NavLink, Outlet } from 'react-router'
import { useAuth } from '../features/auth/AuthProvider'
import { MozziBrand } from './MozziBrand'

const links = [
  ['/superadmin', 'Resumen', LayoutDashboard],
  ['/superadmin/restaurantes', 'Comercios', Building2],
  ['/superadmin/usuarios', 'Usuarios', Users],
  ['/superadmin/auditoria', 'Auditoría', ScrollText],
  ['/superadmin/seguridad', 'Seguridad', ShieldCheck],
] as const

export function SuperAdminLayout() {
  const auth = useAuth()
  return (
    <div className="admin-app admin-central">
      <a className="admin-skip-link" href="#admin-content">Ir al contenido</a>
      <header className="admin-central-header">
        <div className="admin-central-header-inner">
          <div className="admin-central-brand"><MozziBrand /><span className="admin-central-label"><ShieldCheck aria-hidden />Control central</span></div>
          <div className="admin-central-actions"><NavLink to="/admin" className="button-secondary"><ArrowLeft className="h-4 w-4" aria-hidden />Panel del comercio</NavLink><button type="button" className="button-quiet" onClick={() => void auth.signOut()}>Salir</button></div>
        </div>
      </header>
      <nav className="admin-central-navigation" aria-label="Super administración"><div>{links.map(([to, label, Icon], index) => <NavLink key={to} to={to} end={index === 0} className={({ isActive }) => `admin-nav-link ${isActive ? 'is-active' : ''}`}><Icon aria-hidden />{label}</NavLink>)}</div></nav>
      <main id="admin-content" tabIndex={-1} className="admin-content max-w-7xl"><Outlet /></main>
    </div>
  )
}
