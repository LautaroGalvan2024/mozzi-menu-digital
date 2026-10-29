import { QueryClient } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import { invalidateCatalogQueries, syncCatalogInvalidations } from './catalog-cache'
import { queryKeys } from './queryKeys'

type Receiver = (event: MessageEvent<unknown>) => void

class FakeBroadcastChannel {
  static instances = new Set<FakeBroadcastChannel>()
  onmessage: Receiver | null = null
  readonly name: string

  constructor(name: string) {
    this.name = name
    FakeBroadcastChannel.instances.add(this)
  }

  postMessage(data: unknown) {
    for (const channel of FakeBroadcastChannel.instances) {
      if (channel !== this && channel.name === this.name) channel.onmessage?.({ data } as MessageEvent)
    }
  }

  close() {
    FakeBroadcastChannel.instances.delete(this)
  }
}

afterEach(() => {
  FakeBroadcastChannel.instances.clear()
  vi.unstubAllGlobals()
})

it('invalidates the matching catalog in another tab', async () => {
  vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel)
  const firstTab = new QueryClient()
  const secondTab = new QueryClient()
  const restaurantId = '20000000-0000-4000-8000-000000000001'
  secondTab.setQueryData(queryKeys.products(restaurantId), [{ id: 'old' }])
  secondTab.setQueryData(queryKeys.categories(restaurantId), [{ id: 'old-category' }])
  secondTab.setQueryData(queryKeys.categoryOptions(restaurantId), [{ id: 'old-option' }])
  secondTab.setQueryData(queryKeys.productFamilies(restaurantId), [{ id: 'old-family' }])
  const observer = vi.fn()
  const unsubscribeCache = secondTab.getQueryCache().subscribe(observer)
  const unsubscribeChannel = syncCatalogInvalidations(secondTab, restaurantId)

  await invalidateCatalogQueries(firstTab, restaurantId)

  expect(secondTab.getQueryState(queryKeys.products(restaurantId))?.isInvalidated).toBe(true)
  expect(secondTab.getQueryState(queryKeys.categories(restaurantId))?.isInvalidated).toBe(true)
  expect(secondTab.getQueryState(queryKeys.categoryOptions(restaurantId))?.isInvalidated).toBe(true)
  expect(secondTab.getQueryState(queryKeys.productFamilies(restaurantId))?.isInvalidated).toBe(true)
  expect(observer).toHaveBeenCalled()
  unsubscribeChannel()
  unsubscribeCache()
  firstTab.clear()
  secondTab.clear()
})

it('ignores broadcasts from another restaurant', async () => {
  vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel)
  const firstTab = new QueryClient()
  const secondTab = new QueryClient()
  const current = '20000000-0000-4000-8000-000000000001'
  secondTab.setQueryData(queryKeys.products(current), [{ id: 'current' }])
  secondTab.setQueryData(queryKeys.categories(current), [{ id: 'current-category' }])
  secondTab.setQueryData(queryKeys.productFamilies(current), [{ id: 'current-family' }])
  const unsubscribe = syncCatalogInvalidations(secondTab, current)

  await invalidateCatalogQueries(firstTab, '20000000-0000-4000-8000-000000000002')

  expect(secondTab.getQueryState(queryKeys.products(current))?.isInvalidated).toBe(false)
  expect(secondTab.getQueryState(queryKeys.categories(current))?.isInvalidated).toBe(false)
  expect(secondTab.getQueryState(queryKeys.productFamilies(current))?.isInvalidated).toBe(false)
  unsubscribe()
  firstTab.clear()
  secondTab.clear()
})

it('drops cached product editor snapshots only for the changed restaurant', async () => {
  const client = new QueryClient()
  const changedRestaurant = '20000000-0000-4000-8000-000000000001'
  const otherRestaurant = '20000000-0000-4000-8000-000000000002'
  const productId = '30000000-0000-4000-8000-000000000001'
  client.setQueryData(queryKeys.productEditor(changedRestaurant, productId), { quantityPrice: 200_000 })
  client.setQueryData(queryKeys.productEditor(otherRestaurant, productId), { quantityPrice: 250_000 })

  await invalidateCatalogQueries(client, changedRestaurant)

  expect(client.getQueryData(queryKeys.productEditor(changedRestaurant, productId))).toBeUndefined()
  expect(client.getQueryData(queryKeys.productEditor(otherRestaurant, productId))).toEqual({ quantityPrice: 250_000 })
  client.clear()
})
