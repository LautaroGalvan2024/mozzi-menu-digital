import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildImportReview, loadImportCatalog, type ImportCatalogProduct } from '../lib/import-review'
import type { ImportData } from '../lib/import-products'
import { detectImportMapping, normalizeImportMapping } from '../lib/import-mapping'

const mocks = vi.hoisted(() => ({ from: vi.fn() }))
vi.mock('../lib/supabase/client', () => ({ supabase: { from: mocks.from } }))
const restaurantId = '10000000-0000-4000-8000-000000000001'
const product = (code: string, index = 1, deleted_at: string | null = null): ImportCatalogProduct => ({ id: `20000000-0000-4000-8000-${String(index).padStart(12, '0')}`, restaurant_id: restaurantId, code, deleted_at })
const data = (identities: { code?: string; id?: string }[]): ImportData => ({ products: identities.map((identity, index) => ({ rowRef: String(index + 2), name: 'Same name', category: 'General', basePriceCents: 100, ...identity })), groups: [], options: [], errors: [] })

describe('catalog import review identities', () => {
  it('matches normalized SKUs without dropping leading zeroes or matching by name', () => {
    const result = buildImportReview(data([{ code: ' abc ' }, { code: '000123' }, { code: '123' }, {}]), 'create_or_update', [product('ABC'), product('000123', 2)])
    expect(result.counts).toEqual({ create: 2, update: 2, skip: 0, review: 0 })
  })

  it('checks SKU and ID agreement, missing IDs, archived codes and duplicated target identities', () => {
    const existing = product('A')
    const rows = data([{ code: 'B', id: existing.id }, { id: product('missing', 8).id }, { code: 'OLD' }, { code: 'A' }, { id: existing.id }])
    const result = buildImportReview(rows, 'create_or_update', [existing, product('OLD', 2, '2026-01-01')])
    expect(result.counts).toEqual({ create: 0, update: 0, skip: 0, review: 5 })
    expect(result.rows[0]?.issues.join()).toContain('productos diferentes')
    expect(result.rows[1]?.issues.join()).toContain('este comercio')
    expect(result.rows[2]?.issues.join()).toContain('archivado')
    expect(result.rows[3]?.issues.join()).toContain('Más de una fila')
    expect(result.rows[4]?.issues.join()).toContain('Más de una fila')
  })

  it.each([
    ['create_only', { create: 1, update: 0, skip: 0, review: 1 }],
    ['update_only', { create: 0, update: 1, skip: 0, review: 1 }],
    ['skip_existing', { create: 1, update: 0, skip: 1, review: 0 }],
  ] as const)('reports the actual operation for %s', (mode, counts) => {
    expect(buildImportReview(data([{ code: 'A' }, { code: 'B' }]), mode, [product('a')]).counts).toEqual(counts)
  })

  it('counts each invalid physical row once and leaves explicitly excluded rows out', () => {
    const sheets = { Productos: [['codigo', 'nombre', 'categoria', 'precio'], ['A', 'Arroz', 'General', '100'], ['B', 'Yerba', 'General', '1.234'], ['C', 'Azúcar', 'General', 'sin precio']] }
    const mapping = { ...detectImportMapping(sheets), skippedRows: [4] }
    const normalized = normalizeImportMapping(sheets, mapping)
    const result = buildImportReview(normalized.data, 'create_or_update', [product('A')], normalized.rows)
    expect(result.counts).toEqual({ create: 0, update: 1, skip: 0, review: 1 })
    expect(result.rows.map(row => row.sourceRow).sort()).toEqual([2, 3])
  })

  it('does not choose between multiple catalog matches for the same normalized SKU', () => {
    const result = buildImportReview(data([{ code: 'a' }]), 'create_or_update', [product('A'), product('a', 2)])
    expect(result.counts.review).toBe(1)
    expect(result.rows[0]?.issues.join()).toContain('más de un producto')
  })
})

describe('catalog review lookup', () => {
  beforeEach(() => mocks.from.mockReset())

  function response(value: unknown, error: unknown = null) {
    const query = {
      select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), order: vi.fn().mockReturnThis(), limit: vi.fn().mockReturnThis(), gt: vi.fn().mockReturnThis(), abortSignal: vi.fn().mockReturnThis(),
      then: (resolve: (value: unknown) => void, reject: (reason: unknown) => void) => Promise.resolve({ data: value, error }).then(resolve, reject),
    }
    mocks.from.mockReturnValueOnce(query)
    return query
  }

  it('reads all keyset pages for the selected tenant, including archived code reservations', async () => {
    const first = response([product('A')])
    const second = response([product('OLD', 2, '2026-01-01')])
    const last = response([])
    const controller = new AbortController()
    expect(await loadImportCatalog(restaurantId, controller.signal)).toHaveLength(2)
    for (const query of [first, second, last]) {
      expect(query.eq).toHaveBeenCalledWith('restaurant_id', restaurantId)
      expect(query.abortSignal).toHaveBeenCalledWith(controller.signal)
    }
    expect(second.gt).toHaveBeenCalledWith('id', product('A').id)
    expect(last.gt).toHaveBeenCalledWith('id', product('OLD', 2).id)
  })

  it('rejects cross-tenant rows instead of presenting them as matches', async () => {
    response([{ ...product('A'), restaurant_id: '30000000-0000-4000-8000-000000000001' }])
    await expect(loadImportCatalog(restaurantId)).rejects.toThrow('verificar el catálogo de este comercio')
  })

  it('does not turn a failed or incomplete response into an empty catalog', async () => {
    response(null, { message: 'offline' })
    await expect(loadImportCatalog(restaurantId)).rejects.toThrow('comprobar los códigos')
    response(null)
    await expect(loadImportCatalog(restaurantId)).rejects.toThrow('verificar el catálogo')
  })

  it('rejects a repeated pagination cursor and honours cancellation', async () => {
    response([product('A')])
    response([product('A')])
    await expect(loadImportCatalog(restaurantId)).rejects.toThrow('cambió durante la comprobación')
    const controller = new AbortController()
    controller.abort()
    await expect(loadImportCatalog(restaurantId, controller.signal)).rejects.toThrow()
    expect(mocks.from).toHaveBeenCalledTimes(2)
  })
})
