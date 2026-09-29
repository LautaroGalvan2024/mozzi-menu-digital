import { describe, expect, it } from 'vitest'
import { orderSearchFilter } from '../lib/orders'

describe('order search classification', () => {
  it.each(['Juan', 'Ana', 'María', 'Ana-Maria'])(
    'treats the alphabetic customer name %s as a name',
    (term) => {
      expect(orderSearchFilter(term)).toEqual({ field: 'customer_name', value: term })
    },
  )

  it('recognizes human-readable order numbers with or without a hash', () => {
    expect(orderSearchFilter('MOZ-000123')).toEqual({
      field: 'display_number',
      value: 'MOZ-000123',
    })
    expect(orderSearchFilter('#MOZ-000123')).toEqual({
      field: 'display_number',
      value: 'MOZ-000123',
    })
  })

  it('keeps telephone-shaped terms as phone searches', () => {
    expect(orderSearchFilter('+54 (351) 555-1234')).toEqual({
      field: 'customer_phone',
      value: '+54 (351) 555-1234',
    })
  })

  it('escapes wildcard characters and ignores blank searches', () => {
    expect(orderSearchFilter('  ')).toBeNull()
    expect(orderSearchFilter('Ana%_')).toEqual({ field: 'customer_name', value: 'Ana' })
  })
})
