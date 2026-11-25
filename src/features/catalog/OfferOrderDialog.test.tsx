import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OfferOrderDialog } from './OfferOrderDialog'
import { getStoreOfferOrder, OfferOrderConflictError, OfferOrderPermissionError, saveStoreOfferOrder, type StoreOfferItem } from './offer-order-api'

vi.mock('./offer-order-api', async importOriginal => ({
  ...await importOriginal<typeof import('./offer-order-api')>(),
  getStoreOfferOrder: vi.fn(),
  saveStoreOfferOrder: vi.fn(),
}))

const items = ['Taladro', 'Amoladora', 'Llave'].map((name, index): StoreOfferItem => ({
  id: String(index + 1), name, image_url: null, price: 1000,
}))

function renderDialog() {
  const saved = vi.fn()
  const router = createMemoryRouter([
    { path: '/productos', element: <OfferOrderDialog restaurantId="comercio" currency="ARS" locale="es-AR" onClose={vi.fn()} onSaved={saved} /> },
    { path: '/otra', element: <p>Otra página</p> },
  ], { initialEntries: ['/otra', '/productos'] })
  render(<RouterProvider router={router} />)
  return { user: userEvent.setup(), router, saved }
}

describe('OfferOrderDialog', () => {
  afterEach(cleanup)

  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(getStoreOfferOrder).mockResolvedValueOnce({ revision: 'original', items })
  })

  it('preserves the editor on browser back until the merchant confirms', async () => {
    const { user, router } = renderDialog()
    await user.click(await screen.findByRole('button', { name: 'Subir Amoladora' }))
    await act(() => router.navigate(-1))
    const confirm = await screen.findByRole('dialog', { name: '¿Descartar los cambios?' })
    await user.click(within(confirm).getByRole('button', { name: 'Cancelar' }))
    expect(router.state.location.pathname).toBe('/productos')
    expect(screen.getAllByRole('listitem')[0]).toHaveTextContent('Amoladora')
    await act(() => router.navigate(-1))
    await user.click(await screen.findByRole('button', { name: 'Descartar cambios' }))
    expect(await screen.findByText('Otra página')).toBeVisible()
    expect(saveStoreOfferOrder).not.toHaveBeenCalled()
  })

  it('preserves edits when a conflict refresh fails and rechecks membership before retry', async () => {
    const [first, second, removed] = items as [StoreOfferItem, StoreOfferItem, StoreOfferItem]
    const added = { ...removed, id: '4', name: 'Sierra' }
    vi.mocked(saveStoreOfferOrder).mockRejectedValueOnce(new OfferOrderConflictError()).mockResolvedValue(undefined)
    vi.mocked(getStoreOfferOrder).mockRejectedValueOnce(new Error('Sin conexión')).mockResolvedValueOnce({ revision: 'actual', items: [first, second, added] })
    const { user, saved } = renderDialog()
    await user.click(await screen.findByRole('button', { name: 'Subir Amoladora' }))
    await user.click(screen.getByRole('button', { name: 'Guardar orden' }))
    expect(await screen.findByRole('button', { name: 'Actualizar ofertas' })).toBeEnabled()
    expect(screen.getAllByRole('listitem')[0]).toHaveTextContent('Amoladora')
    expect(screen.getByRole('button', { name: 'Guardar orden' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Actualizar ofertas' }))
    expect(await screen.findByText('Sierra')).toBeVisible()
    expect(screen.queryByText('Llave')).not.toBeInTheDocument()
    expect(screen.getAllByRole('listitem')[0]).toHaveTextContent('Amoladora')
    expect(saveStoreOfferOrder).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: 'Guardar orden' }))
    expect(saveStoreOfferOrder).toHaveBeenLastCalledWith('comercio', 'actual', [second.id, first.id, added.id])
    expect(saved).toHaveBeenCalledOnce()
  })

  it('disables saving when the original order is restored', async () => {
    const { user } = renderDialog()
    await user.click(await screen.findByRole('button', { name: 'Subir Amoladora' }))
    expect(screen.getByRole('button', { name: 'Bajar Amoladora' })).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(screen.getByRole('button', { name: 'Guardar orden' })).toBeDisabled()
    expect(saveStoreOfferOrder).not.toHaveBeenCalled()
  })

  it('reports revoked permissions and keeps the edited order', async () => {
    const denied = new OfferOrderPermissionError()
    vi.mocked(saveStoreOfferOrder).mockRejectedValueOnce(denied)
    const { user } = renderDialog()
    await user.click(await screen.findByRole('button', { name: 'Bajar Taladro' }))
    await user.click(screen.getByRole('button', { name: 'Guardar orden' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(denied.message)
    expect(screen.getAllByRole('listitem')[0]).toHaveTextContent('Amoladora')
  })
})
