import { beforeEach, describe, expect, it } from 'vitest'
import {
  checkoutCartFingerprint,
  clearCheckoutAttempt,
  getCheckoutAttemptKey,
} from '../lib/checkout-attempt'
import { checkoutSchema, generatedOrderSchema } from '../lib/validation/schemas'
import type { CartLine } from '../types/domain'

const line: CartLine = {
  key: 'local-only-key',
  productId: '10000000-0000-4000-8000-000000000001',
  productName: 'Producto',
  productImagePath: null,
  quantity: 2,
  notes: 'Sin sal',
  unitPriceCents: 1_000,
  quantityPrices: [],
  selectedOptions: [
    {
      id: '10000000-0000-4000-8000-000000000002',
      groupName: 'Extras',
      name: 'Salsa',
      priceDeltaCents: 100,
    },
  ],
}

const checkout = {
  customerName: 'Ana Pérez',
  customerPhone: '+54 9 3492 123456',
  fulfillmentType: 'pickup' as const,
  deliveryZoneId: '',
  address: '',
  city: '',
  neighborhood: '',
  floor: '',
  apartment: '',
  reference: '',
  paymentMethodId: '10000000-0000-4000-8000-000000000003',
  notes: '',
  website: '',
}

describe('public checkout validation', () => {
  beforeEach(() => sessionStorage.clear())

  it('aligns phone validation with the server format', () => {
    expect(checkoutSchema.safeParse(checkout).success).toBe(true)
    expect(checkoutSchema.safeParse({ ...checkout, customerPhone: 'abcdefgh' }).success).toBe(false)
    expect(checkoutSchema.safeParse({ ...checkout, customerPhone: '01234567' }).success).toBe(false)
  })

  it('only accepts the expected HTTPS WhatsApp destination', () => {
    const response = {
      order: {
        actionId: '10000000-0000-4000-8000-000000000004',
        displayNumber: 'MOZ-000001',
        status: 'generated',
        totalCents: 2_200,
        currencyCode: 'ARS',
        createdAt: '2026-09-28T12:00:00Z',
      },
      whatsapp: {
        phone: '+5493492123456',
        message: 'Pedido',
        url: 'https://wa.me/5493492123456?text=Pedido',
      },
      clientEventToken: null,
    }
    expect(generatedOrderSchema.safeParse(response).success).toBe(true)
    expect(generatedOrderSchema.safeParse({
      ...response,
      whatsapp: { ...response.whatsapp, url: 'javascript:alert(1)' },
    }).success).toBe(false)
    expect(generatedOrderSchema.safeParse({
      ...response,
      whatsapp: { ...response.whatsapp, url: 'https://example.com/redirect' },
    }).success).toBe(false)
  })

  it('rejects malformed public locale settings before rendering formatters', async () => {
    const { publicMenuSchema } = await import('../lib/validation/schemas')
    const restaurant = {
      id: '10000000-0000-4000-8000-000000000005',
      name: 'Mozzi', tradeName: 'Mozzi', slug: 'mozzi', description: '',
      whatsappPhone: '+5493492123456', address: 'Calle 1', city: 'Rafaela',
      timezone: 'Invalid/Timezone', currencyCode: 'ARS', locale: 'es-AR',
      logoPath: null, coverPath: null, primaryColor: '#000000', secondaryColor: '#FFFFFF',
      deliveryEnabled: true, pickupEnabled: true, minimumOrderCents: 0,
      defaultPreparationMinutes: 30, isOpen: false, nextOpeningAt: null,
    }
    expect(publicMenuSchema.safeParse({
      restaurant,
      categories: [], businessHours: [], specialHours: [], paymentMethods: [], deliveryZones: [],
    }).success).toBe(false)
  })

  it('defaults legacy public products to no quantity prices and rejects duplicate rules', async () => {
    const { publicMenuSchema } = await import('../lib/validation/schemas')
    const product = {
      id: '10000000-0000-4000-8000-000000000020',
      categoryId: '10000000-0000-4000-8000-000000000021',
      code: 'EMP-1', name: 'Empanada', description: '', basePriceCents: 1000,
      promotionalPriceCents: null, promotionStartsAt: null, promotionEndsAt: null,
      imagePath: null, available: true, featured: false, sortOrder: 0, optionGroups: [],
    }
    const menu = {
      restaurant: {
        id: '10000000-0000-4000-8000-000000000022', name: 'Mozzi', tradeName: 'Mozzi', slug: 'mozzi', description: '',
        whatsappPhone: '+5493492123456', address: 'Calle 1', city: 'Rafaela', timezone: 'America/Argentina/Cordoba',
        currencyCode: 'ARS', locale: 'es-AR', logoPath: null, coverPath: null, primaryColor: '#000000', secondaryColor: '#FFFFFF',
        deliveryEnabled: true, pickupEnabled: true, minimumOrderCents: 0, defaultPreparationMinutes: 30, isOpen: true, nextOpeningAt: null,
      },
      categories: [{
        id: product.categoryId, name: 'Empanadas', slug: 'empanadas', description: '', imagePath: null, sortOrder: 0, products: [product],
      }],
      businessHours: [], specialHours: [], paymentMethods: [], deliveryZones: [],
    }

    const parsed = publicMenuSchema.parse(menu)
    expect(parsed.categories[0]?.products[0]?.quantityPrices).toEqual([])
    expect(publicMenuSchema.safeParse({
      ...menu,
      categories: [{ ...menu.categories[0], products: [{
        ...product,
        quantityPrices: [
          { quantity: 2, totalPriceCents: 1800 },
          { quantity: 2, totalPriceCents: 1700 },
        ],
      }] }],
    }).success).toBe(false)
  })

  it('reuses an attempt across reloads and rotates it when the cart changes or expires', () => {
    const fingerprint = checkoutCartFingerprint([line])
    const first = getCheckoutAttemptKey(
      'mozzi',
      fingerprint,
      1_000,
      () => '10000000-0000-4000-8000-000000000010',
    )
    const retry = getCheckoutAttemptKey(
      'mozzi',
      fingerprint,
      2_000,
      () => '10000000-0000-4000-8000-000000000011',
    )
    const changed = getCheckoutAttemptKey(
      'mozzi',
      checkoutCartFingerprint([{ ...line, quantity: 3 }]),
      3_000,
      () => '10000000-0000-4000-8000-000000000012',
    )
    const expired = getCheckoutAttemptKey(
      'mozzi',
      checkoutCartFingerprint([{ ...line, quantity: 3 }]),
      2 * 60 * 60 * 1000 + 3_001,
      () => '10000000-0000-4000-8000-000000000013',
    )

    expect(retry).toBe(first)
    expect(changed).not.toBe(first)
    expect(expired).not.toBe(changed)

    clearCheckoutAttempt('mozzi')
    expect(sessionStorage.length).toBe(0)
  })

  it('does not include display-only names and prices in the request fingerprint', () => {
    expect(checkoutCartFingerprint([line])).toBe(
      checkoutCartFingerprint([{
        ...line,
        productName: 'Nombre cambiado',
        unitPriceCents: 999_999,
        quantityPrices: [{ quantity: 2, totalPriceCents: 1 }],
        selectedOptions: [{ ...line.selectedOptions[0]!, name: 'Otro nombre', priceDeltaCents: 900 }],
      }]),
    )
  })
})
