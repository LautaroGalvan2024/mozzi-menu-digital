import { expect, it } from 'vitest'
import type { PublicCatalogGroup, PublicProduct } from '../../types/domain'
import { catalogGroupPresentation } from './PublicMenuPage'

function product(id: string, available: boolean, basePriceCents: number, promotionalPriceCents: number | null = null): PublicProduct {
  return {
    id,
    categoryId: '30000000-0000-4000-8000-000000000001',
    code: id,
    name: id,
    description: '',
    basePriceCents,
    promotionalPriceCents,
    promotionStartsAt: null,
    promotionEndsAt: null,
    imagePath: null,
    available,
    featured: false,
    sortOrder: 0,
    quantityPrices: [],
    optionGroups: [],
  }
}

it('presents a family with an available variant and its lowest purchasable price', () => {
  const unavailableCheap = product('10000000-0000-4000-8000-000000000001', false, 500)
  const availableRegular = product('10000000-0000-4000-8000-000000000002', true, 900, 700)
  const availableHigher = product('10000000-0000-4000-8000-000000000003', true, 800)
  const group: PublicCatalogGroup = {
    id: '20000000-0000-4000-8000-000000000001',
    categoryId: unavailableCheap.categoryId,
    family: {
      id: '20000000-0000-4000-8000-000000000001',
      name: 'Familia',
      description: '',
      imagePath: null,
      axes: ['Talle'],
    },
    variants: [unavailableCheap, availableRegular, availableHigher],
  }

  const presentation = catalogGroupPresentation(group)

  expect(presentation?.available).toBe(true)
  expect(presentation?.product.id).toBe(availableRegular.id)
  expect(presentation?.product.family?.name).toBe('Familia')
  expect(presentation?.price).toBe(700)
})

it('marks a family unavailable only when every variant is unavailable', () => {
  const first = product('10000000-0000-4000-8000-000000000001', false, 900)
  const cheaper = product('10000000-0000-4000-8000-000000000002', false, 600)
  const group: PublicCatalogGroup = {
    id: '20000000-0000-4000-8000-000000000001',
    categoryId: first.categoryId,
    family: null,
    variants: [first, cheaper],
  }

  const presentation = catalogGroupPresentation(group)

  expect(presentation?.available).toBe(false)
  expect(presentation?.product.id).toBe(first.id)
  expect(presentation?.price).toBe(600)
})
