import type { Membership } from '../../types/domain'

export const SUPER_ADMIN_HOME = '/superadmin/restaurantes'
export const RESTAURANT_ADMIN_HOME = '/admin'
export const RESTAURANT_SELECT_PATH = '/admin/seleccionar-restaurante'

type AssuranceLevel = 'aal1' | 'aal2' | null

interface PostLoginDestinationInput {
  isSuperAdmin: boolean
  assuranceLevel: AssuranceLevel
  memberships: Membership[]
  requestedPath?: string | null
}

export type MfaStep = 'enroll' | 'challenge' | 'complete'

export function superAdminEntryDestination(
  assuranceLevel: AssuranceLevel,
  returnTo = SUPER_ADMIN_HOME,
): string {
  if (assuranceLevel === 'aal2') return returnTo
  return `/auth/mfa?returnTo=${encodeURIComponent(returnTo)}`
}

export function resolvePostLoginDestination({
  isSuperAdmin,
  assuranceLevel,
  memberships,
  requestedPath,
}: PostLoginDestinationInput): string {
  if (isSuperAdmin) {
    const superAdminTarget = requestedPath?.startsWith('/superadmin')
      ? requestedPath
      : SUPER_ADMIN_HOME
    return superAdminEntryDestination(assuranceLevel, superAdminTarget)
  }

  const activeMemberships = memberships.filter(
    (membership) => membership.status === 'active',
  )
  if (activeMemberships.length !== 1) return RESTAURANT_SELECT_PATH

  if (requestedPath?.startsWith('/admin')) return requestedPath
  return RESTAURANT_ADMIN_HOME
}

export function resolveMfaStep(
  assuranceLevel: AssuranceLevel,
  hasVerifiedTotp: boolean,
): MfaStep {
  if (assuranceLevel === 'aal2') return 'complete'
  return hasVerifiedTotp ? 'challenge' : 'enroll'
}
