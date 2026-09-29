import { describe, expect, it } from 'vitest'
import { mergeRestaurantMembersWithProfiles } from './member-directory'

const member = {
  id: '10000000-0000-4000-8000-000000000001',
  user_id: '20000000-0000-4000-8000-000000000001',
  role: 'restaurant_admin' as const,
  status: 'active' as const,
  created_at: '2026-09-29T12:00:00.000Z',
}

describe('restaurant member directory', () => {
  it('merges separately authorized member and profile reads by user id', () => {
    expect(mergeRestaurantMembersWithProfiles([member], [{
      id: member.user_id,
      full_name: 'Admin de prueba',
      email: 'admin@example.com',
      active: true,
    }])).toEqual([{
      ...member,
      profiles: {
        full_name: 'Admin de prueba',
        email: 'admin@example.com',
        active: true,
      },
    }])
  })

  it('keeps a membership visible when its profile is absent or not visible through RLS', () => {
    expect(mergeRestaurantMembersWithProfiles([member], [])).toEqual([{
      ...member,
      profiles: null,
    }])
  })
})
