import { Navigate } from 'react-router'
import { ErrorPanel, LoadingScreen } from '../../components/Feedback'
import { resolvePostLoginDestination } from './access-routing'
import { useAuth } from './AuthProvider'

export function AuthenticatedEntryPage() {
  const auth = useAuth()

  if (auth.loading) return <LoadingScreen label="Verificando tu acceso…" />
  if (!auth.user) return <Navigate to="/login" replace />
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

  return (
    <Navigate
      to={resolvePostLoginDestination({
        isSuperAdmin: auth.isSuperAdmin,
        assuranceLevel: auth.assuranceLevel,
        memberships: auth.memberships,
      })}
      replace
    />
  )
}
