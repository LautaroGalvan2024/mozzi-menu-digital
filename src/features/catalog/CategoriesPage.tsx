import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Save, X } from 'lucide-react'
import { useState } from 'react'
import { z } from 'zod'
import { ErrorPanel, LoadingScreen } from '../../components/Feedback'
import { PageHeader } from '../../components/PageHeader'
import { invalidateCatalogQueries } from '../../lib/catalog-cache'
import {
  CATEGORY_ICON_KEYS,
  CATEGORY_ICON_OPTIONS,
  CategoryIconGraphic,
  isCategoryIconKey,
  type CategoryIconKey,
} from '../../lib/category-icons'
import { responsiveAssetUrls } from '../../lib/images/responsive'
import { queryKeys } from '../../lib/queryKeys'
import { supabase } from '../../lib/supabase/client'
import { useRestaurantScope } from '../restaurants/RestaurantScope'

const categorySchema = z.object({
  id: z.string().uuid(),
  restaurant_id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  description: z.string(),
  image_path: z.string().nullable(),
  icon_key: z.enum(CATEGORY_ICON_KEYS).nullable().optional(),
  sort_order: z.number().int(),
  active: z.boolean(),
  deleted_at: z.string().nullable(),
})

type CategoryRow = z.infer<typeof categorySchema>

interface Draft {
  id?: string
  name: string
  slug: string
  description: string
  sortOrder: number
  active: boolean
  iconKey: CategoryIconKey | null
}

const CATEGORY_COLUMNS = [
  'id', 'restaurant_id', 'name', 'slug', 'description', 'image_path',
  'icon_key', 'sort_order', 'active', 'deleted_at',
].join(',')

function categoryDraft(row: CategoryRow): Draft {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    sortOrder: row.sort_order,
    active: row.active,
    iconKey: isCategoryIconKey(row.icon_key) ? row.icon_key : null,
  }
}

function CategoryVisual({ row }: { row: CategoryRow }) {
  const image = responsiveAssetUrls(row.image_path)
  return (
    <span className="grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-xl bg-stone-100 text-stone-500">
      {image.src ? (
        <img
          alt=""
          className="h-full w-full object-contain"
          decoding="async"
          loading="lazy"
          sizes="44px"
          src={image.src}
          srcSet={image.srcSet}
        />
      ) : (
        <CategoryIconGraphic className="h-5 w-5" iconKey={row.icon_key ?? null} name={row.name} />
      )}
    </span>
  )
}

function IconPicker({ draft, disabled, onChange }: {
  draft: Draft
  disabled: boolean
  onChange: (iconKey: CategoryIconKey | null) => void
}) {
  return (
    <fieldset className="space-y-2" disabled={disabled}>
      <legend className="text-sm font-semibold text-stone-800">Ícono de categoría</legend>
      <p className="text-xs text-stone-500">
        Se usa cuando la categoría no tiene imagen. Automático elige uno según el nombre.
      </p>
      <div className="grid max-h-56 grid-cols-2 gap-2 overflow-y-auto pr-1 sm:grid-cols-3">
        <label className={`flex cursor-pointer items-center gap-2 rounded-xl border p-2.5 transition ${draft.iconKey === null ? 'border-orange-500 bg-orange-50 text-orange-900' : 'border-stone-200 bg-white hover:border-orange-300'}`}>
          <input checked={draft.iconKey === null} className="accent-orange-600" name="category-icon" onChange={() => onChange(null)} type="radio" />
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-white text-stone-600 shadow-sm">
            <CategoryIconGraphic className="h-4 w-4" iconKey={null} name={draft.name || 'Categoría'} />
          </span>
          <span className="min-w-0 text-sm font-medium">Automático</span>
        </label>
        {CATEGORY_ICON_OPTIONS.map(({ key, label }) => (
          <label
            className={`flex cursor-pointer items-center gap-2 rounded-xl border p-2.5 transition ${draft.iconKey === key ? 'border-orange-500 bg-orange-50 text-orange-900' : 'border-stone-200 bg-white hover:border-orange-300'}`}
            key={key}
          >
            <input checked={draft.iconKey === key} className="accent-orange-600" name="category-icon" onChange={() => onChange(key)} type="radio" />
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-white text-stone-600 shadow-sm">
              <CategoryIconGraphic className="h-4 w-4" iconKey={key} name={label} />
            </span>
            <span className="min-w-0 text-sm font-medium">{label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}

export function CategoriesPage() {
  const scope = useRestaurantScope()
  const client = useQueryClient()
  const [draft, setDraft] = useState<Draft | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const query = useQuery({
    queryKey: queryKeys.categories(scope.selected?.id),
    enabled: Boolean(scope.selected),
    queryFn: async () => {
      const { data, error: loadError } = await supabase
        .from('categories')
        .select(CATEGORY_COLUMNS)
        .eq('restaurant_id', scope.selected?.id ?? '')
        .is('deleted_at', null)
        .order('sort_order')
      if (loadError) throw new Error('No se pudieron cargar las categorías.')
      return z.array(categorySchema).parse(data)
    },
  })

  if (query.isLoading) return <LoadingScreen />
  if (query.error) return <ErrorPanel>{query.error.message}</ErrorPanel>

  function patch<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft(current => current ? { ...current, [key]: value } : current)
  }

  async function save() {
    if (saving || !draft || !scope.selected) return
    setError(null)
    const restaurantId = scope.selected.id
    const slug = (draft.slug || draft.name)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
    if (!draft.name.trim() || !slug || !Number.isInteger(draft.sortOrder) || draft.sortOrder < 0) {
      setError('Ingresá un nombre y un orden válidos.')
      return
    }

    const payload = {
      restaurant_id: restaurantId,
      name: draft.name.trim(),
      slug,
      description: draft.description.trim(),
      icon_key: draft.iconKey,
      sort_order: draft.sortOrder,
      active: draft.active,
    }
    setSaving(true)
    try {
      const result = draft.id
        ? await supabase.from('categories').update(payload)
            .eq('restaurant_id', restaurantId).eq('id', draft.id)
            .select('id,restaurant_id').maybeSingle()
        : await supabase.from('categories').insert(payload).select('id,restaurant_id').single()
      if (result.error) {
        setError(result.error.code === '23505' ? 'Ya existe una categoría con ese slug.' : 'No se pudo guardar la categoría.')
        return
      }
      if (!result.data || result.data.restaurant_id !== restaurantId || (draft.id && result.data.id !== draft.id)) {
        setError('La categoría cambió o ya no está disponible. Actualizá la vista e intentá nuevamente.')
        return
      }
      setDraft(null)
      await Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.categories(restaurantId) }),
        client.invalidateQueries({ queryKey: queryKeys.categoryOptions(restaurantId) }),
        invalidateCatalogQueries(client, restaurantId),
      ])
    } catch {
      setError('No se pudo guardar la categoría. Verificá tu conexión e intentá nuevamente.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <PageHeader
        actions={<button className="button-primary" disabled={saving} onClick={() => {
          setError(null)
          setDraft({ name: '', slug: '', description: '', sortOrder: query.data?.length ?? 0, active: true, iconKey: null })
        }} type="button"><Plus className="h-4 w-4" />Nueva categoría</button>}
        description="Agrupá tus productos para que tus clientes los encuentren fácilmente."
        eyebrow="Catálogo"
        title="Categorías"
      />
      <div className="space-y-3">
        {query.data?.map(row => (
          <button
            className="flex w-full items-center gap-4 rounded-xl border border-stone-200 bg-white p-4 text-left hover:border-orange-400"
            disabled={saving}
            key={row.id}
            onClick={() => { setError(null); setDraft(categoryDraft(row)) }}
            type="button"
          >
            <CategoryVisual row={row} />
            <span className="min-w-0 flex-1">
              <strong className="block truncate font-display">{row.name}</strong>
              <small className="text-stone-500">/{row.slug} · orden {row.sort_order}</small>
            </span>
            <span className={`rounded-full px-2 py-1 text-xs font-bold ${row.active ? 'bg-emerald-100 text-emerald-700' : 'bg-stone-200 text-stone-600'}`}>
              {row.active ? 'Visible' : 'Oculta'}
            </span>
          </button>
        ))}
      </div>
      {draft ? (
        <div className="modal-backdrop">
          <section aria-labelledby="category-dialog-title" aria-modal="true" className="modal-card" role="dialog">
            <div className="flex justify-between gap-4">
              <h2 className="font-display text-2xl font-bold" id="category-dialog-title">{draft.id ? 'Editar' : 'Nueva'} categoría</h2>
              <button aria-label="Cerrar" className="icon-button" disabled={saving} onClick={() => setDraft(null)} type="button"><X /></button>
            </div>
            <div className="mt-5 space-y-4">
              <label className="field"><span>Nombre</span><input maxLength={100} onChange={event => patch('name', event.target.value)} value={draft.name} /></label>
              <label className="field"><span>Identificador del enlace (opcional)</span><input maxLength={100} onChange={event => patch('slug', event.target.value)} value={draft.slug} /></label>
              <label className="field"><span>Descripción</span><textarea maxLength={300} onChange={event => patch('description', event.target.value)} rows={2} value={draft.description} /></label>
              <IconPicker draft={draft} disabled={saving} onChange={iconKey => patch('iconKey', iconKey)} />
              <label className="field"><span>Orden</span><input min="0" onChange={event => patch('sortOrder', Number(event.target.value))} type="number" value={draft.sortOrder} /></label>
              <label className="check-field"><input checked={draft.active} onChange={event => patch('active', event.target.checked)} type="checkbox" />Visible</label>
            </div>
            {error ? <p className="form-error mt-4" role="alert">{error}</p> : null}
            <div className="mt-6 flex justify-end gap-2">
              <button className="button-secondary" disabled={saving} onClick={() => setDraft(null)} type="button">Cancelar</button>
              <button aria-busy={saving} className="button-primary" disabled={saving} onClick={() => void save()} type="button"><Save className="h-4 w-4" />{saving ? 'Guardando…' : 'Guardar'}</button>
            </div>
          </section>
        </div>
      ) : null}
    </>
  )
}
