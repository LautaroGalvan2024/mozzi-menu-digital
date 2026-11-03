import { z } from 'zod'
import type { ImportImageAttempt } from '../import-session'
import { imageDigest } from './image-archive'
import type { ImageUploadTarget } from './import-image-batch'

export interface ImageOnlySession {
  id: string
  restaurantId: string
  fingerprint: string
  archiveFingerprint: string
  fileName: string
  targets: ImageUploadTarget[]
  attempts: Record<string, ImportImageAttempt>
  started: boolean
}
const schema = z.object({
  id: z.string().uuid(), restaurantId: z.string().uuid(), fingerprint: z.string().length(64), archiveFingerprint: z.string().length(64), fileName: z.string(), started: z.boolean(),
  targets: z.array(z.object({ key: z.string(), productId: z.string().uuid(), filename: z.string(), expectedPath: z.string().nullable() })),
  attempts: z.record(z.string(), z.object({ path: z.string(), expectedPath: z.string().nullable(), associated: z.boolean() })),
})
const storeSchema = z.object({ latest: z.string(), sessions: z.record(z.string(), schema) })
const key = (restaurantId: string) => `catalog-image-import:v1:${restaurantId}`

function readStore(restaurantId: string) {
  const raw = localStorage.getItem(key(restaurantId))
  if (!raw) return { latest: '', sessions: {} as Record<string, ImageOnlySession> }
  const parsed = storeSchema.safeParse(JSON.parse(raw))
  if (!parsed.success || Object.entries(parsed.data.sessions).some(([id, value]) => id !== value.id || value.restaurantId !== restaurantId) || !parsed.data.sessions[parsed.data.latest]) {
    throw new Error('No pudimos leer los intentos de imágenes guardados. Conservá el ZIP y revisá el almacenamiento de este navegador.')
  }
  return parsed.data
}
function writeStore(restaurantId: string, store: { latest: string; sessions: Record<string, ImageOnlySession> }) {
  try { localStorage.setItem(key(restaurantId), JSON.stringify(store)) }
  catch { throw new Error('No pudimos guardar la recuperación de imágenes. Liberá espacio en este navegador antes de continuar.') }
}
export async function imageImportLock<T>(restaurantId: string, operation: string, callback: () => Promise<T>): Promise<T> {
  if (!navigator.locks) throw new Error('Actualizá el navegador para poder recuperar la carga de imágenes entre pestañas.')
  return navigator.locks.request(`catalog-image-import:${restaurantId}:${operation}`, callback)
}
export function latestImageOnlySession(restaurantId: string): ImageOnlySession | null {
  const store = readStore(restaurantId)
  return store.sessions[store.latest] ?? null
}
export async function prepareImageOnlySession(restaurantId: string, archiveFingerprint: string, fileName: string, targets: ImageUploadTarget[], forceNew = false): Promise<ImageOnlySession> {
  const ordered = [...targets].sort((a, b) => a.filename.localeCompare(b.filename))
  const fingerprint = await imageDigest(JSON.stringify({ restaurantId, archiveFingerprint, mapping: ordered.map(({ filename, productId }) => ({ filename, productId })) }))
  return imageImportLock(restaurantId, 'store', async () => {
    const store = readStore(restaurantId)
    const prior = Object.values(store.sessions).findLast(session => session.fingerprint === fingerprint)
    const session: ImageOnlySession = !forceNew && prior ? prior : { id: crypto.randomUUID(), restaurantId, fingerprint, archiveFingerprint, fileName, targets: ordered, attempts: {}, started: false }
    store.sessions[session.id] = session
    store.latest = session.id
    writeStore(restaurantId, store)
    return session
  })
}
export async function persistImageOnlySession(session: ImageOnlySession): Promise<ImageOnlySession> {
  return imageImportLock(session.restaurantId, 'store', async () => {
    const store = readStore(session.restaurantId)
    const prior = store.sessions[session.id]
    if (prior && prior.fingerprint !== session.fingerprint) throw new Error('La asignación no coincide con el intento guardado.')
    const attempts = { ...session.attempts, ...prior?.attempts }
    for (const [id, attempt] of Object.entries(session.attempts)) {
      const saved = attempts[id]
      if (saved?.path === attempt.path) attempts[id] = { ...attempt, associated: saved.associated || attempt.associated }
    }
    const merged = { ...session, ...prior, started: session.started || !!prior?.started, attempts }
    store.sessions[session.id] = merged
    store.latest = session.id
    writeStore(session.restaurantId, store)
    // The executor retains the active attempt while persisting its uploaded path.
    // Keep that object live so the later association acknowledgement is not lost.
    for (const [id, attempt] of Object.entries(merged.attempts)) {
      const live = session.attempts[id]
      if (live?.path === attempt.path) Object.assign(live, attempt)
      else session.attempts[id] = attempt
    }
    Object.assign(session, { ...merged, attempts: session.attempts })
    return session
  })
}
