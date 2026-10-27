import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Layers, Plus, X } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { z } from 'zod'
import { parsePriceCents } from '../../lib/money'
import { supabase } from '../../lib/supabase/client'
import { useRestaurantScope } from '../restaurants/RestaurantScope'

const familySchema = z.object({ id: z.string(), code: z.string(), category_id: z.string(), name: z.string(), description: z.string(), image_path: z.string().nullable(), axes: z.array(z.string()), active: z.boolean() })
const skuSchema = z.object({ id: z.string(), code: z.string(), name: z.string(), category_id: z.string(), family_id: z.string().nullable(), variant_attributes: z.record(z.string(), z.string()), image_path: z.string().nullable(), base_price_cents: z.union([z.number(), z.string()]) })
type Family = z.infer<typeof familySchema>
interface VariantDraft { productId: string; attributes: Record<string, string>; isNew: boolean; code: string; price: string }
interface FamilyDraft { id: string; code: string; name: string; description: string; categoryId: string; imagePath: string; axesText: string; active: boolean; variants: VariantDraft[] }

export function ProductFamilies() {
  const scope = useRestaurantScope()
  const client = useQueryClient()
  const restaurantId = scope.selected?.id
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<FamilyDraft | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const catalog = useQuery({
    queryKey: ['product-families', restaurantId], enabled: Boolean(restaurantId && open),
    queryFn: async () => {
      const [families, products, categories] = await Promise.all([
        supabase.from('product_families').select('id,code,category_id,name,description,image_path,axes,active').eq('restaurant_id', restaurantId!).order('name'),
        supabase.from('products').select('id,code,name,category_id,family_id,variant_attributes,image_path,base_price_cents').eq('restaurant_id', restaurantId!).is('deleted_at', null).order('name').limit(5000),
        supabase.from('categories').select('id,name').eq('restaurant_id', restaurantId!).is('deleted_at', null).eq('active', true).order('sort_order'),
      ])
      if (families.error || products.error || categories.error) throw new Error('No se pudieron cargar las variantes.')
      return { families: z.array(familySchema).parse(families.data), products: z.array(skuSchema).parse(products.data), categories: z.array(z.object({ id: z.string(), name: z.string() })).parse(categories.data) }
    },
  })
  const axes = draft?.axesText.split(',').map((axis) => axis.trim()).filter(Boolean) ?? []
  function edit(family?: Family) {
    setError(null); setMessage(null)
    setDraft({ id: family?.id ?? crypto.randomUUID(), code: family?.code ?? '', name: family?.name ?? '', description: family?.description ?? '', categoryId: family?.category_id ?? catalog.data?.categories[0]?.id ?? '', imagePath: family?.image_path ?? '', axesText: family?.axes.join(', ') ?? 'Modelo, Color', active: family?.active ?? true, variants: family ? (catalog.data?.products.filter((p) => p.family_id === family.id) ?? []).map((p) => ({ productId: p.id, attributes: p.variant_attributes, isNew: false, code: p.code, price: String(Number(p.base_price_cents) / 100) })) : [] })
  }
  function change<K extends keyof FamilyDraft>(key: K, value: FamilyDraft[K]) { setDraft((current) => current ? { ...current, [key]: value } : current) }
  function changeVariant(index: number, value: Partial<VariantDraft>) { if (draft) change('variants', draft.variants.map((row, i) => i === index ? { ...row, ...value } : row)) }
  async function save() {
    if (!draft || !restaurantId || saving) return
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
    setSaving(true)
    try {
      const { error: saveError } = await supabase.rpc('save_product_family', {
        p_restaurant_id: restaurantId,
        p_family: { id: draft.id, code: draft.code.trim(), name: draft.name.trim(), description: draft.description.trim(), categoryId: draft.categoryId, imagePath: draft.imagePath || null, axes, active: draft.active },
        p_variants: draft.variants.map((row) => ({ productId: row.productId, attributes: Object.fromEntries(axes.map((axis) => [axis, row.attributes[axis]!.trim()])), ...(row.isNew ? { product: { code: row.code.trim(), description: draft.description.trim(), basePriceCents: parsePriceCents(row.price), active: true, available: true } } : {}) })),
      })
      if (saveError) throw new Error(saveError.message.includes('DUPLICATE') || saveError.code === '23505' ? 'Ya existe ese código o combinación. Revisá las variantes.' : 'No se pudo guardar. Revisá los atributos y que los productos pertenezcan a este comercio.')
      setDraft(null); setMessage('Ficha guardada. Cada variante conserva su stock y se muestra en el menú y la tienda.')
      await Promise.all([client.invalidateQueries({ queryKey: ['product-families', restaurantId] }), client.invalidateQueries({ queryKey: ['products', restaurantId] }), client.invalidateQueries({ queryKey: ['public-menu'] }), client.invalidateQueries({ queryKey: ['public-catalog'] })])
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo guardar la ficha.') } finally { setSaving(false) }
  }
  return <section className="mb-5 rounded-2xl border border-stone-200 bg-white p-4">
    <button type="button" className="flex w-full items-center justify-between gap-3 text-left font-semibold" onClick={() => setOpen((value) => !value)} aria-expanded={open}><span className="flex items-center gap-2"><Layers className="h-5 w-5" aria-hidden />Productos con variantes</span><span className="text-sm text-orange-700">{open ? 'Cerrar' : 'Administrar'}</span></button>
    <p className="mt-2 text-sm text-stone-600">Agrupá modelos, colores o talles en una ficha. Cada variante tiene su código, precio, imagen y stock.</p>
    {open && <div className="mt-4 space-y-3">
      {catalog.isLoading ? <p role="status">Cargando variantes…</p> : null}
      {catalog.error ? <p className="form-error" role="alert">{catalog.error.message}</p> : null}
      {catalog.data ? <><div className="flex flex-wrap gap-2">{catalog.data.families.map((family) => <button key={family.id} type="button" className="button-secondary" onClick={() => edit(family)}>{family.name}{!family.active ? ' · Oculta' : ''}</button>)}</div><button type="button" className="button-secondary" disabled={!catalog.data.categories.length} onClick={() => edit()}><Plus className="h-4 w-4" aria-hidden />Nueva ficha con variantes</button></> : null}
      {message ? <p className="form-success" role="status">{message}</p> : null}
    </div>}
    {draft ? <div className="modal-backdrop"><section className="modal-card max-w-3xl" role="dialog" aria-modal="true" aria-labelledby="family-title">
      <div className="flex items-center justify-between"><h2 id="family-title" className="font-display text-2xl font-bold">Ficha con variantes</h2><button type="button" className="icon-button" aria-label="Cerrar ficha" disabled={saving} onClick={() => setDraft(null)}><X /></button></div>
      <fieldset disabled={saving} className="mt-5 space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="field"><span>Nombre de la ficha</span><input maxLength={120} value={draft.name} onChange={(e) => change('name', e.target.value)} placeholder="Funda de silicona" /></label>
          <label className="field"><span>Código de familia (opcional)</span><input maxLength={80} value={draft.code} onChange={(e) => change('code', e.target.value)} placeholder="FUNDAS-SILICONA" /></label>
          <label className="field"><span>Categoría de todas las variantes</span><select value={draft.categoryId} onChange={(e) => change('categoryId', e.target.value)}>{catalog.data?.categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
          <label className="field"><span>Atributos, separados por comas</span><input value={draft.axesText} onChange={(e) => change('axesText', e.target.value)} placeholder="Modelo, Color" /></label>
          <label className="field sm:col-span-2"><span>Descripción de la ficha</span><textarea maxLength={2000} rows={2} value={draft.description} onChange={(e) => change('description', e.target.value)} /></label>
          <label className="field"><span>Foto de portada</span><select value={draft.imagePath} onChange={(e) => change('imagePath', e.target.value)}><option value="">Usar la foto de una variante</option>{catalog.data?.products.filter((p) => p.image_path && draft.variants.some((v) => v.productId === p.id)).map((p) => <option key={p.id} value={p.image_path!}>{p.name}</option>)}</select></label>
          <label className="check-field"><input type="checkbox" checked={draft.active} onChange={(e) => change('active', e.target.checked)} />Ficha visible</label>
        </div>
        <p className="text-sm text-stone-600">Editá fotos, promociones y extras desde cada producto. El stock se administra en Inventario. Quitar una variante de esta ficha la deja como producto independiente.</p>
        {draft.variants.map((row, index) => <div key={`${row.isNew ? row.productId : index}`} className="rounded-xl border border-stone-200 p-3">
          <div className="flex items-end gap-2">
            {row.isNew ? <div className="grid flex-1 gap-3 sm:grid-cols-2"><label className="field"><span>Nuevo código / SKU (opcional)</span><input value={row.code} maxLength={80} onChange={(e) => changeVariant(index, { code: e.target.value })} /></label><label className="field"><span>Precio de la variante</span><input value={row.price} type="number" min="0" step="0.01" onChange={(e) => changeVariant(index, { price: e.target.value })} /></label></div> : <label className="field flex-1"><span>Producto existente</span><select value={row.productId} onChange={(e) => changeVariant(index, { productId: e.target.value })}><option value="">Elegí un producto</option>{catalog.data?.products.filter((p) => (!p.family_id || p.family_id === draft.id) && !draft.variants.some((v, i) => i !== index && v.productId === p.id)).map((p) => <option key={p.id} value={p.id}>{p.name} · {p.code}</option>)}</select></label>}
            <button type="button" className="icon-button" aria-label={`Quitar variante ${index + 1}`} onClick={() => change('variants', draft.variants.filter((_, i) => i !== index))}><X className="h-4 w-4" /></button>
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">{axes.map((axis) => <label key={axis} className="field"><span>{axis}</span><input maxLength={80} value={row.attributes[axis] ?? ''} onChange={(e) => changeVariant(index, { attributes: { ...row.attributes, [axis]: e.target.value } })} /></label>)}</div>
          {!row.isNew && row.productId ? <Link className="mt-2 inline-block text-sm font-semibold text-orange-700 underline" to={`/admin/catalogo/productos/${row.productId}`}>Editar precio, foto y extras de este producto</Link> : null}
        </div>)}
        <div className="flex flex-wrap gap-2"><button type="button" className="button-secondary" onClick={() => change('variants', [...draft.variants, { productId: '', attributes: {}, isNew: false, code: '', price: '0' }])}>Agrupar producto existente</button><button type="button" className="button-secondary" onClick={() => change('variants', [...draft.variants, { productId: crypto.randomUUID(), attributes: {}, isNew: true, code: '', price: '0' }])}>Crear nueva variante</button></div>
      </fieldset>
      {error ? <p role="alert" className="form-error mt-4">{error}</p> : null}
      <div className="mt-5 flex justify-end gap-2"><button type="button" className="button-secondary" disabled={saving} onClick={() => setDraft(null)}>Cancelar</button><button type="button" className="button-primary" disabled={saving} onClick={() => void save()}>{saving ? 'Guardando…' : 'Guardar ficha y variantes'}</button></div>
    </section></div> : null}
  </section>
}
