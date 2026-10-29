import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PublicMenu, PublicProduct } from '../../types/domain'
import { CartProvider, parseStoredCart } from '../cart/CartProvider'
import { cartProductName } from '../../lib/catalog-presentation'
import { PublicStorePage } from './PublicStorePage'
import { commerceStorageKey } from '../../lib/commerce-channel'
import { checkoutBusinessRequest, checkoutRequestFingerprint, getCheckoutAttemptKey, readCheckoutAttempt, recordCheckoutAttempt } from '../../lib/checkout-attempt'

const FAMILY = '30000000-0000-4000-8000-000000000001'
const BLACK = '10000000-0000-4000-8000-000000000001'
const RED = '10000000-0000-4000-8000-000000000002'
const CATEGORY = '20000000-0000-4000-8000-000000000001'
const mocks = vi.hoisted(() => ({ menu: {} as PublicMenu, hook: vi.fn() }))
vi.mock('../../lib/useDebouncedValue', () => ({ useDebouncedValue: (value: unknown) => value }))
vi.mock('../public-menu/usePublicCatalog', () => ({
  usePublicCatalog: (...args: unknown[]) => {
    mocks.hook(...args)
    const [, , categoryId = '', search = ''] = args as [string, string, string, string]
    const groups = catalogGroups(mocks.menu, categoryId, search)
    return {
      meta: { data: { ...mocks.menu, revision: 1, categories: mocks.menu.categories.map(({ products: _products, ...category }) => category) }, error: null, refetch: vi.fn() },
      pages: { data: { pages: [{ revision: 1, items: groups, nextCursor: null }] }, error: null, refetch: vi.fn(), hasNextPage: false, isFetchingNextPage: false, fetchNextPage: vi.fn() },
      groups,
      isLoading: false,
      isUpdating: false,
      refreshError: null,
    }
  },
}))
vi.mock('../public-menu/api', () => ({
  fetchPublicCatalogGroup: async (_slug: string, id: string) => {
    const group = catalogGroups(mocks.menu).find((item) => item.id === id || item.variants.some((variant) => variant.id === id))
    if (!group) throw new Error('missing')
    return { revision: 1, group }
  },
}))
vi.mock('../../lib/supabase/client', () => ({ publicAssetUrl: () => null }))

const variant = (id: string, color: string, price: number): PublicProduct => ({ id, categoryId: CATEGORY, name: 'SKU anterior', description: '', code: id, basePriceCents: price, promotionalPriceCents: null, promotionStartsAt: null, promotionEndsAt: null, imagePath: null, available: true, featured: false, sortOrder: 0, quantityPrices: [], optionGroups: [], family: { id: FAMILY, name: 'Funda de silicona', description: 'Protección para tu teléfono.', imagePath: null, axes: ['Modelo', 'Color'] }, variantAttributes: { Modelo: 'iPhone 15', Color: color } })
const black = variant(BLACK, 'Negro', 1000)
const red = variant(RED, 'Rojo', 1200)

function catalogGroups(menu: PublicMenu, categoryId = '', search = '') {
  const phrase = search.trim().toLocaleLowerCase('es')
  const groups = new Map<string, { id: string; categoryId: string; family: PublicProduct['family']; variants: PublicProduct[] }>()
  for (const category of menu.categories) {
    if (categoryId && category.id !== categoryId) continue
    for (const product of category.products) {
      const searchable = `${product.family?.name ?? ''} ${product.name} ${product.description} ${product.code} ${Object.values(product.variantAttributes ?? {}).join(' ')}`.toLocaleLowerCase('es')
      if (phrase && !searchable.includes(phrase)) continue
      const id = product.family?.id ?? product.id
      const current = groups.get(id) ?? { id, categoryId: product.categoryId, family: product.family ?? null, variants: [] }
      current.variants.push(product)
      groups.set(id, current)
    }
  }
  return [...groups.values()]
}

function fixture(): PublicMenu {
  return { restaurant: { id: FAMILY, slug: 'fundas', name: 'Fundas', tradeName: 'Fundas', description: 'Accesorios', address: 'Calle Uno', city: 'Rafaela', timezone: 'America/Argentina/Cordoba', pickupEnabled: true, deliveryEnabled: true, isOpen: false, acceptsOrders: true, channel: 'store', minimumOrderCents: 0, whatsappPhone: '+5493492123456', currencyCode: 'ARS', locale: 'es-AR', logoPath: null, coverPath: null, primaryColor: '#000000', secondaryColor: '#ffffff', defaultPreparationMinutes: 30, nextOpeningAt: null }, categories: [{ id: CATEGORY, name: 'Fundas', slug: 'fundas', description: '', imagePath: null, sortOrder: 0, products: [black, red] }], paymentMethods: [], deliveryZones: [], businessHours: [], specialHours: [] }
}
function page(path = '/t/fundas') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><CartProvider><Routes><Route path="/t/:restaurantSlug" element={<PublicStorePage />} /><Route path="/t/:restaurantSlug/producto/:productId" element={<PublicStorePage />} /></Routes></CartProvider></MemoryRouter></QueryClientProvider>)
}

describe('shared catalog storefront', () => {
  beforeEach(() => {
    localStorage.clear(); sessionStorage.clear(); vi.clearAllMocks(); mocks.menu = fixture()
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.setAttribute('open', '') } })
    Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute('open'); this.dispatchEvent(new Event('close')) } })
  })
  afterEach(cleanup)

  it('shows one family card, keeps the store route, and separates attention hours from ordering', async () => {
    page()
    expect(await screen.findAllByRole('heading', { name: 'Funda de silicona' })).toHaveLength(1)
    expect(screen.getByText('Recibimos pedidos')).toBeVisible()
    expect(screen.getByText('Atención: fuera de horario')).toBeVisible()
    expect(mocks.hook).toHaveBeenCalledWith('fundas', 'store', '', '')
    const link = screen.getByRole('link', { name: /Funda de silicona/ })
    expect(link).toHaveAttribute('href', `/t/fundas/producto/${FAMILY}`)
    await userEvent.type(screen.getByRole('textbox', { name: 'Buscar productos' }), 'Rojo')
    expect(screen.getByRole('heading', { name: 'Funda de silicona' })).toBeVisible()
  })

  it('resolves the selected combination to its own SKU and preserves the menu cart', async () => {
    localStorage.setItem('mozzi:cart:fundas', '[]')
    page(`/t/fundas/producto/${FAMILY}`)
    await userEvent.click(await screen.findByRole('button', { name: 'Elegir variante' }))
    await userEvent.selectOptions(screen.getByLabelText('Elegí tu variante'), RED)
    const dialog = screen.getByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: /Agregar/ }))
    await waitFor(() => {
      const cart = JSON.parse(localStorage.getItem('mozzi:cart:store:fundas') ?? '[]')
      expect(cart).toHaveLength(1)
      expect(cart[0]).toMatchObject({ productId: RED, unitPriceCents: 1200, productName: 'Funda de silicona · Modelo: iPhone 15 · Color: Rojo' })
    })
    expect(localStorage.getItem('mozzi:cart:fundas')).toBe('[]')
  })

  it('combines category and variant search and clears both filters from the empty state', async () => {
    const chargers = '20000000-0000-4000-8000-000000000002'
    mocks.menu.categories.push({ id: chargers, name: 'Cargadores', slug: 'cargadores', description: '', imagePath: null, sortOrder: 1, products: [{ ...black, id: '10000000-0000-4000-8000-000000000003', categoryId: chargers, name: 'Cargador USB', family: null, variantAttributes: {} }] })
    page()
    expect(await screen.findByRole('status')).toHaveTextContent('2 productos')
    await userEvent.click(screen.getByRole('button', { name: 'Cargadores' }))
    expect(screen.getByRole('button', { name: 'Cargadores' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByRole('heading', { name: 'Funda de silicona' })).not.toBeInTheDocument()
    await userEvent.type(screen.getByRole('textbox', { name: 'Buscar productos' }), 'Rojo')
    expect(screen.getByRole('heading', { name: 'No encontramos productos' })).toBeVisible()
    expect(screen.getByRole('status')).toHaveTextContent('0 productos')
    await userEvent.click(screen.getByRole('button', { name: 'Ver todos los productos' }))
    expect(screen.getByRole('textbox', { name: 'Buscar productos' })).toHaveValue('')
    expect(screen.getByRole('button', { name: 'Todos' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('heading', { name: 'Funda de silicona' })).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Cargador USB' })).toBeVisible()
  })

  it('clears only the search while retaining the selected category', async () => {
    page()
    await userEvent.click(await screen.findByRole('button', { name: 'Fundas' }))
    await userEvent.type(screen.getByRole('textbox', { name: 'Buscar productos' }), 'no existe')
    await userEvent.click(screen.getByRole('button', { name: 'Limpiar búsqueda' }))
    expect(screen.getByRole('button', { name: 'Fundas' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('heading', { name: 'Funda de silicona' })).toBeVisible()
  })

  it.each(['paused', 'sold-out'] as const)('keeps %s products visible and disables ordering in the detail', async state => {
    if (state === 'paused') mocks.menu.restaurant.acceptsOrders = false
    else mocks.menu.categories[0]!.products = [black, red].map(product => ({ ...product, available: false }))
    page(`/t/fundas/producto/${FAMILY}`)
    expect(await screen.findByRole('heading', { name: 'Funda de silicona' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Elegir variante' })).toBeDisabled()
    expect(screen.getByText(state === 'paused' ? 'Pedidos pausados' : 'Agotado')).toBeVisible()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('shows an unpublished catalog empty state without a misleading filter reset', async () => {
    mocks.menu.categories = []
    page()
    expect(await screen.findByRole('heading', { name: 'El catálogo está en preparación' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Ver todos los productos' })).not.toBeInTheDocument()
  })

  it('shows recovery only for the current commerce and links to its protected payment result', async () => {
    const reference = JSON.stringify({ actionId: FAMILY, token: 'a'.repeat(43), expiresAt: new Date(Date.now() + 60_000).toISOString() })
    localStorage.setItem(commerceStorageKey('payment-confirmation', 'otro-comercio', 'store'), reference)
    const initial = page()
    await screen.findByRole('heading', { name: 'Funda de silicona' })
    expect(screen.queryByRole('link', { name: /Consultar mi última compra/ })).not.toBeInTheDocument()
    initial.unmount()
    localStorage.setItem(commerceStorageKey('payment-confirmation', 'fundas', 'store'), reference)
    page()
    expect(await screen.findByRole('link', { name: /Consultar mi última compra/ })).toHaveAttribute('href', '/t/fundas/pago')
  })

  it('retains legacy attempt keys and distinguishes both channel and checkout mode', async () => {
    const values = { customerName: 'Ana Pérez', customerPhone: '+5493492123456', fulfillmentType: 'pickup' as const, paymentMethodId: FAMILY }
    const menu = checkoutBusinessRequest('fundas', values, [])
    const store = checkoutBusinessRequest('fundas', values, [], 'store')
    const online = checkoutBusinessRequest('fundas', values, [], 'store', 'online')
    expect(menu).not.toHaveProperty('channel')
    expect(await checkoutRequestFingerprint(store)).not.toBe(await checkoutRequestFingerprint(online))
    const menuKey = getCheckoutAttemptKey('fundas', await checkoutRequestFingerprint(menu))
    const storeKey = getCheckoutAttemptKey('fundas', await checkoutRequestFingerprint(store), Date.now(), undefined, 'store')
    recordCheckoutAttempt('fundas', storeKey, await checkoutRequestFingerprint(store), 'uncertain', 1000, 'store')
    expect(readCheckoutAttempt('fundas')?.idempotencyKey).toBe(menuKey)
    expect(readCheckoutAttempt('fundas', 'store')?.idempotencyKey).toBe(storeKey)
    expect(storeKey).not.toBe(menuKey)
    expect(commerceStorageKey('cart', 'fundas')).toBe('mozzi:cart:fundas')
  })
  it('round trips a variant with long family and attribute names without losing its cart', () => {
    const product = { ...red, family: { ...red.family!, name: 'Familia '.repeat(17).slice(0, 120) }, variantAttributes: { Modelo: 'Modelo '.repeat(12), Color: 'Rojo '.repeat(12) } }
    const name = cartProductName(product)
    expect(name.length).toBeLessThanOrEqual(160)
    const restored = parseStoredCart(JSON.stringify([{ key: FAMILY, productId: RED, productName: name, productImagePath: null, quantity: 1, notes: '', unitPriceCents: 1200, quantityPrices: [], selectedOptions: [] }]))
    expect(restored).toHaveLength(1)
    expect(restored[0]?.productId).toBe(RED)
  })
})
