import { describe, expect, it } from 'vitest'
import type { Membership } from '../../types/domain'
import { resolveSelectedChoice } from '../restaurants/selection'
import {
  resolveMfaStep,
  resolvePostLoginDestination,
  RESTAURANT_ADMIN_HOME,
  RESTAURANT_SELECT_PATH,
  SUPER_ADMIN_HOME,
} from './access-routing'

function membership(id: string): Membership {
  return {
    id,
    restaurantId: id,
    restaurantName: `Restaurante ${id}`,
    restaurantSlug: `restaurante-${id}`,
    restaurantStatus: 'active',
    role: 'restaurant_admin',
    status: 'active',
  }
}

describe('authenticated access routing', () => {
  it('sends a Super Admin without restaurant memberships to the global panel', () => {
    expect(
      resolvePostLoginDestination({
        isSuperAdmin: true,
        assuranceLevel: 'aal2',
        memberships: [],
      }),
    ).toBe(SUPER_ADMIN_HOME)
  })

  it('sends a Super Admin without enrolled MFA to enrollment', () => {
    expect(resolveMfaStep('aal1', false)).toBe('enroll')
    expect(
      resolvePostLoginDestination({
        isSuperAdmin: true,
        assuranceLevel: 'aal1',
        memberships: [],
      }),
    ).toBe('/auth/mfa?returnTo=%2Fsuperadmin%2Frestaurantes')
  })

  it('sends a Super Admin with enrolled MFA at AAL1 to the challenge', () => {
    expect(resolveMfaStep('aal1', true)).toBe('challenge')
    expect(
      resolvePostLoginDestination({
        isSuperAdmin: true,
        assuranceLevel: 'aal1',
        memberships: [],
      }),
    ).toBe('/auth/mfa?returnTo=%2Fsuperadmin%2Frestaurantes')
  })

  it('sends a Super Admin at AAL2 to the global panel', () => {
    expect(resolveMfaStep('aal2', true)).toBe('complete')
    expect(
      resolvePostLoginDestination({
        isSuperAdmin: true,
        assuranceLevel: 'aal2',
        memberships: [],
      }),
    ).toBe(SUPER_ADMIN_HOME)
  })

  it('shows the empty membership state to a Restaurant Admin without memberships', () => {
    expect(
      resolvePostLoginDestination({
        isSuperAdmin: false,
        assuranceLevel: 'aal1',
        memberships: [],
      }),
    ).toBe(RESTAURANT_SELECT_PATH)
  })

  it('enters automatically for a Restaurant Admin with one active membership', () => {
    expect(
      resolvePostLoginDestination({
        isSuperAdmin: false,
        assuranceLevel: 'aal1',
        memberships: [membership('10000000-0000-4000-8000-000000000001')],
      }),
    ).toBe(RESTAURANT_ADMIN_HOME)
  })

  it('requires an explicit choice for a Restaurant Admin with several memberships', () => {
    const memberships = [
      membership('10000000-0000-4000-8000-000000000001'),
      membership('10000000-0000-4000-8000-000000000002'),
    ]
    expect(
      resolvePostLoginDestination({
        isSuperAdmin: false,
        assuranceLevel: 'aal1',
        memberships,
      }),
    ).toBe(RESTAURANT_SELECT_PATH)
    expect(resolveSelectedChoice(memberships, null, false)).toBeNull()
  })
})
