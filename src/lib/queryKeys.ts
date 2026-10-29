import type { CommerceChannel } from './commerce-channel'

export const queryKeys = {
  publicCatalog: {
    all: ['public-catalog'] as const,
    menuRoot: ['public-menu'] as const,
    menu: (slug: string | undefined, channel: CommerceChannel = 'menu') =>
      channel === 'menu'
        ? (['public-menu', slug] as const)
        : (['public-menu', slug, channel] as const),
    revision: (slug: string | undefined, channel: CommerceChannel = 'menu') =>
      ['public-catalog', 'revision', slug, channel] as const,
    meta: (slug: string | undefined, channel: CommerceChannel = 'menu') =>
      ['public-catalog', 'meta', slug, channel] as const,
    pages: (slug: string | undefined, channel: CommerceChannel) =>
      ['public-catalog', 'page', slug, channel] as const,
    page: (
      slug: string | undefined,
      channel: CommerceChannel,
      categoryId: string,
      search: string,
    ) => ['public-catalog', 'page', slug, channel, categoryId, search] as const,
    group: (slug: string | undefined, channel: CommerceChannel, groupId: string | undefined) =>
      ['public-catalog', 'group', slug, channel, groupId] as const,
    groups: (slug: string | undefined, channel: CommerceChannel) =>
      ['public-catalog', 'group', slug, channel] as const,
  },
  restaurant: (restaurantId: string | undefined) => ['restaurant', restaurantId] as const,
  products: (restaurantId: string | undefined) => ['products', restaurantId] as const,
  productEditor: (restaurantId: string | undefined, productId: string | undefined) =>
    ['product-editor', restaurantId, productId] as const,
  catalogStock: (restaurantId: string | undefined) => ['catalog-stock', restaurantId] as const,
  inventory: (restaurantId: string | undefined) => ['inventory', restaurantId] as const,
  inventoryOverview: (restaurantId: string | undefined) => ['inventory-overview', restaurantId] as const,
  inventoryItems: (restaurantId: string | undefined, search = '') =>
    ['inventory-items', restaurantId, search] as const,
  orders: (restaurantId: string | undefined) => ['orders', restaurantId] as const,
  dashboardOrders: (restaurantId: string | undefined) => ['dashboard-orders', restaurantId] as const,
}
