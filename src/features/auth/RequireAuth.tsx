import { Navigate, Outlet, useLocation } from 'react-router'
import { ErrorPanel, LoadingScreen } from '../../components/Feedback'
import { useAuth } from './AuthProvider'

interface RequireAuthProps {
  superAdmin?: boolean
}

export function RequireAuth({ superAdmin = false }: RequireAuthProps) {
  const auth = useAuth()
  const location = useLocation()

  if (auth.loading) return <LoadingScreen label="Verificando acceso…" />
  if (!auth.user) {
    const returnTo = `${location.pathname}${location.search}`
    return <Navigate to={`/login?returnTo=${encodeURIComponent(returnTo)}`} replace />
  }
  if (auth.accessError) {
    return (
      <main className="page-shell py-16">
        <ErrorPanel
          action={
            <button
              className="button-secondary"
              type="button"
              onClick={() => void auth.refreshAccess()}
            >
              Reintentar
            </button>
          }
        >
          {auth.accessError}
        </ErrorPanel>
      </main>
    )
  }
  if (!auth.profile?.active) {
    return (
      <main className="page-shell py-16">
        <ErrorPanel title="Acceso deshabilitado">
          Tu perfil no está activo. Contactá a un administrador o cerrá la sesión.
          <button
            className="button-secondary mt-4"
            type="button"
            onClick={() => void auth.signOut()}
          >
            Cerrar sesión
          </button>
        </ErrorPanel>
      </main>
    )
  }
  if (superAdmin && !auth.isSuperAdmin) return <Navigate to="/admin" replace />
  if (superAdmin && auth.assuranceLevel !== 'aal2') {
    return (
      <Navigate
        to={`/auth/mfa?returnTo=${encodeURIComponent(location.pathname)}`}
        replace
      />
    )
  }
  return <Outlet />
}
