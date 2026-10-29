import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import {
  invalidateRestaurantCreationQueries,
  invalidateRestaurantMemberQueries,
  invalidateRestaurantStatusQueries,
} from './admin-cache'

const restaurantId = '10000000-0000-4000-8000-000000000001'
const otherRestaurantId = '20000000-0000-4000-8000-000000000002'

function invalidatedKeys(client: QueryClient) {
  return vi.mocked(client.invalidateQueries).mock.calls.map(([filters]) => filters?.queryKey)
}

function clientWithInvalidationSpy() {
  const client = new QueryClient()
  vi.spyOn(client, 'invalidateQueries').mockResolvedValue(undefined)
  return client
}

describe('admin cache invalidation', () => {
  it('refreshes every projection of a restaurant status, including the public catalog', async () => {
    const client = clientWithInvalidationSpy()

    await invalidateRestaurantStatusQueries(client, restaurantId)

    expect(invalidatedKeys(client)).toEqual(expect.arrayContaining([
      ['restaurant', restaurantId],
      ['superadmin-restaurant', restaurantId],
      ['superadmin-restaurants'],
      ['superadmin-dashboard'],
      ['restaurant-scope-choices'],
      ['products', restaurantId],
      ['public-catalog'],
      ['public-menu'],
    ]))
  })

  it('refreshes restaurant, superadmin and platform member directories together', async () => {
    const client = clientWithInvalidationSpy()

    await invalidateRestaurantMemberQueries(client, restaurantId)

    expect(invalidatedKeys(client)).toEqual(expect.arrayContaining([
      ['restaurant-users', restaurantId],
      ['superadmin-restaurant', restaurantId],
      ['platform-users'],
      ['superadmin-dashboard'],
      ['restaurant-scope-choices'],
    ]))
  })

  it('does not invalidate another restaurant member list', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY } } })
    client.setQueryData(['restaurant-users', restaurantId], [])
    client.setQueryData(['restaurant-users', otherRestaurantId], [])

    await invalidateRestaurantMemberQueries(client, restaurantId)

    expect(client.getQueryState(['restaurant-users', restaurantId])?.isInvalidated).toBe(true)
    expect(client.getQueryState(['restaurant-users', otherRestaurantId])?.isInvalidated).toBe(false)
  })

  it('refreshes platform lists before navigating to a newly created restaurant', async () => {
    const client = clientWithInvalidationSpy()

    await invalidateRestaurantCreationQueries(client)

    expect(invalidatedKeys(client)).toEqual(expect.arrayContaining([
      ['superadmin-restaurants'],
      ['superadmin-dashboard'],
      ['platform-users'],
      ['restaurant-scope-choices'],
    ]))
  })
})
