import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect, useState } from 'react'
import { Link, MemoryRouter, Route, Routes, useNavigate } from 'react-router'
import { afterEach, expect, it, vi } from 'vitest'
import { invalidateCatalogQueries } from './catalog-cache'
import { queryKeys } from './queryKeys'

const restaurantId = '20000000-0000-4000-8000-000000000001'
const productId = '30000000-0000-4000-8000-000000000001'

afterEach(cleanup)

it('shows a saved product value after navigating away and back without reloading', async () => {
  let storedQuantityPrice = 200_000
  const loadProduct = vi.fn(async () => {
    if (loadProduct.mock.calls.length > 1) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    return { quantityPrice: storedQuantityPrice }
  })

  function Editor() {
    const client = useQueryClient()
    const navigate = useNavigate()
    const product = useQuery({
      queryKey: queryKeys.productEditor(restaurantId, productId),
      queryFn: loadProduct,
    })
    const [draftQuantityPrice, setDraftQuantityPrice] = useState<number | null>(null)

    useEffect(() => {
      if (draftQuantityPrice !== null || !product.data) return
      setDraftQuantityPrice(product.data.quantityPrice)
    }, [draftQuantityPrice, product.data])

    async function save() {
      storedQuantityPrice = 300_000
      await invalidateCatalogQueries(client, restaurantId)
      navigate('/productos')
    }

    if (draftQuantityPrice === null) return <p>Cargando producto…</p>
    return (
      <>
        <p role="status">Precio por cantidad: {draftQuantityPrice}</p>
        <button type="button" onClick={() => void save()}>Guardar</button>
      </>
    )
  }

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/productos/${productId}`]}>
        <Routes>
          <Route path="/productos/:productId" element={<Editor />} />
          <Route path="/productos" element={<Link to={`/productos/${productId}`}>Volver a editar</Link>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )

  expect(await screen.findByRole('status')).toHaveTextContent('200000')
  await userEvent.click(screen.getByRole('button', { name: 'Guardar' }))
  await userEvent.click(await screen.findByRole('link', { name: 'Volver a editar' }))

  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('300000'))
  expect(loadProduct.mock.calls.length).toBeGreaterThanOrEqual(2)
  client.clear()
})
