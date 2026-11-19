import { z } from 'zod'
import type { ImportPreviewRow } from './import-mapping'
import type { ImportData } from './import-products'
import type { ImportMode } from './import-session'
import { supabase } from './supabase/client'

const catalogProductSchema = z.object({
  id: z.string().uuid(),
  restaurant_id: z.string().uuid(),
  code: z.string(),
  deleted_at: z.string().nullable(),
})
export type ImportCatalogProduct = z.infer<typeof catalogProductSchema>
export type ImportReviewAction = 'create' | 'update' | 'skip' | 'review'
export interface ImportReviewRow { rowRef: string; sourceRow: number | null; action: ImportReviewAction; issues: string[] }
export interface ImportReview { rows: ImportReviewRow[]; counts: Record<ImportReviewAction, number> }

// Same identity rule as the catalog: trim spaces and ignore case, never convert
// codes to numbers or use a product's name to infer an update.
export const normalizeImportSku = (code: string) => code.replace(/^ +| +$/g, '').toLowerCase()

export async function loadImportCatalog(restaurantId: string, signal?: AbortSignal): Promise<ImportCatalogProduct[]> {
  const products: ImportCatalogProduct[] = []
  let after: string | undefined
  while (true) {
    signal?.throwIfAborted()
    // Include archived codes: they remain reserved and must not be reported as new.
    let query = supabase.from('products').select('id,restaurant_id,code,deleted_at')
      .eq('restaurant_id', restaurantId).order('id').limit(500)
    if (after) query = query.gt('id', after)
    if (signal) query = query.abortSignal(signal)
    const { data, error } = await query
    if (error) throw new Error('No pudimos comprobar los códigos del comercio. Volvé a intentar.')
    const page = z.array(catalogProductSchema).safeParse(data)
    if (!page.success || page.data.some(product => product.restaurant_id !== restaurantId)) {
      throw new Error('No pudimos verificar el catálogo de este comercio. Volvé a intentar.')
    }
    if (!page.data.length) return products
    for (const product of page.data) {
      if (after && product.id <= after) throw new Error('El catálogo cambió durante la comprobación. Volvé a intentar.')
      after = product.id
      products.push(product)
    }
  }
}

export function buildImportReview(data: ImportData, mode: ImportMode, catalog: ImportCatalogProduct[], sourceRows?: ImportPreviewRow[]): ImportReview {
  const byId = new Map(catalog.map(product => [product.id.toLowerCase(), product]))
  const byCode = new Map<string, ImportCatalogProduct[]>()
  for (const product of catalog) {
    const code = normalizeImportSku(product.code)
    byCode.set(code, [...(byCode.get(code) ?? []), product])
  }
  const rows: ImportReviewRow[] = []
  const identities = new Map<string, ImportReviewRow[]>()
  const invalidSources = sourceRows?.filter(row => row.kind === 'invalid') ?? []
  for (const source of invalidSources) rows.push({ rowRef: source.values.fila || String(source.sourceRow), sourceRow: source.sourceRow, action: 'review', issues: source.issues })
  const invalidRefs = new Set(rows.map(row => row.rowRef))
  for (const product of data.products) {
    if (invalidRefs.has(product.rowRef)) continue
    const source = sourceRows?.find(row => row.kind === 'product' && (row.values.fila || String(row.sourceRow)) === product.rowRef)
    const row: ImportReviewRow = { rowRef: product.rowRef, sourceRow: source?.sourceRow ?? null, action: 'create', issues: [] }
    const code = product.code ? normalizeImportSku(product.code) : null
    const candidates = code ? byCode.get(code) ?? [] : []
    const active = candidates.filter(candidate => !candidate.deleted_at)
    const existing = product.id ? byId.get(product.id.toLowerCase()) : active.length === 1 ? active[0] : undefined
    if (product.id && (!existing || existing.deleted_at)) row.issues.push('El ID no corresponde a un producto disponible en este comercio. Revisá el archivo de origen.')
    else if (product.id && code && existing && normalizeImportSku(existing.code) !== code) row.issues.push('El código / SKU y el ID corresponden a productos diferentes. Corregí la identidad antes de importar.')
    else if (!product.id && active.length > 1) row.issues.push('El código / SKU coincide con más de un producto. Revisá el catálogo antes de importar.')
    else if (!existing && candidates.length) row.issues.push('Este código pertenece a un producto archivado y no se puede usar para crear otro.')

    if (!row.issues.length) {
      if (existing && mode === 'create_only') row.issues.push('El producto ya existe. Elegí crear o actualizar, omitir existentes o excluí esta fila.')
      else if (!existing && mode === 'update_only') row.issues.push('No encontramos un producto para actualizar con este código o ID. Revisalo o cambiá el modo de importación.')
      else row.action = existing ? mode === 'skip_existing' ? 'skip' : 'update' : 'create'
    }
    const identity = existing ? `id:${existing.id.toLowerCase()}` : code ? `code:${code}` : null
    if (identity) identities.set(identity, [...(identities.get(identity) ?? []), row])
    if (row.issues.length) row.action = 'review'
    rows.push(row)
  }
  for (const duplicates of identities.values()) {
    if (duplicates.length < 2) continue
    for (const row of duplicates) {
      row.action = 'review'
      row.issues.push('Más de una fila del archivo corresponde al mismo producto. Conservá una sola fila.')
    }
  }
  const counts = { create: 0, update: 0, skip: 0, review: 0 }
  for (const row of rows) counts[row.action] += 1
  return { rows, counts }
}
