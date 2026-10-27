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
    <div className="admin-app">
      <a className="admin-skip-link" href="#admin-content">Ir al contenido</a>
      <header className="border-b border-stone-200 bg-white px-4 py-4">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-5"><MozziBrand /><span className="border-l border-stone-200 pl-5 text-xs text-stone-500">Control central</span></div>
          <div className="flex items-center gap-3"><NavLink to="/admin" className="button-secondary"><ArrowLeft className="h-4 w-4" aria-hidden />Panel del comercio</NavLink><button className="button-quiet" onClick={() => void auth.signOut()}>Salir</button></div>
        </div>
      </header>
      <nav className="border-b border-stone-200 bg-white" aria-label="Super administración"><div className="mx-auto flex max-w-7xl gap-1 overflow-x-auto px-4 py-2">{links.map(([to, label, Icon], index) => <NavLink key={to} to={to} end={index === 0} className={({ isActive }) => `admin-nav-link shrink-0 ${isActive ? 'is-active' : ''}`}><Icon aria-hidden />{label}</NavLink>)}</div></nav>
      <main id="admin-content" tabIndex={-1} className="admin-content max-w-7xl"><Outlet /></main>
    </div>
  )
}
