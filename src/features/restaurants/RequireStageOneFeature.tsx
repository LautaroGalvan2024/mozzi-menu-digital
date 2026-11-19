import { Navigate, Outlet } from 'react-router'
import { ErrorPanel, LoadingScreen } from '../../components/Feedback'
import { useRestaurantScope } from './RestaurantScope'
import { useStageOneFeatures, type StageOneFeature } from './stage-one-features'

export function RequireStageOneFeature({ feature }: { feature: StageOneFeature }) {
  const { selected, loading: scopeLoading } = useRestaurantScope()
  const { features, loading, error, retry } = useStageOneFeatures(selected?.id)
  if (scopeLoading || loading) return <LoadingScreen label="Cargando funciones del comercio…" />
  if (error) return <ErrorPanel action={<button className="button-secondary" type="button" onClick={() => void retry()}>Volver a intentar</button>}>
    No pudimos consultar las funciones de este comercio.
  </ErrorPanel>
  return features[feature] ? <Outlet /> : <Navigate to="/admin" replace />
}
