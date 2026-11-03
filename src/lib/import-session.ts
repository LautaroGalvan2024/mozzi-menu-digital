import { z } from 'zod'
import type { ImportData } from './import-products'

export const importResultSchema = z.object({
  batchId: z.string().uuid(),
  summary: z.object({ created: z.number().int().nonnegative(), updated: z.number().int().nonnegative(), skipped: z.number().int().nonnegative() }),
  products: z.array(z.object({ rowRef: z.string().min(1).max(80), code: z.string(), id: z.string().uuid(), outcome: z.enum(['created', 'updated', 'skipped']) })),
  errors: z.array(z.object({ row: z.number().int().optional(), code: z.string(), message: z.string() })),
})
export type ImportResult = z.infer<typeof importResultSchema>
export type ImportMode = 'create_or_update' | 'create_only' | 'skip_existing' | 'update_only'
export interface ImportImageAttempt { path: string; expectedPath: string | null; associated: boolean }
export interface ImportSession {
  batchId: string
  fingerprint: string
  contentFingerprint: string
  fileName: string
  mode: ImportMode
  data: ImportData
  submitted: boolean
  result?: ImportResult
  images: Record<string, ImportImageAttempt>
}

const key = (restaurantId: string) => `catalog-import:v1:${restaurantId}`
interface ImportReceipt {
  batchId: string
  fingerprint: string
  contentFingerprint: string
  canonicalFingerprint: string
  fileName: string
  mode: ImportMode
  submitted: true
}
interface SessionStore {
  latest: string
  sessions: Record<string, ImportSession>
  receipts: Record<string, ImportReceipt>
  // Creation order survives removal of full payloads and later rehydration.
  order: string[]
}

const sessionSchema = z.object({
  batchId: z.string().uuid(), fingerprint: z.string().length(64), contentFingerprint: z.string().length(64), fileName: z.string(),
  mode: z.enum(['create_or_update', 'create_only', 'skip_existing', 'update_only']), submitted: z.boolean(), result: importResultSchema.optional(),
  images: z.record(z.string(), z.object({ path: z.string(), expectedPath: z.string().nullable(), associated: z.boolean() })),
  data: z.object({
    products: z.array(z.object({ rowRef: z.string(), name: z.string(), category: z.string(), basePriceCents: z.number(), code: z.string().optional(), id: z.string().uuid().optional(), description: z.string().optional(), promotionalPriceCents: z.number().nullable().optional(), promotionStartsAt: z.string().nullable().optional(), promotionEndsAt: z.string().nullable().optional(), active: z.boolean().optional(), available: z.boolean().optional(), featured: z.boolean().optional(), sortOrder: z.number().optional(), imageFilename: z.string().optional(), familyCode: z.string().optional(), familyName: z.string().optional(), variantAttributes: z.record(z.string(), z.string()).optional() })).max(500),
    groups: z.array(z.object({ productRowRef: z.string().optional(), productCode: z.string().optional(), groupCode: z.string(), name: z.string(), required: z.boolean(), minSelect: z.number(), maxSelect: z.number(), sortOrder: z.number(), active: z.boolean() })).max(2500),
    options: z.array(z.object({ groupCode: z.string(), optionCode: z.string(), name: z.string(), priceDeltaCents: z.number(), sortOrder: z.number(), active: z.boolean() })).max(10000), errors: z.array(z.string()),
  }),
})

const receiptSchema = z.object({
  batchId: z.string().uuid(), fingerprint: z.string().length(64), contentFingerprint: z.string().length(64), fileName: z.string(),
  canonicalFingerprint: z.string().length(64),
  mode: z.enum(['create_or_update', 'create_only', 'skip_existing', 'update_only']), submitted: z.literal(true),
}).strict()
const storeSchema = z.object({
  latest: z.string(), sessions: z.record(z.string(), sessionSchema),
  receipts: z.record(z.string(), receiptSchema).default({}), order: z.array(z.string()).optional(),
})

const contentOf = (data: ImportData) => JSON.stringify({ products: data.products, groups: data.groups, options: data.options })
// Existing operation fingerprints must remain unchanged. This additional digest
// verifies receipt hydration even when schema parsing reordered object keys.
const canonicalContentOf = (data: ImportData) => JSON.stringify({ products: data.products, groups: data.groups, options: data.options }, (_key, value: unknown) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
})
const hash = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), (byte) => byte.toString(16).padStart(2, '0')).join('')

async function verifyReceiptData(receipt: ImportReceipt, data: ImportData): Promise<void> {
  const canonicalFingerprint = await hash(canonicalContentOf(data))
  if (data.errors.length || canonicalFingerprint !== receipt.canonicalFingerprint) {
    throw new Error('Los datos no coinciden con la importación guardada. Conservamos su identidad; volvé a seleccionar el archivo original.')
  }
}

function readStore(restaurantId: string): SessionStore {
  const raw = localStorage.getItem(key(restaurantId))
  if (!raw) return { latest: '', sessions: {}, receipts: {}, order: [] }
  const parsed = storeSchema.safeParse(JSON.parse(raw))
  if (!parsed.success) throw new Error('El registro local de importaciones no se puede leer. No inicies otro lote hasta recuperar el anterior.')
  const sessions = parsed.data.sessions as Record<string, ImportSession>
  const receipts = parsed.data.receipts
  const identities = new Set([...Object.keys(sessions), ...Object.keys(receipts)])
  const order = parsed.data.order ?? [...identities]
  if (order.length !== identities.size || new Set(order).size !== order.length || order.some((id) => !identities.has(id))
    || Object.entries(sessions).some(([id, session]) => id !== session.batchId)
    || Object.entries(receipts).some(([id, receipt]) => id !== receipt.batchId || (sessions[id] && (
      sessions[id].fingerprint !== receipt.fingerprint || sessions[id].contentFingerprint !== receipt.contentFingerprint || sessions[id].mode !== receipt.mode
    ))) || (parsed.data.latest && !sessions[parsed.data.latest])) {
    throw new Error('El registro local de importaciones no se puede leer. No inicies otro lote hasta recuperar el anterior.')
  }
  return { latest: parsed.data.latest, sessions, receipts, order }
}

export function latestImportSession(restaurantId: string): ImportSession | null {
  const store = readStore(restaurantId)
  return store.sessions[store.latest] ?? null
}

async function writeSession(restaurantId: string, store: SessionStore, session: ImportSession): Promise<void> {
  store.latest = session.batchId
  store.sessions[session.batchId] = session
  if (!store.order.includes(session.batchId)) store.order.push(session.batchId)
  for (const [id, candidate] of Object.entries(store.sessions)) {
    // Image recovery needs its original paths and full row data. Uncertain or
    // unsubmitted batches must also remain fully recoverable without the file.
    const completedWithoutImages = candidate.submitted && candidate.result?.batchId === id && candidate.result.errors.length === 0
      && !candidate.data.products.some((product) => product.imageFilename) && Object.keys(candidate.images).length === 0
    if (!completedWithoutImages) continue
    if (!store.receipts[id]) store.receipts[id] = {
      batchId: candidate.batchId, fingerprint: candidate.fingerprint, contentFingerprint: candidate.contentFingerprint,
      canonicalFingerprint: await hash(canonicalContentOf(candidate.data)), fileName: candidate.fileName, mode: candidate.mode, submitted: true,
    }
    if (id !== store.latest) delete store.sessions[id]
  }
  try {
    // Keep every identity, while older completed payloads can be recovered from
    // a reread of the same file and the server's existing result endpoint.
    localStorage.setItem(key(restaurantId), JSON.stringify(store))
  } catch {
    throw new Error('No pudimos guardar el reintento en este navegador. Liberá espacio antes de importar; el lote no se enviará sin recuperación.')
  }
}

async function withImportLock<T>(name: string, callback: () => T | Promise<T>): Promise<T> {
  // An in-memory fallback cannot coordinate other tabs. Fail before sending a batch.
  if (!navigator.locks) throw new Error('Este navegador no puede proteger el reintento entre pestañas. Actualizalo antes de importar.')
  return navigator.locks.request(name, callback)
}

// Call only while holding the store lock; acquiring it here would be reentrant.
async function persistSessionLocked(restaurantId: string, session: ImportSession): Promise<ImportSession> {
  const store = readStore(restaurantId)
  const saved = store.sessions[session.batchId]
  const receipt = store.receipts[session.batchId]
  if (receipt) await verifyReceiptData(receipt, session.data)
  const images = { ...session.images, ...saved?.images }
  for (const [rowRef, attempt] of Object.entries(session.images)) {
    const prior = images[rowRef]
    if (prior?.path === attempt.path) images[rowRef] = { ...prior, associated: prior.associated || attempt.associated }
  }
  // A stale tab must not erase a committed result, pending submission, or image progress.
  const merged = { ...session, ...saved, ...receipt, submitted: !!receipt || !!saved?.submitted || session.submitted, images }
  const result = saved?.result ?? session.result
  if (result) merged.result = result
  await writeSession(restaurantId, store, merged)
  return merged
}

export async function persistImportSession(restaurantId: string, session: ImportSession): Promise<ImportSession> {
  return withImportLock(`catalog-import:${restaurantId}`, () => persistSessionLocked(restaurantId, session))
}

export async function withImportSubmission<T>(restaurantId: string, session: ImportSession, callback: (current: ImportSession) => Promise<T>): Promise<T> {
  // Network work is serialized per batch, without blocking persistence for other batches.
  // This also prevents one tab's rollback from unlocking another tab's in-flight request.
  return withImportLock(`catalog-import-submit:${restaurantId}:${session.batchId}`, async () => callback(await persistImportSession(restaurantId, session)))
}

// Only after an authoritative rollback on a previously unsubmitted batch, inside
// withImportSubmission. Ambiguous attempts and idempotency conflicts must stay submitted.
export async function rejectImportSession(restaurantId: string, batchId: string): Promise<ImportSession> {
  return withImportLock(`catalog-import:${restaurantId}`, async () => {
    const store = readStore(restaurantId)
    const saved = store.sessions[batchId]
    if (store.receipts[batchId]) {
      if (!saved) throw new Error('La importación ya está completada. Volvé a seleccionar el archivo para recuperar su resultado.')
      // Its result may not have been fetched since rehydration; the receipt is
      // still authoritative proof that this operation must never be rolled back.
      const completed = { ...saved, submitted: true }
      await writeSession(restaurantId, store, completed)
      return completed
    }
    if (!saved) throw new Error('No pudimos recuperar el registro local de la importación.')
    const rejected = saved.result ? saved : { ...saved, submitted: false }
    await writeSession(restaurantId, store, rejected)
    return rejected
  })
}

export async function prepareImportSession(restaurantId: string, data: ImportData, mode: ImportMode, fileName: string, forceNew = false): Promise<ImportSession> {
  const content = contentOf(data)
  const [fingerprint, contentFingerprint, canonicalFingerprint] = await Promise.all([hash(`${mode}:${content}`), hash(content), hash(canonicalContentOf(data))])
  return withImportLock(`catalog-import:${restaurantId}`, () => {
    const store = readStore(restaurantId)
    const priorId = store.order.findLast((id) => {
      const candidate = store.sessions[id] ?? store.receipts[id]
      return candidate && (candidate.fingerprint === fingerprint || (candidate.submitted && candidate.contentFingerprint === contentFingerprint)
        || store.receipts[id]?.canonicalFingerprint === canonicalFingerprint)
    })
    const prior = priorId ? store.sessions[priorId] ?? store.receipts[priorId] : undefined
    const session: ImportSession = !forceNew && prior
      ? 'data' in prior ? prior : { ...prior, data, images: {} }
      : { batchId: crypto.randomUUID(), fingerprint, contentFingerprint, fileName, mode, data, submitted: false, images: {} }
    return persistSessionLocked(restaurantId, session)
  })
}
