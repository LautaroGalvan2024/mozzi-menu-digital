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
interface SessionStore { latest: string; sessions: Record<string, ImportSession> }

const sessionSchema = z.object({
  batchId: z.string().uuid(), fingerprint: z.string().length(64), contentFingerprint: z.string().length(64), fileName: z.string(),
  mode: z.enum(['create_or_update', 'create_only', 'skip_existing', 'update_only']), submitted: z.boolean(), result: importResultSchema.optional(),
  images: z.record(z.string(), z.object({ path: z.string(), expectedPath: z.string().nullable(), associated: z.boolean() })),
  data: z.object({
    products: z.array(z.object({ rowRef: z.string(), name: z.string(), category: z.string(), basePriceCents: z.number(), code: z.string().optional(), id: z.string().uuid().optional(), description: z.string().optional(), promotionalPriceCents: z.number().nullable().optional(), promotionStartsAt: z.string().nullable().optional(), promotionEndsAt: z.string().nullable().optional(), active: z.boolean().optional(), available: z.boolean().optional(), featured: z.boolean().optional(), sortOrder: z.number().optional(), imageFilename: z.string().optional() })).max(500),
    groups: z.array(z.object({ productRowRef: z.string().optional(), productCode: z.string().optional(), groupCode: z.string(), name: z.string(), required: z.boolean(), minSelect: z.number(), maxSelect: z.number(), sortOrder: z.number(), active: z.boolean() })).max(2500),
    options: z.array(z.object({ groupCode: z.string(), optionCode: z.string(), name: z.string(), priceDeltaCents: z.number(), sortOrder: z.number(), active: z.boolean() })).max(10000), errors: z.array(z.string()),
  }),
})

function readStore(restaurantId: string): SessionStore {
  const raw = localStorage.getItem(key(restaurantId))
  if (!raw) return { latest: '', sessions: {} }
  const parsed = z.object({ latest: z.string(), sessions: z.record(z.string(), sessionSchema) }).safeParse(JSON.parse(raw))
  if (!parsed.success) throw new Error('El registro local de importaciones no se puede leer. No inicies otro lote hasta recuperar el anterior.')
  return parsed.data as SessionStore
}

export function latestImportSession(restaurantId: string): ImportSession | null {
  const store = readStore(restaurantId)
  return store.sessions[store.latest] ?? null
}

export function persistImportSession(restaurantId: string, session: ImportSession): void {
  const store = readStore(restaurantId)
  store.latest = session.batchId
  store.sessions[session.batchId] = session
  try {
    // Keep completed identities too: reselection must not silently recreate an old batch.
    localStorage.setItem(key(restaurantId), JSON.stringify(store))
  } catch {
    throw new Error('No pudimos guardar el reintento en este navegador. Liberá espacio antes de importar; el lote no se enviará sin recuperación.')
  }
}

export async function prepareImportSession(restaurantId: string, data: ImportData, mode: ImportMode, fileName: string, forceNew = false): Promise<ImportSession> {
  const content = JSON.stringify({ products: data.products, groups: data.groups, options: data.options })
  const hash = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), (byte) => byte.toString(16).padStart(2, '0')).join('')
  const [fingerprint, contentFingerprint] = await Promise.all([hash(`${mode}:${content}`), hash(content)])
  if (!navigator.locks) throw new Error('Este navegador no puede proteger el reintento entre pestañas. Actualizalo antes de importar.')
  return navigator.locks.request(`catalog-import:${restaurantId}`, () => {
    const store = readStore(restaurantId)
    const prior = Object.values(store.sessions).findLast((session) => session.fingerprint === fingerprint || (session.submitted && session.contentFingerprint === contentFingerprint))
    const session = !forceNew && prior ? prior : { batchId: crypto.randomUUID(), fingerprint, contentFingerprint, fileName, mode, data, submitted: false, images: {} }
    persistImportSession(restaurantId, session)
    return session
  })
}
