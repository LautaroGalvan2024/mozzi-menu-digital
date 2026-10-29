import type { QueryClient } from '@tanstack/react-query'
import { queryKeys } from './queryKeys'

const CHANNEL_NAME = 'mozzi:catalog-cache:v1'

export interface CatalogInvalidationMessage {
  restaurantId: string
  sentAt: number
}

function openChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null
  try {
    return new BroadcastChannel(CHANNEL_NAME)
  } catch {
    return null
  }
}

export function publishCatalogInvalidation(restaurantId: string) {
  const channel = openChannel()
  if (!channel) return
  channel.postMessage({ restaurantId, sentAt: Date.now() } satisfies CatalogInvalidationMessage)
  channel.close()
}

export function subscribeCatalogInvalidations(
  listener: (message: CatalogInvalidationMessage) => void,
): () => void {
  const channel = openChannel()
  if (!channel) return () => undefined
  channel.onmessage = (event: MessageEvent<unknown>) => {
    const value = event.data as Partial<CatalogInvalidationMessage> | null
    if (!value || typeof value.restaurantId !== 'string' || typeof value.sentAt !== 'number') return
    listener({ restaurantId: value.restaurantId, sentAt: value.sentAt })
  }
  return () => channel.close()
}

export async function invalidateCatalogQueries(client: QueryClient, restaurantId: string) {
  publishCatalogInvalidation(restaurantId)
  await invalidateCatalogQueriesLocally(client, restaurantId)
}

export async function invalidateCatalogQueriesLocally(client: QueryClient, restaurantId: string) {
  // Editor forms hydrate local draft state from query data only once. Keeping an
  // invalidated detail in memory would let a later navigation hydrate that draft
  // with the old snapshot before the background refetch finishes.
  client.removeQueries({ queryKey: queryKeys.productEditors(restaurantId), type: 'inactive' })
  await Promise.all([
    client.invalidateQueries({ queryKey: queryKeys.categories(restaurantId) }),
    client.invalidateQueries({ queryKey: queryKeys.categoryOptions(restaurantId) }),
    client.invalidateQueries({ queryKey: queryKeys.productEditors(restaurantId), type: 'active' }),
    client.invalidateQueries({ queryKey: queryKeys.products(restaurantId) }),
    client.invalidateQueries({ queryKey: queryKeys.productFamilies(restaurantId) }),
    client.invalidateQueries({ queryKey: queryKeys.catalogStock(restaurantId) }),
    client.invalidateQueries({ queryKey: queryKeys.inventory(restaurantId) }),
    client.invalidateQueries({ queryKey: queryKeys.inventoryOverview(restaurantId) }),
    client.invalidateQueries({ queryKey: queryKeys.inventoryItems(restaurantId) }),
    client.invalidateQueries({ queryKey: queryKeys.publicCatalog.menuRoot }),
    client.invalidateQueries({ queryKey: queryKeys.publicCatalog.all }),
  ])
}

export function syncCatalogInvalidations(
  client: QueryClient,
  restaurantId?: string,
): () => void {
  return subscribeCatalogInvalidations((message) => {
    if (restaurantId && message.restaurantId !== restaurantId) return
    void invalidateCatalogQueriesLocally(client, message.restaurantId)
  })
}
