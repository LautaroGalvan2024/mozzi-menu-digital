import { ZipWriter, Uint8ArrayReader, TextReader } from '@zip.js/zip.js/lib/zip-core-native.js'
import { z } from 'zod'
import { supabase } from '../supabase/client'
import { publicAssetUrl } from '../supabase/public-assets'

const productSchema = z.object({ id: z.string().uuid(), code: z.string(), name: z.string(), image_path: z.string().nullable() })
export type ImageExportProduct = z.infer<typeof productSchema>
export interface ImageExportProgress { current: number; total: number; label: string }
export interface ImageExportManifest {
  version: 1
  restaurantId: string
  products: Array<{ productId: string; sku: string; path: string }>
  missingImages: Array<{ productId: string; sku: string }>
  errors: Array<{ productId: string; sku: string; message: string }>
}
const CATALOG_PAGE_SIZE = 500
const MAX_ASSET_BYTES = 15 * 1024 * 1024
const PREFETCH = 3

export async function collectImageCatalog(readPage: (afterId: string | null, signal: AbortSignal) => Promise<ImageExportProduct[]>, signal: AbortSignal) {
  const products: ImageExportProduct[] = []
  let cursor: string | null = null
  for (;;) {
    signal.throwIfAborted()
    const page = await readPage(cursor, signal)
    signal.throwIfAborted()
    if (!page.length) return products
    for (const product of page) {
      if (cursor !== null && product.id <= cursor) throw new Error('El catálogo cambió durante la lectura. Volvé a preparar la descarga.')
      products.push(product)
      cursor = product.id
    }
    // Continue to an empty page even if the server imposes a smaller page cap.
  }
}

export function readImageCatalog(restaurantId: string, signal: AbortSignal) {
  return collectImageCatalog(async (afterId, pageSignal) => {
    let request = supabase.from('products').select('id,code,name,image_path').eq('restaurant_id', restaurantId).is('deleted_at', null).order('id').limit(CATALOG_PAGE_SIZE).abortSignal(pageSignal)
    if (afterId) request = request.gt('id', afterId)
    const { data, error } = await request
    if (error) throw new Error('No se pudo leer el catálogo completo. Reintentá la descarga.')
    return z.array(productSchema).parse(data)
  }, signal)
}

function safeFilenamePart(value: string, length: number) {
  return value.normalize('NFKC').replace(/[^\p{L}\p{N}_-]/gu, '-').replace(/-+/g, '-').slice(0, length) || 'producto'
}

export function imageExportFilename(product: ImageExportProduct, extension: string) {
  return `${safeFilenamePart(product.code, 60)}_${safeFilenamePart(product.name, 80)}_${product.id}.${extension}`
}

function imageExtension(bytes: Uint8Array) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg'
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) return 'png'
  if (String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') return 'webp'
  throw new Error('El archivo guardado no es una imagen JPEG, PNG o WebP válida.')
}

async function fetchImageBytes(product: ImageExportProduct, restaurantId: string, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  if (!product.image_path?.startsWith(`restaurants/${restaurantId}/`)) throw new Error('La imagen no pertenece al comercio.')
  const url = publicAssetUrl(product.image_path)
  if (!url) throw new Error('La ruta de la imagen no es válida.')
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    signal.throwIfAborted()
    try {
      const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)])
      const response = await fetch(url, { signal: requestSignal, credentials: 'omit' })
      if (!response.ok) throw new Error(`No se pudo descargar la imagen (HTTP ${response.status}).`)
      if (Number(response.headers.get('content-length')) > MAX_ASSET_BYTES) { await response.body?.cancel(); throw new Error('La imagen guardada supera 15 MB.') }
      if (!response.body) throw new Error('La imagen está vacía.')
      const reader = response.body.getReader()
      const chunks: Uint8Array<ArrayBuffer>[] = []
      let size = 0
      try {
        for (;;) {
          const part = await reader.read()
          if (part.done) break
          size += part.value.byteLength
          if (size > MAX_ASSET_BYTES) throw new Error('La imagen guardada supera 15 MB.')
          chunks.push(Uint8Array.from(part.value))
        }
      } finally {
        await reader.cancel().catch(() => undefined)
        reader.releaseLock()
      }
      const bytes = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
      imageExtension(bytes)
      return bytes
    } catch (error) { lastError = error; signal.throwIfAborted() }
  }
  throw lastError
}

/** Only PREFETCH image bodies are retained; entries are written sequentially. */
export async function writeImageArchive({ restaurantId, products, writable, signal, onProgress, readImage = fetchImageBytes }: {
  restaurantId: string
  products: ImageExportProduct[]
  writable: WritableStream<Uint8Array>
  signal: AbortSignal
  onProgress: (progress: ImageExportProgress) => void
  readImage?: (product: ImageExportProduct, restaurantId: string, signal: AbortSignal) => Promise<Uint8Array<ArrayBuffer>>
}): Promise<ImageExportManifest> {
  const manifest: ImageExportManifest = { version: 1, restaurantId, products: [], missingImages: [], errors: [] }
  const images = products.filter(product => product.image_path !== null)
  manifest.missingImages = products.filter(product => product.image_path === null).map(product => ({ productId: product.id, sku: product.code }))
  const abort = new AbortController()
  const workSignal = AbortSignal.any([signal, abort.signal])
  const writer = new ZipWriter(writable, { level: 0, bufferedWrite: false, useWebWorkers: false, signal: workSignal })
  type Download = { bytes: Uint8Array<ArrayBuffer>; error?: never } | { bytes?: never; error: string }
  const pending = new Map<number, Promise<Download>>()
  function start(index: number) {
    const product = images[index]
    if (!product) return
    pending.set(index, readImage(product, restaurantId, workSignal).then(bytes => ({ bytes }), error => ({ error: error instanceof Error ? error.message : 'No se pudo descargar la imagen.' })))
  }
  try {
    signal.throwIfAborted()
    for (let index = 0; index < Math.min(PREFETCH, images.length); index++) start(index)
    for (let index = 0; index < images.length; index++) {
      signal.throwIfAborted()
      const product = images[index]!
      const downloaded = (await pending.get(index))!
      pending.delete(index)
      signal.throwIfAborted()
      if (downloaded.error !== undefined) {
        manifest.errors.push({ productId: product.id, sku: product.code, message: downloaded.error })
      } else {
        const filename = imageExportFilename(product, imageExtension(downloaded.bytes))
        await writer.add(filename, new Uint8ArrayReader(downloaded.bytes))
        manifest.products.push({ productId: product.id, sku: product.code, path: filename })
      }
      onProgress({ current: index + 1, total: images.length, label: product.name })
      start(index + PREFETCH)
    }
    signal.throwIfAborted()
    await writer.add('images-manifest.json', new TextReader(JSON.stringify(manifest, null, 2)))
    await writer.close()
    return manifest
  } finally {
    abort.abort()
    await Promise.allSettled(pending.values())
  }
}
