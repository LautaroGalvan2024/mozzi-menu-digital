import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PublicProduct, PublicRestaurant } from '../../types/domain'
import { ProductDialog } from './ProductDialog'

const restaurant: PublicRestaurant = {
  id: '10000000-0000-4000-8000-000000000001',
  name: 'Lautaro',
  tradeName: 'Lautaro',
  slug: 'lautaro',
  description: '',
  whatsappPhone: '+5493492123456',
  address: 'Calle 123',
  city: 'Rafaela',
  timezone: 'America/Argentina/Cordoba',
  currencyCode: 'ARS',
  locale: 'es-AR',
  logoPath: null,
  coverPath: null,
  primaryColor: '#ff4d00',
  secondaryColor: '#111111',
  deliveryEnabled: true,
  pickupEnabled: true,
  minimumOrderCents: 0,
  defaultPreparationMinutes: 30,
  isOpen: true,
  nextOpeningAt: null,
}

const product: PublicProduct = {
  id: '20000000-0000-4000-8000-000000000001',
  categoryId: '30000000-0000-4000-8000-000000000001',
  code: 'PROMO',
  name: 'Producto con promoción vigente',
  description: '',
  basePriceCents: 1_000_000,
  promotionalPriceCents: 800_000,
  promotionStartsAt: null,
  promotionEndsAt: null,
  imagePath: null,
  available: true,
  featured: false,
  sortOrder: 0,
  quantityPrices: [{ quantity: 2, totalPriceCents: 1_800_000 }],
  optionGroups: [],
}

describe('ProductDialog quantity promotions', () => {
  beforeEach(() => {
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.setAttribute('open', '')
      },
    })
  })

  afterEach(cleanup)

  it('does not advertise an obsolete bundle and keeps the cheaper active promotion', async () => {
    const user = userEvent.setup()
    render(<ProductDialog product={product} restaurant={restaurant} onClose={() => undefined} onAdd={() => undefined} />)

    expect(screen.queryByText(/2 por/)).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Sumar uno' }))
    expect(screen.getByRole('button', { name: /Agregar/ })).toHaveTextContent(/16\.000,00/)
  })
})
