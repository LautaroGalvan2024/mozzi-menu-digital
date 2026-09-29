import { ArrowLeft, Building2, LayoutDashboard, ScrollText, ShieldCheck, Users } from 'lucide-react'
import { NavLink, Outlet } from 'react-router'
import { useAuth } from '../features/auth/AuthProvider'

const links = [
  ['/superadmin', 'Resumen', LayoutDashboard],
  ['/superadmin/restaurantes', 'Restaurantes', Building2],
  ['/superadmin/usuarios', 'Usuarios', Users],
  ['/superadmin/auditoria', 'Auditoría', ScrollText],
  ['/superadmin/seguridad', 'Seguridad', ShieldCheck],
] as const

export function SuperAdminLayout() {
  const auth = useAuth()
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800 bg-slate-950/95 px-4 py-4 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4">
          <div><p className="font-display text-xl font-bold">Mozzi · Control central</p><p className="text-xs text-slate-400">Sesión protegida con AAL2</p></div>
          <div className="flex items-center gap-3"><NavLink to="/admin" className="button-secondary-dark"><ArrowLeft className="h-4 w-4" aria-hidden />Panel restaurante</NavLink><button className="text-sm text-slate-300 hover:text-white" onClick={() => void auth.signOut()}>Salir</button></div>
        </div>
      </header>
      <nav className="border-b border-slate-800 bg-slate-900" aria-label="Super administración"><div className="mx-auto flex max-w-7xl gap-1 overflow-x-auto px-4 py-2">{links.map(([to, label, Icon], index) => <NavLink key={to} to={to} end={index === 0} className={({ isActive }) => `flex min-h-10 shrink-0 items-center gap-2 rounded-lg px-3 text-sm ${isActive ? 'bg-orange-600 text-white' : 'text-slate-300 hover:bg-slate-800'}`}><Icon className="h-4 w-4" aria-hidden />{label}</NavLink>)}</div></nav>
      <main className="mx-auto max-w-7xl px-4 py-8"><Outlet /></main>
    </div>
  )
}
