import { Building2 } from 'lucide-react'
import { Navigate, useNavigate } from 'react-router'
import { EmptyState, LoadingScreen } from '../../components/Feedback'
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
  if (scope.loading) return <LoadingScreen label="Buscando tus restaurantes…" />
  if (scope.choices.length === 1) return <Navigate to="/admin" replace />
  return <main className="min-h-screen bg-stone-100 p-4 py-14"><div className="mx-auto max-w-3xl"><h1 className="font-display text-4xl font-bold">Elegí un restaurante</h1><p className="mt-2 text-stone-600">La selección organiza la interfaz; cada consulta sigue protegida por RLS.</p>{scope.choices.length === 0 ? <div className="mt-8"><EmptyState title="No tenés restaurantes activos" description="Pedile acceso a un Super Admin o revisá el estado de tu invitación." /></div> : <div className="mt-8 grid gap-3 sm:grid-cols-2">{scope.choices.map((choice) => <button key={choice.id} className="flex min-h-28 items-center gap-4 rounded-3xl border border-stone-200 bg-white p-5 text-left shadow-sm hover:border-orange-400 hover:shadow-md" onClick={() => { scope.selectRestaurant(choice.id); navigate('/admin') }}><span className="grid h-12 w-12 place-items-center rounded-2xl bg-orange-100 text-orange-700"><Building2 aria-hidden /></span><span><strong className="block font-display text-lg">{choice.name}</strong><small className="text-stone-500">{choice.role.replace('_', ' ')} · {choice.status}</small></span></button>)}</div>}</div></main>
}
