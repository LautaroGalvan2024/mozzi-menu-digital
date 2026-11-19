import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Save, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import { EmptyState, ErrorPanel } from '../../components/Feedback'
import { AdminLoading } from '../../components/AdminFeedback'
import { PageHeader } from '../../components/PageHeader'
import './catalog-admin.css'
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
    <div className="catalog-icon-choice">
      <span className="catalog-icon-preview" aria-hidden>
        <CategoryIconGraphic className="h-5 w-5" iconKey={draft.iconKey} name={draft.name || 'Categoría'} />
      </span>
      <label className="field">
        <span>Ícono de categoría</span>
        <select disabled={disabled} value={draft.iconKey ?? ''} onChange={event => {
          const value = event.currentTarget.value
          onChange(isCategoryIconKey(value) ? value : null)
        }}>
          <option value="">Automático</option>
          {CATEGORY_ICON_OPTIONS.map(({ key, label }) => <option key={key} value={key}>{label}</option>)}
        </select>
        <small>Se muestra cuando la categoría no tiene foto.</small>
      </label>
    </div>
  )
}

export function CategoriesPage() {
  const scope = useRestaurantScope()
  const client = useQueryClient()
  const [draft, setDraft] = useState<Draft | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)
  const editorOpen = Boolean(draft)
  useEffect(() => {
    const element = dialog.current
    if (!editorOpen || !element) return
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (typeof element.showModal === 'function') element.showModal()
    else element.setAttribute('open', '')
    return () => {
      if (element.open && typeof element.close === 'function') element.close()
      if (trigger?.isConnected) trigger.focus({ preventScroll: true })
    }
  }, [editorOpen])

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

  if (query.isLoading) return <AdminLoading variant="list" label="Cargando categorías…" />
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
      {query.data?.length ? <div className="catalog-directory">
        {query.data.map(row => (
          <button
            className="catalog-directory-row catalog-category-row"
            disabled={saving}
            key={row.id}
            onClick={() => { setError(null); setDraft(categoryDraft(row)) }}
            type="button"
          >
            <CategoryVisual row={row} />
            <span className="min-w-0 flex-1">
              <strong className="block break-words font-semibold">{row.name}</strong>
              <small className="block break-words text-stone-600">/{row.slug} · orden {row.sort_order}</small>
            </span>
            <span className="catalog-state-badge" data-tone={row.active ? 'success' : 'neutral'}>
              {row.active ? 'Visible' : 'Oculta'}
            </span>
          </button>
        ))}
      </div> : <EmptyState title="Todavía no hay categorías" description="Creá una categoría para agrupar productos del catálogo." />}
      {draft ? (
        <dialog
          ref={dialog}
          aria-labelledby="category-dialog-title"
          className="modal-card catalog-category-dialog"
          onCancel={event => { event.preventDefault(); if (!saving) setDraft(null) }}
        >
          <header className="catalog-dialog-header">
            <h2 className="form-card-title" id="category-dialog-title">{draft.id ? 'Editar' : 'Nueva'} categoría</h2>
            <button aria-label="Cerrar" className="icon-button" disabled={saving} onClick={() => setDraft(null)} type="button"><X aria-hidden /></button>
          </header>
          <div className="catalog-dialog-content">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="field"><span>Nombre</span><input maxLength={100} onChange={event => patch('name', event.target.value)} value={draft.name} /></label>
              <label className="field"><span>Identificador del enlace (opcional)</span><input maxLength={100} onChange={event => patch('slug', event.target.value)} value={draft.slug} /><small>Si queda vacío, se genera a partir del nombre.</small></label>
              <label className="field sm:col-span-2"><span>Descripción</span><textarea maxLength={300} onChange={event => patch('description', event.target.value)} rows={2} value={draft.description} /></label>
              <IconPicker draft={draft} disabled={saving} onChange={iconKey => patch('iconKey', iconKey)} />
              <div className="catalog-category-order">
                <label className="field"><span>Orden</span><input min="0" onChange={event => patch('sortOrder', Number(event.target.value))} type="number" value={draft.sortOrder} /></label>
                <label className="check-field"><input checked={draft.active} onChange={event => patch('active', event.target.checked)} type="checkbox" />Visible</label>
              </div>
            </div>
            {error ? <p className="form-error mt-4" role="alert">{error}</p> : null}
          </div>
          <footer className="catalog-dialog-actions">
            <button className="button-secondary" disabled={saving} onClick={() => setDraft(null)} type="button">Cancelar</button>
            <button aria-busy={saving} className="button-primary" disabled={saving} onClick={() => void save()} type="button"><Save className="h-4 w-4" aria-hidden />{saving ? 'Guardando…' : 'Guardar'}</button>
          </footer>
        </dialog>
      ) : null}
    </>
  )
}
