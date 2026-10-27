import { Building2 } from 'lucide-react'
import { Navigate, useNavigate } from 'react-router'
import { EmptyState, LoadingScreen } from '../../components/Feedback'
import { MozziBrand } from '../../components/MozziBrand'
import {
  SUPER_ADMIN_HOME,
  superAdminEntryDestination,
} from '../auth/access-routing'
import { useAuth } from '../auth/AuthProvider'
import { useRestaurantScope } from './RestaurantScope'

export function RestaurantSelectPage() {
  const auth = useAuth()
  const scope = useRestaurantScope()
  const navigate = useNavigate()
  if (auth.isSuperAdmin) {
    return (
      <Navigate
        to={superAdminEntryDestination(auth.assuranceLevel, SUPER_ADMIN_HOME)}
        replace
      />
    )
  }
  if (scope.loading) return <LoadingScreen label="Buscando tus comercios…" />
  if (scope.choices.length === 1) return <Navigate to="/admin" replace />
  return <main className="admin-app px-5 py-14"><div className="mx-auto max-w-2xl"><MozziBrand /><h1 className="mt-10 text-3xl font-semibold tracking-tight">Elegí un comercio</h1><p className="mt-2 text-sm text-stone-500">Seleccioná el comercio que querés administrar.</p>{scope.choices.length === 0 ? <div className="mt-8"><EmptyState title="No tenés comercios activos" description="Pedile acceso a un administrador de Mozzi o revisá tu invitación." /></div> : <div className="mt-8 space-y-3">{scope.choices.map(choice => <button key={choice.id} className="surface-card flex min-h-20 w-full items-center gap-4 p-5 text-left hover:border-stone-400" onClick={() => { scope.selectRestaurant(choice.id); navigate('/admin') }}><Building2 className="h-5 w-5 text-stone-400" aria-hidden /><span><strong className="block font-semibold">{choice.name}</strong><small className="text-stone-500">{choice.role === 'order_manager' ? 'Gestión de pedidos' : 'Administración del comercio'}</small></span></button>)}</div>}</div></main>
}
