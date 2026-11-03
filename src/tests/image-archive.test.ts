import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { archiveImageFile, archivePath, matchArchiveProducts, readImageArchive, resolveArchiveImage, MAX_IMAGE_ZIP_BYTES, type ImageCatalogProduct } from '../lib/images/image-archive'

const tenant = '10000000-0000-4000-8000-000000000001'
const otherTenant = '10000000-0000-4000-8000-000000000002'
const products: ImageCatalogProduct[] = [
  { id: '20000000-0000-4000-8000-000000000001', code: '000123', name: 'Yerba', image_path: null },
  { id: '20000000-0000-4000-8000-000000000002', code: 'AB', name: 'Arroz', image_path: null },
  { id: '20000000-0000-4000-8000-000000000003', code: 'AB_CD', name: 'Azúcar', image_path: null },
]
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0])
async function archive(entries: Record<string, Uint8Array | string>, options: { manifest?: unknown } = {}) {
  const zip = new JSZip()
  for (const [name, bytes] of Object.entries(entries)) zip.file(name, bytes)
  if (options.manifest) zip.file('images-manifest.json', JSON.stringify(options.manifest))
  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
  return readImageArchive(new File([Uint8Array.from(bytes).buffer], 'imagenes.zip'))
}

describe('image ZIP inspection and matching', () => {
  it('reads images in folders, validates CRC, ignores metadata, and resolves a unique basename', async () => {
    const result = await archive({ 'export/photos/000123_yerba.png': png, '__MACOSX/._photo.png': png, 'readme.txt': 'text' })
    expect(result.files).toEqual(['export/photos/000123_yerba.png'])
    expect(result.ignored).toHaveLength(2)
    expect(result.fingerprint).toHaveLength(64)
    expect(resolveArchiveImage(result, '000123_yerba.png')).toBe(result.files[0])
    expect(resolveArchiveImage(result, 'export\\photos\\000123_yerba.png')).toBe(result.files[0])
    expect((await archiveImageFile(result, result.files[0]!)).type).toBe('image/png')
    expect(matchArchiveProducts(result, products, tenant).get(result.files[0]!)?.productId).toBe(products[0]!.id)
  })
  it('requires a full path for duplicate basenames and never guesses from a product name', async () => {
    const result = await archive({ 'a/000123.png': png, 'b/000123.png': png, 'Yerba.png': png })
    expect(() => resolveArchiveImage(result, '000123.png')).toThrow(/varias imágenes/)
    expect(resolveArchiveImage(result, 'a/000123.png')).toBe('a/000123.png')
    expect(matchArchiveProducts(result, products, tenant).get('Yerba.png')?.productId).toBeNull()
  })
  it('matches exact SKU before unique prefixes, preserving zeros and rejecting ambiguous prefixes', async () => {
    const result = await archive({ '000123.png': png, '123.png': png, 'ab_cd.png': png, 'ab_cd_foto.png': png })
    const matches = matchArchiveProducts(result, products, tenant)
    expect(matches.get('000123.png')?.productId).toBe(products[0]!.id)
    expect(matches.get('123.png')?.productId).toBeNull()
    expect(matches.get('ab_cd.png')?.productId).toBe(products[2]!.id)
    expect(matches.get('ab_cd_foto.png')).toMatchObject({ productId: null, issue: expect.stringMatching(/varios SKU/) })
  })
  it('accepts only manifest IDs and SKU belonging to the selected tenant', async () => {
    const entries = { 'photo.png': png }
    const manifest = { version: 1, restaurantId: tenant, products: [{ productId: products[0]!.id, sku: '000123', path: 'photo.png' }] }
    const result = await archive(entries, { manifest })
    expect(matchArchiveProducts(result, products, tenant).get('photo.png')?.productId).toBe(products[0]!.id)
    expect(() => matchArchiveProducts(result, products, otherTenant)).toThrow(/otro comercio/)
    const foreignId = await archive({ '000123.png': png }, { manifest: { ...manifest, products: [{ productId: '20000000-0000-4000-8000-000000000099', sku: '000123', path: '000123.png' }] } })
    expect(matchArchiveProducts(foreignId, products, tenant).get('000123.png')?.productId).toBeNull()
  })
  it('rejects traversal before accepting the archive and rejects dangerous paths', async () => {
    await expect(archive({ '../000123.png': png })).rejects.toThrow(/ruta|ZIP válido/)
    for (const path of ['/photo.png', 'C:\\photo.png', 'a/../photo.png', 'a\u0000.png']) expect(() => archivePath(path)).toThrow(/ruta/)
  })
  it('rejects invalid, empty, oversized and disguised image archives before writes', async () => {
    await expect(readImageArchive(new File(['no zip'], 'bad.zip'))).rejects.toThrow(/abrir el ZIP/)
    await expect(archive({ 'a.png': 'not an image' })).rejects.toThrow(/no coincide/)
    await expect(archive({ 'a.svg': '<svg/>' })).rejects.toThrow(/no contiene imágenes/)
    const tooLarge = new File(['x'], 'large.zip')
    Object.defineProperty(tooLarge, 'size', { value: MAX_IMAGE_ZIP_BYTES + 1 })
    await expect(readImageArchive(tooLarge)).rejects.toThrow(/100 MB/)
    await expect(archive({ 'a.png': new Uint8Array(16 * 1024 * 1024) })).rejects.toThrow(/15 MB/)
  })
  it('detects corrupted CRC instead of accepting an otherwise valid PNG signature', async () => {
    const zip = new JSZip(); zip.file('image.png', png)
    const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'STORE' })
    const offset = 30 + 'image.png'.length
    bytes[offset + 10] = 1
    await expect(readImageArchive(new File([Uint8Array.from(bytes).buffer], 'corrupt.zip'))).rejects.toThrow(/dañado/)
  })
  it('rejects duplicate raw central-directory names before an entry can overwrite another', async () => {
    const zip = new JSZip().file('a.png', png).file('b.png', png)
    const bytes = await zip.generateAsync({ type: 'uint8array' })
    const name = new TextEncoder().encode('b.png')
    for (let index = 0; index <= bytes.length - name.length; index++) {
      if (name.every((value, offset) => bytes[index + offset] === value)) bytes[index] = 'a'.charCodeAt(0)
    }
    await expect(readImageArchive(new File([Uint8Array.from(bytes).buffer], 'duplicate.zip'))).rejects.toThrow(/repite la ruta/)
  })
  it('bounds actual decompression when declared uncompressed sizes are forged', async () => {
    const image = new Uint8Array(16 * 1024 * 1024); image.set(png)
    const zip = new JSZip().file('image.png', image)
    const bytes = Uint8Array.from(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }))
    const view = new DataView(bytes.buffer)
    view.setUint32(22, png.length, true)
    for (let index = 0; index < bytes.length - 46; index++) {
      if (view.getUint32(index, true) === 0x02014b50) { view.setUint32(index + 24, png.length, true); break }
    }
    await expect(readImageArchive(new File([bytes.buffer], 'forged.zip'))).rejects.toThrow(/límite de extracción|dañado/)
  })
  it('rejects two manifest aliases resolving to the same entry', async () => {
    const result = await archive({ 'carpeta/foto.png': png }, { manifest: { version: 1, restaurantId: tenant, products: [
      { productId: products[0]!.id, sku: products[0]!.code, path: 'foto.png' },
      { productId: products[1]!.id, sku: products[1]!.code, path: 'carpeta/foto.png' },
    ] } })
    expect(() => matchArchiveProducts(result, products, tenant)).toThrow(/misma imagen/)
  })
})
