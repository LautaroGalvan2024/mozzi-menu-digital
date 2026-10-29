import type { QueryClient } from '@tanstack/react-query'
import { invalidateCatalogQueries } from './catalog-cache'

/**
 * A restaurant status is projected into both administration trees and into the
 * public catalog. Keep every projection stale together after a confirmed write.
 */
export async function invalidateRestaurantStatusQueries(client: QueryClient, restaurantId: string) {
  await Promise.all([
    client.invalidateQueries({ queryKey: ['restaurant', restaurantId] }),
    client.invalidateQueries({ queryKey: ['superadmin-restaurant', restaurantId] }),
    client.invalidateQueries({ queryKey: ['superadmin-restaurants'] }),
    client.invalidateQueries({ queryKey: ['superadmin-dashboard'] }),
    client.invalidateQueries({ queryKey: ['restaurant-scope-choices'] }),
    invalidateCatalogQueries(client, restaurantId),
  ])
}

/** A member write is visible in the restaurant, superadmin and platform views. */
export async function invalidateRestaurantMemberQueries(client: QueryClient, restaurantId: string) {
  await Promise.all([
    client.invalidateQueries({ queryKey: ['restaurant-users', restaurantId] }),
    client.invalidateQueries({ queryKey: ['superadmin-restaurant', restaurantId] }),
    client.invalidateQueries({ queryKey: ['platform-users'] }),
    client.invalidateQueries({ queryKey: ['superadmin-dashboard'] }),
    client.invalidateQueries({ queryKey: ['restaurant-scope-choices'] }),
  ])
}

/** Creating a restaurant changes every platform-wide directory and metric. */
export async function invalidateRestaurantCreationQueries(client: QueryClient) {
  await Promise.all([
    client.invalidateQueries({ queryKey: ['superadmin-restaurants'] }),
    client.invalidateQueries({ queryKey: ['superadmin-dashboard'] }),
    client.invalidateQueries({ queryKey: ['platform-users'] }),
    client.invalidateQueries({ queryKey: ['restaurant-scope-choices'] }),
  ])
}
