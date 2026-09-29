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

const navGroups = [
  {
    label: 'Operación',
    links: [
      { to: '/admin', label: 'Resumen', icon: LayoutDashboard, end: true },
      { to: '/admin/pedidos', label: 'Pedidos', icon: ClipboardList },
    ],
  },
  {
    label: 'Catálogo',
    links: [
      { to: '/admin/catalogo/productos', label: 'Productos', icon: PackageOpen, adminOnly: true },
      { to: '/admin/catalogo/categorias', label: 'Categorías', icon: BookOpen, adminOnly: true },
      { to: '/admin/catalogo/importar', label: 'Importar', icon: Upload, adminOnly: true },
    ],
  },
  {
    label: 'Configuración',
    links: [
      { to: '/admin/horarios', label: 'Horarios', icon: CalendarClock, adminOnly: true },
      { to: '/admin/medios-de-pago', label: 'Medios de pago', icon: BadgeDollarSign, adminOnly: true },
      { to: '/admin/zonas-de-envio', label: 'Zonas de envío', icon: MapPinned, adminOnly: true },
      { to: '/admin/marca', label: 'Marca', icon: Palette, adminOnly: true },
      { to: '/admin/configuracion', label: 'Configuración', icon: Settings, adminOnly: true },
      { to: '/admin/usuarios', label: 'Usuarios', icon: Users, adminOnly: true },
      { to: '/admin/seguridad', label: 'Seguridad', icon: ShieldCheck },
    ],
  },
] as const

function userInitials(name: string | undefined) {
  return (name ?? 'M')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('') || 'M'
}

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
    <div className="min-h-screen bg-[#f7f5f2] text-stone-950">
      <header className="sticky top-0 z-40 flex h-16 items-center justify-between border-b border-stone-200 bg-white/95 px-4 backdrop-blur lg:hidden">
        <button className="icon-button" onClick={() => setOpen(true)} aria-label="Abrir navegación">
          <Menu className="h-5 w-5" aria-hidden />
        </button>
        <span className="flex items-center gap-2 font-display text-lg font-bold">
          <span className="grid h-8 w-8 place-items-center rounded-xl bg-orange-600 text-white"><Store className="h-4 w-4" aria-hidden /></span>
          Mozzi
        </span>
        <span className="grid h-10 w-10 place-items-center rounded-xl bg-stone-100 text-xs font-bold text-stone-700" aria-hidden>
          {userInitials(auth.profile?.fullName ?? auth.user?.email)}
        </span>
      </header>

      <aside className={`fixed inset-y-0 left-0 z-50 flex w-72 flex-col border-r border-stone-800 bg-stone-950 text-stone-100 shadow-2xl transition-transform duration-150 lg:translate-x-0 lg:shadow-none ${open ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="flex h-20 items-center justify-between px-5">
          <div className="flex items-center gap-3">
            <span className="grid h-11 w-11 place-items-center rounded-2xl bg-orange-600 text-white shadow-lg shadow-orange-950/20"><Store className="h-5 w-5" aria-hidden /></span>
            <div><p className="font-display text-xl font-bold tracking-tight">Mozzi</p><p className="text-[11px] font-medium text-stone-400">Gestión gastronómica</p></div>
          </div>
          <button className="icon-button-dark lg:hidden" onClick={() => setOpen(false)} aria-label="Cerrar navegación"><X className="h-5 w-5" aria-hidden /></button>
        </div>

        <div className="mx-3 mb-2 rounded-2xl border border-stone-800 bg-stone-900/80 p-3.5">
          <div className="flex items-center gap-2 text-stone-400"><Store className="h-3.5 w-3.5" aria-hidden /><label className="text-[10px] font-bold uppercase tracking-[.14em]" htmlFor="restaurant-select">Restaurante activo</label></div>
          <div className="relative mt-2">
            <select id="restaurant-select" className="min-h-8 w-full appearance-none bg-transparent pr-7 text-sm font-semibold text-white outline-none" value={scope.selected?.id ?? ''} onChange={(event) => scope.selectRestaurant(event.target.value)}>
              {scope.choices.map((choice) => <option className="bg-stone-900" value={choice.id} key={choice.id}>{choice.name}</option>)}
            </select>
            <ChevronDown className="pointer-events-none absolute right-0 top-1.5 h-4 w-4 text-stone-400" aria-hidden />
          </div>
        </div>

        <nav className="scrollbar-none flex-1 space-y-5 overflow-y-auto px-3 py-3" aria-label="Administración">
          {navGroups.map((group) => {
            const visibleLinks = group.links.filter((link) => !('adminOnly' in link) || scope.selected?.role !== 'order_manager')
            if (visibleLinks.length === 0) return null
            return <div key={group.label}>
              <p className="mb-1.5 px-3 text-[10px] font-bold uppercase tracking-[.16em] text-stone-500">{group.label}</p>
              <div className="space-y-1">{visibleLinks.map((link) => {
                const { to, label, icon: Icon } = link
                return <NavLink key={to} to={to} end={'end' in link ? link.end : false} onClick={() => setOpen(false)} className={({ isActive }) => `flex min-h-10 items-center gap-3 rounded-xl px-3 text-sm font-medium transition duration-150 ${isActive ? 'bg-orange-500/15 text-orange-100 ring-1 ring-inset ring-orange-400/20' : 'text-stone-300 hover:bg-stone-900 hover:text-white'}`}>
                  <Icon className="h-[1.125rem] w-[1.125rem]" aria-hidden />{label}
                </NavLink>
              })}</div>
            </div>
          })}
          {auth.isSuperAdmin ? <NavLink to="/superadmin" className="flex min-h-10 items-center gap-3 rounded-xl border border-stone-700 px-3 text-sm font-semibold text-orange-300 transition hover:border-stone-600 hover:bg-stone-900"><ShieldCheck className="h-[1.125rem] w-[1.125rem]" aria-hidden />Super Admin</NavLink> : null}
        </nav>
        <div className="border-t border-stone-800 p-3">
          <div className="flex items-center gap-3 rounded-2xl bg-stone-900/70 p-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-stone-800 text-xs font-bold text-orange-200">{userInitials(auth.profile?.fullName ?? auth.user?.email)}</span>
            <div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{auth.profile?.fullName ?? auth.user?.email}</p><p className="truncate text-[11px] capitalize text-stone-400">{scope.selected?.role.replace('_', ' ')}</p></div>
            <button className="icon-button-dark !h-9 !w-9" onClick={() => void auth.signOut()} aria-label="Cerrar sesión"><LogOut className="h-4 w-4" aria-hidden /></button>
          </div>
        </div>
      </aside>
      {open ? <button className="fixed inset-0 z-40 bg-black/50 lg:hidden" aria-label="Cerrar navegación" onClick={() => setOpen(false)} /> : null}
      <main className="lg:pl-72"><div className="mx-auto max-w-[1500px] p-4 sm:p-6 lg:p-8 xl:p-10"><Outlet key={scope.selected?.id} /></div></main>
    </div>
  )
}
