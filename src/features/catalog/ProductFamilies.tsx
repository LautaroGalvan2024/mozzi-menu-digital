import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Layers, Plus, X } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Link } from 'react-router'
import { z } from 'zod'
import { parsePriceCents } from '../../lib/money'
import { supabase } from '../../lib/supabase/client'
import { useRestaurantScope } from '../restaurants/RestaurantScope'
import { catalogStockError, catalogStockSchema, isDefinitiveCatalogError, parseStockQuantity, type CatalogStockBalance } from './catalog-stock'

const familySchema = z.object({ id: z.string(), code: z.string(), category_id: z.string(), name: z.string(), description: z.string(), image_path: z.string().nullable(), axes: z.array(z.string()), active: z.boolean() })
const skuSchema = z.object({ id: z.string(), code: z.string(), name: z.string(), category_id: z.string(), family_id: z.string().nullable(), variant_attributes: z.record(z.string(), z.string()), image_path: z.string().nullable(), base_price_cents: z.union([z.number(), z.string()]) })
type Family = z.infer<typeof familySchema>
const storedQuantity = z.string().regex(/^\d+$/)
const variantDraftSchema = z.object({ productId: z.string(), attributes: z.record(z.string(), z.string()), isNew: z.boolean(), code: z.string(), price: z.string(), quantity: z.string(), initialQuantity: storedQuantity.nullable(), stockVersion: storedQuantity.nullable(), reserved: storedQuantity })
const familyDraftSchema = z.object({ id: z.string(), code: z.string(), name: z.string(), description: z.string(), categoryId: z.string(), imagePath: z.string(), axesText: z.string(), active: z.boolean(), variants: z.array(variantDraftSchema) })
const attemptSchema = z.object({
  draft: familyDraftSchema,
  request: z.object({
    p_restaurant_id: z.string().uuid(), p_operation_id: z.string().uuid(),
    p_family: z.object({ id: z.string(), code: z.string(), name: z.string(), description: z.string(), categoryId: z.string(), imagePath: z.string().nullable(), axes: z.array(z.string()), active: z.boolean() }),
    p_variants: z.array(z.object({ productId: z.string(), attributes: z.record(z.string(), z.string()), product: z.object({ code: z.string(), description: z.string(), basePriceCents: z.number().int(), active: z.boolean(), available: z.boolean() }).optional() })),
    p_stock_rows: z.array(z.object({ productId: z.string(), onHand: z.string().regex(/^\d{1,13}$/), expectedVersion: storedQuantity.nullable() })),
  }),
})
type VariantDraft = z.infer<typeof variantDraftSchema>
type FamilyDraft = z.infer<typeof familyDraftSchema>
type FamilyAttempt = z.infer<typeof attemptSchema>
const attemptKey = (restaurantId: string) => `mozzi:family-save:${restaurantId}`

function stockDraft(balance?: CatalogStockBalance) {
  return { quantity: balance?.onHand ?? '', initialQuantity: balance?.onHand ?? null, stockVersion: balance?.version ?? null, reserved: balance?.reserved ?? '0' }
}

export function ProductFamilies() {
  const scope = useRestaurantScope()
  const client = useQueryClient()
  const restaurantId = scope.selected?.id
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<FamilyDraft | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [attempt, setAttempt] = useState<FamilyAttempt | null>(null)
  const [stockNeedsReview, setStockNeedsReview] = useState(false)
  const savingRef = useRef(false)
  const dialogRef = useRef<HTMLElement>(null)
  const dialogOpen = Boolean(draft)
  useEffect(() => {
    if (!dialogOpen || !dialogRef.current) return
    const dialog = dialogRef.current
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialog.querySelector<HTMLButtonElement>('button')?.focus()
    return () => { if (previous?.isConnected) previous.focus() }
  }, [dialogOpen])
  function onDialogKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
      if (event.key === 'Escape' && !savingRef.current) { event.preventDefault(); setDraft(null); return }
      if (event.key !== 'Tab') return
      const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], summary')].filter(element => {
        const closed = element.closest('details:not([open])')
        return !closed || closed.querySelector('summary')?.contains(element)
      }).sort((a, b) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)
      const first = controls[0]; const last = controls.at(-1)
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }
  useEffect(() => {
    setDraft(null); setAttempt(null); setError(null); setMessage(null); setStockNeedsReview(false)
    if (!restaurantId) return
    try {
      const stored = attemptSchema.safeParse(JSON.parse(localStorage.getItem(attemptKey(restaurantId)) ?? 'null'))
      if (stored.success && stored.data.request.p_restaurant_id === restaurantId) {
        setAttempt(stored.data); setDraft(stored.data.draft); setOpen(true)
        setError('Hay un guardado pendiente de confirmar. Reintentá el mismo envío para recuperar su resultado.')
      }
    } catch { /* A malformed or unavailable local draft never becomes a stock operation. */ }
  }, [restaurantId])
  const catalog = useQuery({
    queryKey: ['product-families', restaurantId], enabled: Boolean(restaurantId && open),
    queryFn: async () => {
      const [families, products, categories] = await Promise.all([
        supabase.from('product_families').select('id,code,category_id,name,description,image_path,axes,active').eq('restaurant_id', restaurantId!).order('name'),
        supabase.from('products').select('id,code,name,category_id,family_id,variant_attributes,image_path,base_price_cents').eq('restaurant_id', restaurantId!).is('deleted_at', null).order('name').limit(5000),
        supabase.from('categories').select('id,name').eq('restaurant_id', restaurantId!).is('deleted_at', null).eq('active', true).order('sort_order'),
      ])
      if (families.error || products.error || categories.error) throw new Error('No se pudieron cargar las variantes.')
      const parsedProducts = z.array(skuSchema).parse(products.data)
      const stockResult = await supabase.rpc('get_catalog_stock', { p_restaurant_id: restaurantId!, p_product_ids: parsedProducts.map(product => product.id) })
      if (stockResult.error) throw new Error(catalogStockError(stockResult.error))
      const stock = catalogStockSchema.parse(stockResult.data)
      if (parsedProducts.some(product => !stock.items.some(item => item.productId === product.id))) throw new Error('Falta información de stock. Actualizá las variantes antes de editar.')
      return { families: z.array(familySchema).parse(families.data), products: parsedProducts, categories: z.array(z.object({ id: z.string(), name: z.string() })).parse(categories.data), stock }
    },
  })
  const axes = draft?.axesText.split(',').map((axis) => axis.trim()).filter(Boolean) ?? []
  const stockLocked = Boolean(catalog.data?.stock.policy.mode === 'paused' || catalog.data?.stock.policy.cutoverId || stockNeedsReview)
  const balanceFor = (productId: string) => catalog.data?.stock.items.find(item => item.productId === productId)
  function edit(family?: Family) {
    if (attempt) { setDraft(attempt.draft); return }
    setError(null); setMessage(null)
    setStockNeedsReview(false)
    setDraft({ id: family?.id ?? crypto.randomUUID(), code: family?.code ?? '', name: family?.name ?? '', description: family?.description ?? '', categoryId: family?.category_id ?? catalog.data?.categories[0]?.id ?? '', imagePath: family?.image_path ?? '', axesText: family?.axes.join(', ') ?? 'Modelo, Color', active: family?.active ?? true, variants: family ? (catalog.data?.products.filter((p) => p.family_id === family.id) ?? []).map((p) => ({ productId: p.id, attributes: p.variant_attributes, isNew: false, code: p.code, price: String(Number(p.base_price_cents) / 100), ...stockDraft(balanceFor(p.id)) })) : [] })
  }
  function change<K extends keyof FamilyDraft>(key: K, value: FamilyDraft[K]) { setDraft((current) => current ? { ...current, [key]: value } : current) }
  function changeVariant(index: number, value: Partial<VariantDraft>) { if (draft) change('variants', draft.variants.map((row, i) => i === index ? { ...row, ...value } : row)) }
  async function reviewStock() {
    setError(null)
    try {
      const refreshed = await catalog.refetch({ throwOnError: true })
      if (!refreshed.data) throw new Error('No se pudo actualizar el stock.')
      const balances = refreshed.data.stock.items
      setDraft(current => current ? { ...current, variants: current.variants.map(row => ({ ...row, ...stockDraft(balances.find(item => item.productId === row.productId)), quantity: '' })) } : current)
      setStockNeedsReview(false)
      setError('Stock actualizado. Revisá las reservas e ingresá nuevamente sólo las cantidades que querés cambiar. Los campos vacíos conservan el stock.')
    } catch { setError('No se pudo actualizar el stock. Reintentá antes de guardar.') }
  }
  async function save() {
    if (!draft || !restaurantId || savingRef.current || stockNeedsReview) return
    if (attempt && attempt.request.p_restaurant_id !== restaurantId) return
    setError(null)
    if (!draft.name.trim() || !draft.categoryId || axes.length < 1 || axes.length > 3 || new Set(axes.map((a) => a.toLocaleLowerCase('es'))).size !== axes.length || axes.some((a) => a.length > 40)) {
      setError('Completá nombre, categoría y entre uno y tres atributos diferentes, separados por comas.'); return
    }
    const combinations = new Set<string>()
    for (const row of draft.variants) {
      const attributes = axes.map((axis) => row.attributes[axis]?.trim() ?? '')
      const key = JSON.stringify(attributes)
      if (!row.productId || attributes.some((value) => !value || value.length > 80) || combinations.has(key) || (row.isNew && parsePriceCents(row.price) === null)) {
        setError('Cada variante necesita un producto, un valor por atributo, una combinación única y un precio válido.'); return
      }
      combinations.add(key)
    }
    if (!draft.variants.length) { setError('Agregá al menos una variante.'); return }
    let submission = attempt
    if (!submission) {
      try {
        const stockRows = draft.variants.flatMap(row => {
          if (row.quantity.trim() === row.initialQuantity) return []
          const quantity = parseStockQuantity(row.quantity)
          if (quantity === null || quantity === row.initialQuantity) return []
          if (BigInt(quantity) < BigInt(row.reserved)) throw new Error('La cantidad en stock no puede ser menor que las unidades reservadas.')
          return [{ productId: row.productId, onHand: quantity, expectedVersion: row.stockVersion }]
        })
        if (stockRows.length && stockLocked) throw new Error('El stock está pausado o tiene un conteo en curso. Podés guardar los otros datos dejando vacía la cantidad.')
        submission = { draft, request: {
          p_restaurant_id: restaurantId, p_operation_id: crypto.randomUUID(),
          p_family: { id: draft.id, code: draft.code.trim(), name: draft.name.trim(), description: draft.description.trim(), categoryId: draft.categoryId, imagePath: draft.imagePath || null, axes, active: draft.active },
          p_variants: draft.variants.map(row => ({ productId: row.productId, attributes: Object.fromEntries(axes.map(axis => [axis, row.attributes[axis]!.trim()])), ...(row.isNew ? { product: { code: row.code.trim(), description: draft.description.trim(), basePriceCents: parsePriceCents(row.price)!, active: true, available: true } } : {}) })),
          p_stock_rows: stockRows,
        } }
        localStorage.setItem(attemptKey(restaurantId), JSON.stringify(submission))
        setAttempt(submission)
      } catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo preparar el guardado.'); return }
    }
    savingRef.current = true
    setSaving(true)
    try {
      const { error: saveError } = await supabase.rpc('save_product_family_with_stock', submission.request)
      if (saveError) throw saveError
      localStorage.removeItem(attemptKey(restaurantId)); setAttempt(null)
      setDraft(null); setMessage(submission.request.p_stock_rows.length ? 'Ficha y cantidades de stock guardadas.' : 'Ficha guardada. Se conservaron las cantidades de stock.')
      await Promise.all([client.invalidateQueries({ queryKey: ['product-families', restaurantId] }), client.invalidateQueries({ queryKey: ['products', restaurantId] }), client.invalidateQueries({ queryKey: ['inventory', restaurantId] }), client.invalidateQueries({ queryKey: ['catalog-stock', restaurantId] }), client.invalidateQueries({ queryKey: ['public-menu'] }), client.invalidateQueries({ queryKey: ['public-catalog'] })])
    } catch (failure) {
      if (isDefinitiveCatalogError(failure)) {
        localStorage.removeItem(attemptKey(restaurantId)); setAttempt(null)
        const problem = z.object({ message: z.string().default(''), code: z.string().optional() }).parse(failure)
        if (['INVENTORY_VERSION_CONFLICT', 'INSUFFICIENT_STOCK', 'INVENTORY_PAUSED', 'INVENTORY_CUTOVER'].includes(problem.message)) setStockNeedsReview(true)
        setError(problem.message.includes('DUPLICATE') || problem.code === '23505' ? 'Ya existe ese código o combinación. Revisá las variantes.' : catalogStockError(failure))
      } else setError('No pudimos confirmar el guardado. Reintentá el mismo envío; no volverá a cargar las cantidades ni duplicará productos.')
    } finally { savingRef.current = false; setSaving(false) }
  }
  return <section className="mb-4 rounded-xl border border-stone-200 bg-white px-4 py-3">
    <button type="button" className="flex min-h-8 w-full items-center justify-between gap-3 text-left text-sm font-medium" onClick={() => setOpen((value) => !value)} aria-expanded={open}><span className="flex items-center gap-2 text-stone-700"><Layers className="h-4 w-4 text-stone-400" aria-hidden />Productos con variantes</span><span className="text-xs text-stone-500">{open ? 'Cerrar' : 'Administrar'}</span></button>
    {open && <div className="mt-4 space-y-3">
      <p className="text-sm text-stone-500">Agrupá modelos, colores o talles. Cada combinación tiene su precio y stock.</p>
      {catalog.isLoading ? <p role="status">Cargando variantes…</p> : null}
      {catalog.error ? <p className="form-error" role="alert">{catalog.error.message}</p> : null}
      {catalog.data ? <><div className="flex flex-wrap gap-2">{catalog.data.families.map((family) => <button key={family.id} type="button" className="button-secondary" onClick={() => edit(family)}>{family.name}{!family.active ? ' · Oculta' : ''}</button>)}</div><button type="button" className="button-secondary" disabled={!catalog.data.categories.length} onClick={() => edit()}><Plus className="h-4 w-4" aria-hidden />Nueva ficha con variantes</button></> : null}
      {message ? <p className="form-success" role="status">{message}</p> : null}
      {attempt && !draft ? <button type="button" className="button-primary" onClick={() => setDraft(attempt.draft)}>Recuperar guardado pendiente</button> : null}
    </div>}
    {draft ? <div className="modal-backdrop"><section ref={dialogRef} onKeyDown={onDialogKeyDown} className="modal-card max-w-3xl" role="dialog" aria-modal="true" aria-labelledby="family-title">
      <div className="flex items-center justify-between"><h2 id="family-title" className="text-xl font-semibold">Ficha con variantes</h2><button type="button" className="icon-button" aria-label="Cerrar ficha" disabled={saving} onClick={() => setDraft(null)}><X /></button></div>
      {attempt ? <p className="mt-4 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">Este envío está pendiente de confirmar. Conservamos sus datos para que puedas reintentarlo sin volver a aplicar el stock.</p> : null}
      <fieldset disabled={saving || Boolean(attempt)} className="mt-5 space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="field"><span>Nombre de la ficha</span><input maxLength={120} value={draft.name} onChange={(e) => change('name', e.target.value)} placeholder="Funda de silicona" /></label>
          <label className="field"><span>Categoría de todas las variantes</span><select value={draft.categoryId} onChange={(e) => change('categoryId', e.target.value)}>{catalog.data?.categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
          <label className="field sm:col-span-2"><span>Atributos, separados por comas</span><input value={draft.axesText} onChange={(e) => change('axesText', e.target.value)} placeholder="Modelo, Color" /><p className="text-xs font-normal text-stone-500">Por ejemplo: Modelo, Color o Talle. Después completás los valores de cada variante.</p></label>
        </div>
        <details className="admin-disclosure" open={Boolean(error && error.includes('código')) || undefined}>
          <summary>Descripción y presentación</summary>
          <div className="grid gap-4 sm:grid-cols-2">
          <label className="field"><span>Código de familia (opcional)</span><input maxLength={80} value={draft.code} onChange={(e) => change('code', e.target.value)} placeholder="FUNDAS-SILICONA" /></label>
          <label className="field sm:col-span-2"><span>Descripción de la ficha</span><textarea maxLength={2000} rows={2} value={draft.description} onChange={(e) => change('description', e.target.value)} /></label>
          <label className="field"><span>Foto de portada</span><select value={draft.imagePath} onChange={(e) => change('imagePath', e.target.value)}><option value="">Usar la foto de una variante</option>{catalog.data?.products.filter((p) => p.image_path && draft.variants.some((v) => v.productId === p.id)).map((p) => <option key={p.id} value={p.image_path!}>{p.name}</option>)}</select></label>
          <label className="check-field"><input type="checkbox" checked={draft.active} onChange={(e) => change('active', e.target.checked)} />Ficha visible</label>
          </div>
        </details>
        <div className="border-t border-stone-100 pt-4"><h3 className="font-semibold text-stone-900">Variantes</h3><p className="mt-1 text-xs text-stone-500">El stock es la cantidad total, incluidas las reservas. Vacío conserva el saldo.</p></div>
        {catalog.data?.stock.policy.mode === 'never_enabled' ? <p className="rounded-xl bg-stone-50 p-3 text-sm text-stone-600">Podés cargar las cantidades ahora. El control de stock todavía no está activo.</p> : null}
        {stockLocked && !stockNeedsReview ? <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">El stock está pausado o tiene una actualización en curso. Podés editar los otros datos de la ficha.</p> : null}
        {draft.variants.map((row, index) => <div key={`${row.isNew ? row.productId : index}`} className="rounded-xl border border-stone-200 p-3">
          <div className="flex items-end gap-2">
            {row.isNew ? <div className="grid flex-1 gap-3 sm:grid-cols-2"><label className="field"><span>Nuevo código / SKU (opcional)</span><input value={row.code} maxLength={80} onChange={(e) => changeVariant(index, { code: e.target.value })} /></label><label className="field"><span>Precio de la variante</span><input value={row.price} type="number" min="0" step="0.01" onChange={(e) => changeVariant(index, { price: e.target.value })} /></label></div> : <label className="field flex-1"><span>Producto existente</span><select value={row.productId} onChange={(e) => changeVariant(index, { productId: e.target.value, ...stockDraft(balanceFor(e.target.value)) })}><option value="">Elegí un producto</option>{catalog.data?.products.filter((p) => (!p.family_id || p.family_id === draft.id) && !draft.variants.some((v, i) => i !== index && v.productId === p.id)).map((p) => <option key={p.id} value={p.id}>{p.name} · {p.code}</option>)}</select></label>}
            <button type="button" className="icon-button" aria-label={`Quitar variante ${index + 1}`} onClick={() => change('variants', draft.variants.filter((_, i) => i !== index))}><X className="h-4 w-4" /></button>
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">{axes.map((axis) => <label key={axis} className="field"><span>{axis}</span><input maxLength={80} value={row.attributes[axis] ?? ''} onChange={(e) => changeVariant(index, { attributes: { ...row.attributes, [axis]: e.target.value } })} /></label>)}</div>
          <div className="mt-3 grid items-end gap-3 sm:grid-cols-2">
            <label className="field"><span>Cantidad en stock</span><input type="text" inputMode="numeric" value={row.quantity} disabled={stockLocked || !row.productId} aria-describedby={`variant-stock-${index}`} placeholder="Ej. 10" onChange={e => changeVariant(index, { quantity: e.target.value })} /></label>
            <p id={`variant-stock-${index}`} className="text-sm text-stone-600">{row.initialQuantity === null ? 'Sin cantidad cargada.' : `Stock actual: ${row.initialQuantity}.`} Reservadas: {row.reserved}.{row.initialQuantity !== null ? ` Disponibles: ${BigInt(row.initialQuantity) - BigInt(row.reserved)}.` : ''}</p>
          </div>
          {!row.isNew && row.productId ? <Link className="mt-2 inline-block text-sm font-semibold text-orange-700 underline" to={`/admin/catalogo/productos/${row.productId}`}>Editar precio, foto y extras de este producto</Link> : null}
        </div>)}
        <div className="flex flex-wrap gap-2"><button type="button" className="button-secondary" onClick={() => change('variants', [...draft.variants, { productId: '', attributes: {}, isNew: false, code: '', price: '0', ...stockDraft() }])}>Agrupar producto existente</button><button type="button" className="button-secondary" onClick={() => change('variants', [...draft.variants, { productId: crypto.randomUUID(), attributes: {}, isNew: true, code: '', price: '0', ...stockDraft() }])}>Crear nueva variante</button></div>
        <p className="text-sm text-stone-500">Quitar una variante de esta ficha la deja como producto independiente y conserva su stock.</p>
      </fieldset>
      {error ? <p role="alert" className="form-error mt-4">{error}</p> : null}
      {stockNeedsReview ? <button type="button" className="button-secondary mt-3" disabled={catalog.isFetching} onClick={() => void reviewStock()}>Actualizar stock de variantes</button> : null}
      <div className="mt-5 flex justify-end gap-2"><button type="button" className="button-secondary" disabled={saving} onClick={() => setDraft(null)}>{attempt ? 'Cerrar' : 'Cancelar'}</button><button type="button" className="button-primary" disabled={saving || stockNeedsReview} onClick={() => void save()}>{saving ? 'Guardando…' : attempt ? 'Reintentar guardado' : 'Guardar ficha y variantes'}</button></div>
    </section></div> : null}
  </section>
}
