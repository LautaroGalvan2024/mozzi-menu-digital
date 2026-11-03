import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseImportSheets, type ImportData } from '../lib/import-products'
import { latestImportSession, persistImportSession, prepareImportSession, rejectImportSession, withImportSubmission, type ImportSession } from '../lib/import-session'

const restaurant = 'restaurant-a'
const storageKey = `catalog-import:v1:${restaurant}`
const data = parseImportSheets({ Productos: [['codigo', 'nombre', 'categoria', 'precio'], ['0001', 'Uno', 'Cat', 100]] })
const changed = (name: string): ImportData => ({ ...data, products: data.products.map((product) => ({ ...product, name })) })
const read = () => JSON.parse(localStorage.getItem(storageKey)!) as {
  latest: string
  sessions: Record<string, ImportSession>
  receipts: Record<string, { batchId: string; mode: string; submitted: boolean; canonicalFingerprint: string }>
  order: string[]
}

async function complete(session: ImportSession, outcome: 'created' | 'skipped' = 'created') {
  session.submitted = true
  session.result = {
    batchId: session.batchId,
    summary: { created: outcome === 'created' ? session.data.products.length : 0, updated: 0, skipped: outcome === 'skipped' ? session.data.products.length : 0 },
    products: session.data.products.map((product) => ({ rowRef: product.rowRef, code: product.code ?? 'AUTO', id: crypto.randomUUID(), outcome })),
    errors: [],
  }
  return persistImportSession(restaurant, session)
}

describe('completed import payload compaction', () => {
  beforeEach(() => {
    localStorage.clear(); vi.restoreAllMocks()
    const tails = new Map<string, Promise<unknown>>()
    Object.defineProperty(navigator, 'locks', { configurable: true, value: {
      request: vi.fn((name: string, callback: () => unknown) => {
        const pending = (tails.get(name) ?? Promise.resolve()).then(callback)
        tails.set(name, pending.catch(() => undefined))
        return pending
      }),
    } })
  })

  it('keeps the latest full result and replaces older completed image-free payloads with identities', async () => {
    const first = await complete(await prepareImportSession(restaurant, data, 'create_only', 'primero.xlsx'))
    const second = await prepareImportSession(restaurant, changed('Dos'), 'create_or_update', 'segundo.xlsx')
    const store = read()
    expect(store.latest).toBe(second.batchId)
    expect(store.sessions[first.batchId]).toBeUndefined()
    expect(store.receipts[first.batchId]).toMatchObject({ batchId: first.batchId, mode: 'create_only', submitted: true })
    expect(store.receipts[first.batchId]).not.toHaveProperty('data')
    expect(store.receipts[first.batchId]).not.toHaveProperty('result')
    expect(latestImportSession(restaurant)?.batchId).toBe(second.batchId)
    await complete(second)
    expect(latestImportSession(restaurant)?.result?.batchId).toBe(second.batchId)
    expect(latestImportSession('restaurant-b')).toBeNull()
  })

  it('rehydrates exact values with the original batch and mode, regardless of object key order or file name', async () => {
    const first = await complete(await prepareImportSession(restaurant, data, 'skip_existing', 'primero.xlsx'), 'skipped')
    await prepareImportSession(restaurant, changed('Dos'), 'create_or_update', 'segundo.xlsx')
    const reordered: ImportData = { ...data, products: data.products.map((product) => Object.fromEntries(Object.entries(product).reverse()) as unknown as typeof product) }
    const restored = await prepareImportSession(restaurant, reordered, 'create_or_update', 'renombrado.csv')
    expect(restored.batchId).toBe(first.batchId)
    expect(restored.mode).toBe('skip_existing')
    expect(restored.fingerprint).toBe(first.fingerprint)
    expect(restored.contentFingerprint).toBe(first.contentFingerprint)
    expect(restored.submitted).toBe(true)
    expect(restored.result).toBeUndefined()
    expect(restored.data.products[0]).toEqual(first.data.products[0])
    // The existing submission path sees a submitted operation and fetches its result.
    await withImportSubmission(restaurant, restored, async (current) => {
      expect(current.submitted).toBe(true)
      expect(current.mode).toBe('skip_existing')
      expect(current.batchId).toBe(first.batchId)
      current.result = first.result!
      await persistImportSession(restaurant, current)
    })
    expect(latestImportSession(restaurant)?.result?.products[0]?.outcome).toBe('skipped')
  })

  it('preserves pending, uncertain, incomplete and image-bearing sessions in full', async () => {
    const pending = await prepareImportSession(restaurant, changed('Pendiente'), 'create_only', 'pendiente.xlsx')
    const uncertain = await prepareImportSession(restaurant, changed('Incierto'), 'create_only', 'incierto.xlsx')
    uncertain.submitted = true
    await persistImportSession(restaurant, uncertain)
    const withImages = { ...changed('Imagen'), products: changed('Imagen').products.map((product) => ({ ...product, imageFilename: 'imagen.jpg' })) }
    const image = await complete(await prepareImportSession(restaurant, withImages, 'create_only', 'imagen.xlsx'))
    const error = await prepareImportSession(restaurant, changed('Error'), 'create_only', 'error.xlsx')
    error.submitted = true
    error.result = { batchId: error.batchId, summary: { created: 0, updated: 0, skipped: 0 }, products: [], errors: [{ code: 'REVIEW', message: 'Revisar' }] }
    await persistImportSession(restaurant, error)
    await prepareImportSession(restaurant, changed('Último'), 'create_only', 'ultimo.xlsx')
    for (const session of [pending, uncertain, image, error]) {
      expect(read().sessions[session.batchId]).toBeDefined()
      expect(read().receipts[session.batchId]).toBeUndefined()
    }
  })

  it('preserves image attempt recovery even when no image filename remains in the payload', async () => {
    const image = await prepareImportSession(restaurant, data, 'create_only', 'imagen.xlsx')
    image.images['2'] = { path: 'uploaded.webp', expectedPath: 'previous.webp', associated: false }
    await complete(image)
    await prepareImportSession(restaurant, changed('Último'), 'create_only', 'ultimo.xlsx')
    expect(read().sessions[image.batchId]?.images['2']).toEqual(image.images['2'])
    expect(read().receipts[image.batchId]).toBeUndefined()
  })

  it('does not let a stale callback or rejection demote a completed receipt', async () => {
    const original = await prepareImportSession(restaurant, data, 'create_only', 'primero.xlsx')
    const stale = structuredClone(original)
    await complete(original)
    await prepareImportSession(restaurant, changed('Dos'), 'create_only', 'segundo.xlsx')
    await expect(rejectImportSession(restaurant, original.batchId)).rejects.toThrow(/ya está completada/)
    const restored = await persistImportSession(restaurant, { ...stale, mode: 'update_only' })
    expect(restored.submitted).toBe(true)
    expect(restored.mode).toBe('create_only')
    expect(restored.result).toBeUndefined()
    expect((await rejectImportSession(restaurant, original.batchId)).submitted).toBe(true)
    expect(read().receipts[original.batchId]?.submitted).toBe(true)
  })

  it('rejects altered source values when a stale writer claims an existing completed identity', async () => {
    const first = await complete(await prepareImportSession(restaurant, data, 'create_only', 'primero.xlsx'))
    await prepareImportSession(restaurant, changed('Dos'), 'create_only', 'segundo.xlsx')
    const before = localStorage.getItem(storageKey)
    await expect(persistImportSession(restaurant, { ...first, data: changed('Otro contenido') })).rejects.toThrow(/no coinciden/)
    expect(localStorage.getItem(storageKey)).toBe(before)
  })

  it('keeps deliberate new operation identities and chooses the most recently created matching operation', async () => {
    const first = await complete(await prepareImportSession(restaurant, data, 'create_only', 'primero.xlsx'))
    const second = await complete(await prepareImportSession(restaurant, data, 'skip_existing', 'segundo.xlsx', true), 'skipped')
    await prepareImportSession(restaurant, changed('Dos'), 'create_or_update', 'tercero.xlsx')
    // Resuming an old tab must not move its creation order ahead of the newer operation.
    await persistImportSession(restaurant, first)
    const matched = await prepareImportSession(restaurant, data, 'create_only', 'mismo.xlsx')
    expect(matched.batchId).toBe(second.batchId)
    expect(matched.mode).toBe('skip_existing')
    expect(read().receipts[first.batchId]).toBeDefined()
    expect(read().order.indexOf(first.batchId)).toBeLessThan(read().order.indexOf(second.batchId))
  })

  it('reads legacy stores without receipts or ordering and compacts them on the next write', async () => {
    const first = await complete(await prepareImportSession(restaurant, data, 'create_only', 'primero.xlsx'))
    localStorage.setItem(storageKey, JSON.stringify({ latest: first.batchId, sessions: { [first.batchId]: first } }))
    expect(latestImportSession(restaurant)?.result).toEqual(first.result)
    await prepareImportSession(restaurant, changed('Dos'), 'create_only', 'segundo.xlsx')
    expect(read().receipts[first.batchId]).toBeDefined()
    expect((await prepareImportSession(restaurant, data, 'create_only', 'primero.xlsx')).batchId).toBe(first.batchId)
  })

  it('keeps the original storage intact when the compacted write hits browser quota', async () => {
    const first = await complete(await prepareImportSession(restaurant, data, 'create_only', 'primero.xlsx'))
    const original = localStorage.getItem(storageKey)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Full', 'QuotaExceededError') })
    await expect(prepareImportSession(restaurant, changed('Dos'), 'create_only', 'segundo.xlsx')).rejects.toThrow(/no se enviará sin recuperación/)
    expect(localStorage.getItem(storageKey)).toBe(original)
    expect(latestImportSession(restaurant)?.result).toEqual(first.result)
  })

  it('bounds completed catalog payload growth while retaining all daily identities', async () => {
    let uncompressedSize = 0
    for (let day = 0; day < 8; day += 1) {
      const daily = parseImportSheets({ Productos: [['codigo', 'nombre', 'categoria', 'precio'], ...Array.from({ length: 317 }, (_, index) => [`SKU-${index}`, `Producto ${index}`, 'Cat', 100 + day])] })
      const completed = await complete(await prepareImportSession(restaurant, daily, 'create_or_update', 'diario.xlsx'))
      uncompressedSize += JSON.stringify(completed).length
    }
    const store = read()
    expect(Object.keys(store.sessions)).toHaveLength(1)
    expect(Object.keys(store.receipts)).toHaveLength(8)
    expect(store.order).toHaveLength(8)
    expect(localStorage.getItem(storageKey)!.length).toBeLessThan(uncompressedSize / 4)
  })
})
