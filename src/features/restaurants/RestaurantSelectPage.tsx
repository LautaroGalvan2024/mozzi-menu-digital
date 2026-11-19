import { Building2, ChevronRight } from 'lucide-react'
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
  return <main className="admin-app admin-auth">
    <div className="admin-auth-layout">
      <div className="admin-auth-brand"><MozziBrand /></div>
      <h1 className="mb-4 text-2xl font-bold tracking-tight">Elegí un comercio</h1>
      {scope.choices.length === 0
        ? <EmptyState title="No tenés comercios activos" description="Pedile acceso a un administrador de Mozzi o revisá tu invitación." />
        : <ul className="admin-team-list surface-card" aria-label="Tus comercios">
          {scope.choices.map(choice => <li key={choice.id}>
            <button className="admin-merchant-choice" type="button" onClick={() => { scope.selectRestaurant(choice.id); navigate('/admin') }}>
              <span className="admin-record-icon" aria-hidden><Building2 size={18} /></span>
              <span><strong>{choice.name}</strong><small>{choice.role === 'order_manager' ? 'Gestión de pedidos' : 'Administración del comercio'}</small></span>
              <ChevronRight size={18} aria-hidden />
            </button>
          </li>)}
        </ul>}
    </div>
  </main>
}
