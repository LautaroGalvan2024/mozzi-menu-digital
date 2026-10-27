import { BadgeDollarSign, BookOpen, CalendarClock, ChevronDown, ClipboardList, LayoutDashboard, LogOut, MapPinned, Menu, PackageOpen, Palette, Settings, ShieldCheck, ShoppingBag, Store, Upload, Users, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { NavLink, Navigate, Outlet, useLocation } from 'react-router'
import { SUPER_ADMIN_HOME, superAdminEntryDestination } from '../features/auth/access-routing'
import { useAuth } from '../features/auth/AuthProvider'
import { useRestaurantScope } from '../features/restaurants/RestaurantScope'
import { MozziBrand } from './MozziBrand'

const mainLinks = [
  { to: '/admin', label: 'Inicio', icon: LayoutDashboard, end: true },
  { to: '/admin/pedidos', label: 'Pedidos', icon: ClipboardList },
  { to: '/admin/catalogo/productos', label: 'Productos', icon: PackageOpen, adminOnly: true },
  { to: '/admin/stock', label: 'Stock', icon: BookOpen },
  { to: '/admin/tienda', label: 'Tienda online', icon: ShoppingBag, adminOnly: true },
] as const
const secondaryGroups = [
  { label: 'Organizar catálogo', icon: BookOpen, links: [
    { to: '/admin/catalogo/categorias', label: 'Categorías', icon: BookOpen },
    { to: '/admin/catalogo/importar', label: 'Importar productos', icon: Upload },
  ] },
  { label: 'Configuración', icon: Settings, links: [
    { to: '/admin/configuracion', label: 'Datos del comercio', icon: Store },
    { to: '/admin/horarios', label: 'Horarios', icon: CalendarClock },
    { to: '/admin/medios-de-pago', label: 'Medios de pago', icon: BadgeDollarSign },
    { to: '/admin/zonas-de-envio', label: 'Zonas de envío', icon: MapPinned },
    { to: '/admin/marca', label: 'Logo y portada', icon: Palette },
    { to: '/admin/usuarios', label: 'Equipo y permisos', icon: Users },
  ] },
] as const
const initials = (name: string | undefined) => (name ?? 'M').split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]?.toUpperCase()).join('') || 'M'

export function AdminLayout() {
  const auth = useAuth()
  const scope = useRestaurantScope()
  const location = useLocation()
  const [open, setOpen] = useState(false)
  const sidebar = useRef<HTMLElement>(null)
  const menuButton = useRef<HTMLButtonElement>(null)
  const isManager = scope.selected?.role === 'order_manager'
  const allLinks = [...mainLinks, ...secondaryGroups.flatMap(group => group.links.map(link => ({ to: link.to, label: link.label }))), { to: '/admin/seguridad', label: 'Seguridad' }]
  const currentSection = [...allLinks].sort((a, b) => b.to.length - a.to.length).find(link => location.pathname === link.to || (link.to !== '/admin' && location.pathname.startsWith(`${link.to}/`)))?.label ?? 'Administración'

  useEffect(() => {
    const resized = () => { if (window.innerWidth >= 1024) setOpen(false) }
    window.addEventListener('resize', resized)
    return () => window.removeEventListener('resize', resized)
  }, [])
  useEffect(() => {
    if (!open) return
    const trigger = menuButton.current
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const focusables = () => Array.from(sidebar.current?.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),select,summary') ?? []).filter(element => element.getClientRects().length > 0)
    focusables()[0]?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setOpen(false) }
      if (event.key !== 'Tab') return
      const elements = focusables(); const first = elements[0]; const last = elements.at(-1)
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    document.addEventListener('keydown', onKey)
    return () => { document.body.style.overflow = previousOverflow; document.removeEventListener('keydown', onKey); trigger?.focus() }
  }, [open])

  if (auth.isSuperAdmin && auth.assuranceLevel !== 'aal2') return <Navigate to={superAdminEntryDestination(auth.assuranceLevel, SUPER_ADMIN_HOME)} replace />
  if (!scope.loading && !scope.selected) return <Navigate to={auth.isSuperAdmin ? SUPER_ADMIN_HOME : '/admin/seleccionar-restaurante'} replace />

  return <div className="admin-app">
    <a className="admin-skip-link" href="#admin-content">Ir al contenido</a>
    <aside ref={sidebar} className={`admin-sidebar ${open ? 'is-open' : ''}`} role={open ? 'dialog' : undefined} aria-modal={open ? true : undefined} aria-label="Navegación del panel" id="admin-navigation">
      <div className="admin-sidebar-brand"><MozziBrand /><button type="button" className="icon-button lg:hidden" onClick={() => setOpen(false)} aria-label="Cerrar navegación"><X className="h-5 w-5" aria-hidden /></button></div>
      <div className="admin-commerce-switch">
        <label htmlFor="restaurant-select">Tu comercio</label>
        <div className="relative"><select id="restaurant-select" value={scope.selected?.id ?? ''} onChange={event => { scope.selectRestaurant(event.target.value); setOpen(false) }}>{scope.choices.map(choice => <option value={choice.id} key={choice.id}>{choice.name}</option>)}</select><ChevronDown className="pointer-events-none absolute right-0 top-2 h-4 w-4" aria-hidden /></div>
      </div>
      <nav className="admin-navigation" aria-label="Administración">
        <div className="admin-nav-primary">{mainLinks.filter(link => !('adminOnly' in link) || !isManager).map(({ to, label, icon: Icon, ...link }) => <NavLink key={to} to={to} end={'end' in link ? link.end : false} onClick={() => setOpen(false)} className={({ isActive }) => `admin-nav-link ${isActive ? 'is-active' : ''}`}><Icon aria-hidden />{label}</NavLink>)}</div>
        {!isManager ? <div className="admin-nav-secondary">{secondaryGroups.map(group => {
          const active = group.links.some(link => location.pathname === link.to)
          const Icon = group.icon
          return <details className="admin-nav-group" key={`${group.label}:${active}`} open={active || undefined}>
            <summary><Icon aria-hidden /><span>{group.label}</span><ChevronDown className="admin-nav-chevron" aria-hidden /></summary>
            <div>{group.links.map(link => <NavLink key={link.to} to={link.to} onClick={() => setOpen(false)} className={({ isActive }) => `admin-nav-link ${isActive ? 'is-active' : ''}`}>{link.label}</NavLink>)}</div>
          </details>
        })}</div> : null}
        {auth.isSuperAdmin ? <NavLink className="admin-nav-link mt-4" to="/superadmin"><ShieldCheck aria-hidden />Control central</NavLink> : null}
      </nav>
      <div className="admin-account">
        <div className="admin-account-person"><span className="admin-avatar" aria-hidden>{initials(auth.profile?.fullName ?? auth.user?.email)}</span><div><strong>{auth.profile?.fullName ?? auth.user?.email}</strong><span>{isManager ? 'Gestión de pedidos' : 'Administración'}</span></div></div>
        <div className="flex items-center justify-between"><NavLink to="/admin/seguridad" onClick={() => setOpen(false)} className="admin-account-action"><ShieldCheck aria-hidden />Mi seguridad</NavLink><button className="admin-account-action" type="button" onClick={() => void auth.signOut()}><LogOut aria-hidden />Salir</button></div>
      </div>
    </aside>
    {open ? <button type="button" className="admin-nav-backdrop" aria-hidden="true" tabIndex={-1} onClick={() => setOpen(false)} /> : null}
    <div className="admin-workspace" inert={open}>
      <header className="admin-topbar">
        <button ref={menuButton} className="icon-button lg:hidden" type="button" onClick={() => setOpen(true)} aria-label="Abrir navegación" aria-expanded={open} aria-controls="admin-navigation"><Menu className="h-5 w-5" aria-hidden /></button>
        <div className="admin-breadcrumb"><span>{scope.selected?.name}</span><span aria-hidden>/</span><strong>{currentSection}</strong></div>
        <span className="ml-auto sm:hidden"><MozziBrand compact /></span>
        <span className="admin-workspace-label">Panel de gestión</span>
      </header>
      <main id="admin-content" tabIndex={-1} className="admin-content"><Outlet key={scope.selected?.id} /></main>
    </div>
  </div>
}
