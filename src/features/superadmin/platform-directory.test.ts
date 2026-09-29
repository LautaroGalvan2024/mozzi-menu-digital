import { describe, expect, it } from 'vitest'
import { mergePlatformDirectory } from './platform-directory'

describe('platform user directory', () => {
  it('joins global roles and restaurant memberships by secure user id', () => {
    const userId = '10000000-0000-4000-8000-000000000001'
    expect(mergePlatformDirectory(
      [{ id: userId, full_name: 'Super Admin', email: 'admin@example.com', active: true, created_at: '2026-09-29T12:00:00.000Z' }],
      [{ user_id: userId, role: 'super_admin' }],
      [{ user_id: userId, role: 'restaurant_admin', status: 'active', restaurants: { name: 'Restaurante de prueba' } }],
    )).toEqual([{
      id: userId,
      full_name: 'Super Admin',
      email: 'admin@example.com',
      active: true,
      created_at: '2026-09-29T12:00:00.000Z',
      platform_user_roles: [{ role: 'super_admin' }],
      restaurant_members: [{ role: 'restaurant_admin', status: 'active', restaurants: { name: 'Restaurante de prueba' } }],
    }])
  })
})
