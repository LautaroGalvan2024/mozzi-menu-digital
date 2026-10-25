import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CartLine, PublicMenu, PublicProduct } from '../../types/domain'
import { CartPage } from './CartPage'
import { CartProvider } from './CartProvider'
import { validateCartLine } from './cartValidation'

const PRODUCT = '10000000-0000-4000-8000-000000000001'
const OPTION = '10000000-0000-4000-8000-000000000002'
const GROUP = '10000000-0000-4000-8000-000000000003'
const category = '10000000-0000-4000-8000-000000000004'
const mocks = vi.hoisted(() => ({ menu: {} as PublicMenu, fetching: false, updatedAt: 1 }))
vi.mock('../public-menu/usePublicMenu', () => ({ usePublicMenu: () => ({ data: mocks.menu, dataUpdatedAt: mocks.updatedAt, isLoading: false, isFetching: mocks.fetching, error: null }) }))
vi.mock('../../lib/supabase/client', () => ({ publicAssetUrl: () => null }))
const product: PublicProduct = { id: PRODUCT, categoryId: category, code: 'P-1', name: 'Arroz', description: '', basePriceCents: 1000, promotionalPriceCents: null, promotionStartsAt: null, promotionEndsAt: null, imagePath: null, available: true, featured: false, sortOrder: 0, quantityPrices: [], optionGroups: [{ id: GROUP, name: 'Preparación', required: true, minSelect: 1, maxSelect: 1, sortOrder: 0, options: [{ id: OPTION, name: 'Integral', priceDeltaCents: 100, sortOrder: 0 }] }] }
const line: CartLine = { key: '20000000-0000-4000-8000-000000000001', productId: PRODUCT, productName: 'Arroz', productImagePath: null, quantity: 2, notes: 'Sin sal, por favor', unitPriceCents: 1000, quantityPrices: [], selectedOptions: [{ id: OPTION, groupName: 'Preparación', name: 'Integral', priceDeltaCents: 100 }] }
function fixture(products: PublicProduct[] = [product]): PublicMenu {
  return { restaurant: { id: '30000000-0000-4000-8000-000000000001', slug: 'mozzi', name: 'Mozzi', tradeName: 'Mozzi', description: '', address: 'Calle Uno', city: 'Rafaela', timezone: 'America/Argentina/Cordoba', pickupEnabled: true, deliveryEnabled: false, isOpen: true, minimumOrderCents: 0, whatsappPhone: '+5493492123456', currencyCode: 'ARS', locale: 'es-AR', logoPath: null, coverPath: null, primaryColor: '#000000', secondaryColor: '#ffffff', defaultPreparationMinutes: 30, nextOpeningAt: null }, categories: [{ id: category, name: 'Platos', slug: 'platos', description: '', imagePath: null, sortOrder: 0, products }], paymentMethods: [], deliveryZones: [], businessHours: [], specialHours: [] }
}
function app() { return <MemoryRouter initialEntries={['/r/mozzi/carrito']}><CartProvider><Routes><Route path="/r/:restaurantSlug/carrito" element={<CartPage />} /><Route path="/r/:restaurantSlug/checkout" element={<p>Checkout habilitado</p>} /></Routes></CartProvider></MemoryRouter> }
function stored(): CartLine[] { return JSON.parse(localStorage.getItem('mozzi:cart:mozzi')!) }

describe('cart validation and deliberate reconfiguration', () => {
  beforeEach(() => {
    localStorage.clear(); mocks.menu = fixture(); mocks.fetching = false; mocks.updatedAt = 1
    localStorage.setItem('mozzi:cart:mozzi', JSON.stringify([line]))
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.setAttribute('open', '') } })
    Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute('open'); this.dispatchEvent(new Event('close')) } })
  })
  afterEach(() => { cleanup(); vi.useRealTimers() })

  it('keeps missing and unavailable lines with their notes and options until explicitly removed', async () => {
    mocks.menu = fixture([])
    const view = render(app())
    expect(await screen.findByText(/Este producto ya no está en el menú/)).toBeVisible()
    expect(screen.getByRole('button', { name: 'Continuar' })).toBeDisabled()
    expect(stored()[0]?.notes).toBe(line.notes)
    expect(stored()[0]?.selectedOptions).toEqual(line.selectedOptions)
    mocks.menu = fixture([{ ...product, available: false }]); view.rerender(app())
    expect(await screen.findByText(/no está disponible en este momento/)).toBeVisible()
    expect(stored()).toHaveLength(1)
    await userEvent.click(screen.getByRole('button', { name: 'Quitar Arroz' }))
    expect(await screen.findByText('El carrito está vacío')).toBeVisible()
    expect(stored()).toEqual([])
  })

  it('requires explicit removal of an obsolete option and saves a replacement without losing notes or quantity', async () => {
    const old = { ...line, selectedOptions: [{ ...line.selectedOptions[0]!, id: '40000000-0000-4000-8000-000000000001', name: 'Blanco' }] }
    localStorage.setItem('mozzi:cart:mozzi', JSON.stringify([old]))
    render(app())
    expect(await screen.findByText(/La opción «Blanco» ya no está disponible/)).toBeVisible()
    expect(screen.getByRole('button', { name: 'Continuar' })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: 'Reconfigurar Arroz' }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByLabelText('Observaciones para este producto')).toHaveValue(line.notes)
    await userEvent.click(within(dialog).getByRole('button', { name: /Guardar cambios/ }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('quitá explícitamente')
    expect(stored()[0]?.selectedOptions[0]?.name).toBe('Blanco')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Quitar Blanco' }))
    await userEvent.click(within(dialog).getByLabelText(/Integral/))
    await userEvent.click(within(dialog).getByRole('button', { name: /Guardar cambios/ }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(stored()[0]?.quantity).toBe(2)
    expect(stored()[0]?.notes).toBe(line.notes)
    expect(stored()[0]?.selectedOptions.map(option => option.id)).toEqual([OPTION])
    await userEvent.click(screen.getByRole('link', { name: 'Continuar' }))
    expect(await screen.findByText('Checkout habilitado')).toBeVisible()
  })

  it('updates prices without changing choices and blocks while the refreshed menu is pending', async () => {
    const view = render(app()); await screen.findByRole('link', { name: 'Continuar' })
    mocks.fetching = true; view.rerender(app())
    expect(screen.getByRole('button', { name: 'Continuar' })).toBeDisabled()
    mocks.fetching = false; mocks.menu = fixture([{ ...product, basePriceCents: 1800 }]); view.rerender(app())
    await waitFor(() => expect(stored()[0]?.unitPriceCents).toBe(1800))
    expect(stored()[0]?.notes).toBe(line.notes)
    expect(stored()[0]?.selectedOptions).toEqual(line.selectedOptions)
    expect(screen.getByRole('link', { name: 'Continuar' })).toBeVisible()
  })

  it('detects changed group minimum and maximum without mutating the original selection', () => {
    const before = structuredClone(line)
    expect(validateCartLine({ ...line, selectedOptions: [] }, product).map(issue => issue.code)).toContain('group_minimum')
    const limited = { ...product, optionGroups: [{ ...product.optionGroups[0]!, required: false, minSelect: 0, maxSelect: 0 }] }
    expect(validateCartLine(line, limited).map(issue => issue.code)).toContain('group_maximum')
    expect(line).toEqual(before)
  })

  it('expires a scheduled promotion after a successful refresh even when menu data is structurally unchanged', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-24T12:00:00Z'))
    mocks.menu = fixture([{ ...product, promotionalPriceCents: 500, promotionEndsAt: '2026-10-24T12:01:00Z' }])
    const view = render(app())
    await waitFor(() => expect(stored()[0]?.unitPriceCents).toBe(500))
    vi.setSystemTime(new Date('2026-10-24T12:02:00Z'))
    mocks.updatedAt = 2
    view.rerender(app())
    await waitFor(() => expect(stored()[0]?.unitPriceCents).toBe(1000))
    expect(stored()[0]?.notes).toBe(line.notes)
    expect(stored()[0]?.selectedOptions).toEqual(line.selectedOptions)
  })
})
