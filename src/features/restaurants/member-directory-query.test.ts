import { beforeEach, describe, expect, it, vi } from 'vitest'
import { listRestaurantMembers } from './member-directory'

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  memberSelect: vi.fn(),
  profileSelect: vi.fn(),
  memberEq: vi.fn(),
  memberOrder: vi.fn(),
  profileIn: vi.fn(),
}))

vi.mock('../../lib/supabase/client', () => ({
  supabase: { from: mocks.from },
}))

const restaurantId = '10000000-0000-4000-8000-000000000001'
const userId = '20000000-0000-4000-8000-000000000001'

describe('restaurant member queries', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset())

    mocks.memberOrder.mockResolvedValue({
      data: [{
        id: '30000000-0000-4000-8000-000000000001',
        user_id: userId,
        role: 'restaurant_admin',
        status: 'active',
        created_at: '2026-09-29T12:00:00.000Z',
      }],
      error: null,
    })
    mocks.profileIn.mockResolvedValue({
      data: [{ id: userId, full_name: 'Admin', email: 'admin@example.com', active: true }],
      error: null,
    })
    mocks.memberEq.mockReturnValue({ order: mocks.memberOrder })
    mocks.memberSelect.mockReturnValue({ eq: mocks.memberEq })
    mocks.profileSelect.mockReturnValue({ in: mocks.profileIn })
    mocks.from.mockImplementation((table: string) => {
      if (table === 'restaurant_members') return { select: mocks.memberSelect }
      if (table === 'profiles') return { select: mocks.profileSelect }
      throw new Error(`Unexpected table: ${table}`)
    })
  })

  it('uses two RLS-protected reads instead of an unavailable PostgREST relationship', async () => {
    await expect(listRestaurantMembers(restaurantId)).resolves.toHaveLength(1)

    expect(mocks.memberSelect).toHaveBeenCalledWith('id,user_id,role,status,created_at')
    expect(mocks.memberEq).toHaveBeenCalledWith('restaurant_id', restaurantId)
    expect(mocks.profileSelect).toHaveBeenCalledWith('id,full_name,email,active')
    expect(mocks.profileIn).toHaveBeenCalledWith('id', [userId])
  })

  it('does not issue an empty profiles IN query when the restaurant has no members', async () => {
    mocks.memberOrder.mockResolvedValue({ data: [], error: null })

    await expect(listRestaurantMembers(restaurantId)).resolves.toEqual([])
    expect(mocks.profileSelect).not.toHaveBeenCalled()
  })
})
