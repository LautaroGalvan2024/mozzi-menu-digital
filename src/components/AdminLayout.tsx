import {
  BadgeDollarSign,
  BookOpen,
  CalendarClock,
  ChevronDown,
  ClipboardList,
  LayoutDashboard,
  LogOut,
  MapPinned,
  Menu,
  PackageOpen,
  Palette,
  Settings,
  ShieldCheck,
  Store,
  Upload,
  Users,
  X,
} from 'lucide-react'
import { useState } from 'react'
import { NavLink, Navigate, Outlet } from 'react-router'
import {
  SUPER_ADMIN_HOME,
  superAdminEntryDestination,
} from '../features/auth/access-routing'
import { useAuth } from '../features/auth/AuthProvider'
import { useRestaurantScope } from '../features/restaurants/RestaurantScope'

const links = [
  { to: '/admin', label: 'Resumen', icon: LayoutDashboard, end: true },
  { to: '/admin/pedidos', label: 'Pedidos', icon: ClipboardList },
  { to: '/admin/catalogo/productos', label: 'Productos', icon: PackageOpen, adminOnly: true },
  { to: '/admin/catalogo/categorias', label: 'Categorías', icon: BookOpen, adminOnly: true },
  { to: '/admin/catalogo/importar', label: 'Importar', icon: Upload, adminOnly: true },
  { to: '/admin/horarios', label: 'Horarios', icon: CalendarClock, adminOnly: true },
  { to: '/admin/medios-de-pago', label: 'Medios de pago', icon: BadgeDollarSign, adminOnly: true },
  { to: '/admin/zonas-de-envio', label: 'Zonas de envío', icon: MapPinned, adminOnly: true },
  { to: '/admin/marca', label: 'Marca', icon: Palette, adminOnly: true },
  { to: '/admin/configuracion', label: 'Configuración', icon: Settings, adminOnly: true },
  { to: '/admin/usuarios', label: 'Usuarios', icon: Users, adminOnly: true },
  { to: '/admin/seguridad', label: 'Seguridad', icon: ShieldCheck },
] as const

export function AdminLayout() {
  const auth = useAuth()
  const scope = useRestaurantScope()
  const [open, setOpen] = useState(false)

  if (auth.isSuperAdmin && auth.assuranceLevel !== 'aal2') {
    return (
      <Navigate
        to={superAdminEntryDestination(auth.assuranceLevel, SUPER_ADMIN_HOME)}
        replace
      />
    )
  }
  if (!scope.loading && !scope.selected) {
    return (
      <Navigate
        to={auth.isSuperAdmin ? SUPER_ADMIN_HOME : '/admin/seleccionar-restaurante'}
        replace
      />
    )
  }

  return (
    <div className="min-h-screen bg-stone-100 text-stone-950">
      <header className="sticky top-0 z-40 flex h-16 items-center justify-between border-b border-stone-200 bg-white/95 px-4 backdrop-blur lg:hidden">
        <button className="icon-button" onClick={() => setOpen(true)} aria-label="Abrir navegación"><Menu aria-hidden /></button>
        <span className="font-display text-lg font-bold">Mozzi Admin</span>
        <span className="h-10 w-10 rounded-full bg-orange-100" aria-hidden />
      </header>

      <aside className={`fixed inset-y-0 left-0 z-50 flex w-72 flex-col border-r border-stone-200 bg-stone-950 text-stone-100 transition-transform lg:translate-x-0 ${open ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="flex h-20 items-center justify-between px-6">
          <div className="flex items-center gap-3"><span className="grid h-10 w-10 place-items-center rounded-2xl bg-orange-600"><Store className="h-5 w-5" aria-hidden /></span><div><p className="font-display text-xl font-bold">Mozzi</p><p className="text-xs text-stone-400">Panel del comercio</p></div></div>
          <button className="icon-button-dark lg:hidden" onClick={() => setOpen(false)} aria-label="Cerrar navegación"><X aria-hidden /></button>
        </div>

        <div className="mx-4 mb-3 rounded-2xl border border-stone-800 bg-stone-900 p-3">
          <label className="text-xs font-medium text-stone-400" htmlFor="restaurant-select">Restaurante</label>
          <div className="relative mt-1">
            <select id="restaurant-select" className="w-full appearance-none bg-transparent pr-7 text-sm font-semibold outline-none" value={scope.selected?.id ?? ''} onChange={(event) => scope.selectRestaurant(event.target.value)}>
              {scope.choices.map((choice) => <option className="bg-stone-900" value={choice.id} key={choice.id}>{choice.name}</option>)}
            </select>
            <ChevronDown className="pointer-events-none absolute right-0 top-1 h-4 w-4" aria-hidden />
          </div>
        </div>

        <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-2" aria-label="Administración">
          {links.filter((link) => !('adminOnly' in link) || scope.selected?.role !== 'order_manager').map((link) => {
            const { to, label, icon: Icon } = link
            return (
            <NavLink key={to} to={to} end={'end' in link ? link.end : false} onClick={() => setOpen(false)} className={({ isActive }) => `flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm font-medium transition ${isActive ? 'bg-orange-600 text-white' : 'text-stone-300 hover:bg-stone-800 hover:text-white'}`}>
              <Icon className="h-4.5 w-4.5" aria-hidden />{label}
            </NavLink>
          )})}
          {auth.isSuperAdmin ? <NavLink to="/superadmin" className="mt-4 flex min-h-11 items-center gap-3 rounded-xl border border-stone-700 px-3 text-sm font-semibold text-orange-300 hover:bg-stone-800"><ShieldCheck className="h-4.5 w-4.5" aria-hidden />Super Admin</NavLink> : null}
        </nav>
        <div className="border-t border-stone-800 p-4">
          <p className="truncate text-sm font-semibold">{auth.profile?.fullName ?? auth.user?.email}</p>
          <p className="truncate text-xs text-stone-400">{scope.selected?.role.replace('_', ' ')}</p>
          <button className="mt-3 flex items-center gap-2 text-sm text-stone-300 hover:text-white" onClick={() => void auth.signOut()}><LogOut className="h-4 w-4" aria-hidden />Cerrar sesión</button>
        </div>
      </aside>
      {open ? <button className="fixed inset-0 z-40 bg-black/50 lg:hidden" aria-label="Cerrar navegación" onClick={() => setOpen(false)} /> : null}
      <main className="lg:pl-72"><div className="mx-auto max-w-[1500px] p-4 sm:p-6 lg:p-8"><Outlet key={scope.selected?.id} /></div></main>
    </div>
  )
}
