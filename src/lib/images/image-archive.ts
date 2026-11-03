import type { Entry, FileEntry } from '@zip.js/zip.js'
import { z } from 'zod'

export const MAX_IMAGE_ZIP_BYTES = 100 * 1024 * 1024
export const MAX_IMAGE_EXTRACTED_BYTES = 250 * 1024 * 1024
export const MAX_ARCHIVE_IMAGE_BYTES = 15 * 1024 * 1024
const MAX_MANIFEST_BYTES = 5 * 1024 * 1024

const manifestSchema = z.object({
  version: z.literal(1), restaurantId: z.string().uuid(),
  products: z.array(z.object({ productId: z.string().uuid(), sku: z.string().max(80), path: z.string().max(500) })).max(20_000),
})
export type ImageManifest = z.infer<typeof manifestSchema>
export interface ImageArchive {
  fingerprint: string
  fileName: string
  files: string[]
  ignored: string[]
  entries: Map<string, FileEntry>
  manifest: ImageManifest | null
}
export interface ImageCatalogProduct { id: string; code: string; name: string; image_path: string | null }
export interface ImageMatch { productId: string | null; issue?: string }

export async function blobBytes(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.onerror = () => reject(new Error('No pudimos leer el archivo seleccionado.'))
    reader.readAsArrayBuffer(blob)
  })
}

export async function imageDigest(value: ArrayBuffer | string): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('')
}

export function archivePath(value: string): string {
  const path = value.replaceAll('\\', '/').normalize('NFC')
  if (!path || path.startsWith('/') || /^[a-z]:/i.test(path) || Array.from(path).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) || path.split('/').includes('..')) {
    throw new Error('El ZIP contiene una ruta de archivo no permitida.')
  }
  return path.split('/').filter(segment => segment && segment !== '.').join('/')
}

export function imageMimeType(path: string): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (/\.jpe?g$/i.test(path)) return 'image/jpeg'
  if (/\.png$/i.test(path)) return 'image/png'
  if (/\.webp$/i.test(path)) return 'image/webp'
  return null
}

function entrySize(entry: FileEntry): number {
  const size = entry.uncompressedSize
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('No pudimos validar el tamaño del contenido del ZIP.')
  return size
}

async function checkedBytes(entry: FileEntry, limit: number, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  if (entrySize(entry) > limit) throw new Error(`El archivo ${entry.filename} supera el tamaño permitido.`)
  const chunks: Uint8Array<ArrayBuffer>[] = []
  let length = 0
  let exceeded = false
  try {
    await entry.getData(new WritableStream<Uint8Array>({ write(chunk) {
      length += chunk.byteLength
      if (length > limit || length > entrySize(entry)) { exceeded = true; throw new Error('IMAGE_EXTRACTION_LIMIT') }
      chunks.push(Uint8Array.from(chunk))
    } }), { checkSignature: true, useWebWorkers: false, ...(signal ? { signal } : {}) })
  } catch {
    signal?.throwIfAborted()
    throw new Error(exceeded ? `El archivo ${entry.filename} supera el límite de extracción.` : `El archivo ${entry.filename} está dañado o usa un formato ZIP no compatible. Volvé a generar el ZIP.`)
  }
  if (length !== entrySize(entry)) throw new Error(`El archivo ${entry.filename} está dañado.`)
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return bytes
}

export async function archiveImageFile(archive: ImageArchive, filename: string, signal?: AbortSignal): Promise<File> {
  const entry = archive.entries.get(filename)
  const type = imageMimeType(filename)
  if (!entry || !type) throw new Error('No se encontró una imagen JPEG, PNG o WebP válida.')
  const bytes = await checkedBytes(entry, MAX_ARCHIVE_IMAGE_BYTES, signal)
  const png = bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71 && bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  const webp = new TextDecoder().decode(bytes.subarray(0, 4)) === 'RIFF' && new TextDecoder().decode(bytes.subarray(8, 12)) === 'WEBP'
  if (!(type === 'image/png' ? png : type === 'image/jpeg' ? jpeg : webp)) throw new Error(`El contenido de ${filename} no coincide con su formato de imagen.`)
  return new File([bytes.buffer], filename.split('/').at(-1)!, { type })
}

export async function readImageArchive(file: File, signal?: AbortSignal): Promise<ImageArchive> {
  if (file.size > MAX_IMAGE_ZIP_BYTES) throw new Error('El ZIP supera el límite comprimido de 100 MB.')
  if (!file.size) throw new Error('El ZIP está vacío.')
  const buffer = await blobBytes(file)
  signal?.throwIfAborted()
  const { ZipReader, Uint8ArrayReader } = await import('@zip.js/zip.js/lib/zip-core-native.js')
  const reader = new ZipReader(new Uint8ArrayReader(new Uint8Array(buffer)), { useWebWorkers: false })
  const zipEntries: Entry[] = []
  try {
    for await (const entry of reader.getEntriesGenerator()) {
      signal?.throwIfAborted()
      if (zipEntries.length >= 20_000) throw new Error('El ZIP contiene demasiados archivos o carpetas.')
      zipEntries.push(entry)
    }
  } catch { throw new Error('No pudimos abrir el ZIP de imágenes. Seleccioná un ZIP válido, sin contraseña y con hasta 20.000 archivos.') }
  finally { await reader.close() }
  const entries = new Map<string, FileEntry>()
  const ignored: string[] = []
  let total = 0
  let manifestEntry: FileEntry | undefined
  const names = new Set<string>()
  for (const entry of zipEntries) {
    const path = archivePath(entry.filename)
    if (entry.directory) continue
    if (names.has(path)) throw new Error(`El ZIP repite la ruta ${path}.`)
    names.add(path)
    total += entrySize(entry)
    if (total > MAX_IMAGE_EXTRACTED_BYTES) throw new Error('El contenido extraído supera 250 MB.')
    if (entries.has(path)) throw new Error(`El ZIP repite la ruta ${path}.`)
    if (path.split('/').includes('__MACOSX') || path.split('/').at(-1)?.startsWith('._') || path.endsWith('/.DS_Store') || path === '.DS_Store') { ignored.push(path); continue }
    if (path.split('/').at(-1) === 'images-manifest.json') {
      if (manifestEntry) throw new Error('El ZIP contiene más de un manifiesto de imágenes.')
      manifestEntry = entry
      continue
    }
    if (!imageMimeType(path)) { ignored.push(path); continue }
    if (entrySize(entry) > MAX_ARCHIVE_IMAGE_BYTES) throw new Error(`La imagen ${path} supera 15 MB.`)
    entries.set(path, entry)
  }
  if (!entries.size) throw new Error('El ZIP no contiene imágenes JPEG, PNG o WebP.')
  let manifest: ImageManifest | null = null
  if (manifestEntry) {
    try {
      manifest = manifestSchema.parse(JSON.parse(new TextDecoder().decode(await checkedBytes(manifestEntry, MAX_MANIFEST_BYTES, signal))))
      const paths = manifest.products.map(product => archivePath(product.path))
      if (new Set(paths).size !== paths.length || new Set(manifest.products.map(product => product.productId)).size !== paths.length) throw new Error('duplicate')
      manifest.products = manifest.products.map((product, index) => ({ ...product, path: paths[index]! }))
    } catch { throw new Error('El manifiesto de imágenes no es válido. No se asignaron productos automáticamente.') }
  }
  const archive = { fingerprint: await imageDigest(buffer), fileName: file.name, files: [...entries.keys()].sort(), ignored, entries, manifest }
  // Validate CRC and image signatures before catalog metadata can be submitted.
  for (const path of archive.files) { signal?.throwIfAborted(); await archiveImageFile(archive, path, signal) }
  return archive
}

export function resolveArchiveImage(archive: ImageArchive, reference: string): string {
  const path = archivePath(reference)
  if (archive.entries.has(path)) return path
  const basename = path.split('/').at(-1)!
  const matches = archive.files.filter(candidate => candidate.split('/').at(-1) === basename)
  if (matches.length === 1) return matches[0]!
  if (matches.length > 1) throw new Error(`Hay varias imágenes llamadas ${basename}. Indicá la ruta completa dentro del ZIP.`)
  throw new Error(`No se encontró ${reference} dentro del ZIP.`)
}

// Mirrors the catalog's lower(btrim(code)); never coerce numeric identifiers.
export const normalizeImageSku = (code: string) => code.replace(/^ +| +$/g, '').toLowerCase()

export function matchArchiveProducts(archive: ImageArchive, products: ImageCatalogProduct[], restaurantId: string): Map<string, ImageMatch> {
  if (archive.manifest && archive.manifest.restaurantId !== restaurantId) throw new Error('Este ZIP fue exportado desde otro comercio. No se pueden usar sus identificadores en el comercio seleccionado.')
  const byId = new Map(products.map(product => [product.id, product]))
  const byCode = new Map<string, ImageCatalogProduct[]>()
  for (const product of products) {
    const code = normalizeImageSku(product.code)
    if (code) byCode.set(code, [...(byCode.get(code) ?? []), product])
  }
  const manifestEntries = archive.manifest?.products.map(product => [resolveArchiveImage(archive, product.path), product] as const) ?? []
  if (new Set(manifestEntries.map(([path]) => path)).size !== manifestEntries.length) throw new Error('El manifiesto asigna una misma imagen a varios productos. Revisá las rutas del ZIP.')
  const manifestByPath = new Map(manifestEntries)
  return new Map(archive.files.map(path => {
    const manifestProduct = manifestByPath.get(path)
    if (manifestProduct) {
      const owned = byId.get(manifestProduct.productId)
      return [path, owned && normalizeImageSku(owned.code) === normalizeImageSku(manifestProduct.sku)
        ? { productId: owned.id }
        : { productId: null, issue: 'El identificador y SKU del manifiesto no corresponden a un producto de este comercio.' }]
    }
    const stem = normalizeImageSku(path.split('/').at(-1)!.replace(/\.[^.]+$/, ''))
    const exact = byCode.get(stem) ?? []
    const candidates = exact.length ? exact : Array.from(stem.matchAll(/_/g)).flatMap(match => byCode.get(stem.slice(0, match.index)) ?? [])
    return [path, candidates.length === 1 ? { productId: candidates[0]!.id } : { productId: null, issue: candidates.length ? 'Hay varios SKU posibles. Elegí el producto.' : 'No encontramos un SKU coincidente. Elegí el producto o excluí la imagen.' }]
  }))
}
