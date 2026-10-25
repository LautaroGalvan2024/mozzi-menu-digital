import { beforeEach, describe, expect, it, vi } from 'vitest'
import { latestImportSession, persistImportSession, prepareImportSession } from '../lib/import-session'
import { parseImportSheets } from '../lib/import-products'

const data = parseImportSheets({ Productos: [['nombre', 'categoria', 'precio'], ['Uno', 'Cat', '100']] })
describe('recoverable catalog import identities', () => {
  beforeEach(() => {
    localStorage.clear(); vi.restoreAllMocks()
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: (_name: string, callback: () => unknown) => Promise.resolve(callback()) } })
  })
  it('reuses the same persisted operation after reload, rename and mode change', async () => {
    const first = await prepareImportSession('restaurant-a', data, 'create_only', 'catalogo.xlsx')
    first.submitted = true
    persistImportSession('restaurant-a', first)
    const retry = await prepareImportSession('restaurant-a', data, 'create_or_update', 'renombrado.csv')
    expect(retry.batchId).toBe(first.batchId)
    expect(retry.mode).toBe('create_only')
    expect(latestImportSession('restaurant-a')?.batchId).toBe(first.batchId)
    expect(latestImportSession('restaurant-b')).toBeNull()
  })
  it('a deliberate new import gets another identity while preserving the old operation', async () => {
    const first = await prepareImportSession('restaurant-a', data, 'create_or_update', 'catalogo.xlsx')
    const second = await prepareImportSession('restaurant-a', data, 'create_or_update', 'catalogo.xlsx', true)
    expect(second.batchId).not.toBe(first.batchId)
    expect(JSON.parse(localStorage.getItem('catalog-import:v1:restaurant-a') ?? '{}').sessions[first.batchId]).toBeDefined()
  })
  it('shares one identity for simultaneous preparations and refuses unsupported locking', async () => {
    const [first, second] = await Promise.all([
      prepareImportSession('restaurant-a', data, 'create_or_update', 'catalogo.xlsx'),
      prepareImportSession('restaurant-a', data, 'create_or_update', 'catalogo.xlsx'),
    ])
    expect(second.batchId).toBe(first.batchId)
    Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined })
    await expect(prepareImportSession('restaurant-b', data, 'create_or_update', 'catalogo.xlsx')).rejects.toThrow(/navegador/)
  })
  it('fails closed when persistence is unavailable or corrupted', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Full', 'QuotaExceededError') })
    await expect(prepareImportSession('restaurant-a', data, 'create_or_update', 'catalogo.xlsx')).rejects.toThrow(/no se enviará sin recuperación/)
    vi.restoreAllMocks()
    localStorage.setItem('catalog-import:v1:restaurant-a', '{}')
    await expect(prepareImportSession('restaurant-a', data, 'create_or_update', 'catalogo.xlsx')).rejects.toThrow(/registro local/)
  })
})
