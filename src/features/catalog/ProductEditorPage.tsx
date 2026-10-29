import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, ImagePlus, Plus, Save, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router'
import { z } from 'zod'
import { ErrorPanel, LoadingScreen } from '../../components/Feedback'
import { PageHeader } from '../../components/PageHeader'
import { processImage } from '../../lib/images/processImage'
import { assetVariantPaths, responsiveAssetUrls } from '../../lib/images/responsive'
import { uploadRestaurantImage } from '../../lib/images/upload'
import { parsePriceCents } from '../../lib/money'
import { invalidateCatalogQueries } from '../../lib/catalog-cache'
import { queryKeys } from '../../lib/queryKeys'
import { supabase } from '../../lib/supabase/client'
import { useRestaurantScope } from '../restaurants/RestaurantScope'
import { clearProductAttempt, clearProductSave, persistProductSave, recoverProductDraft, recoverProductSave, saveProductAttempt, type ProductSaveAttempt } from './product-draft'
import { catalogStockError, catalogStockSchema, isDefinitiveCatalogError, parseStockQuantity, type CatalogStockBalance } from './catalog-stock'

interface OptionDraft {
  id: string
  name: string
  price: string
  sortOrder: number
  active: boolean
}
interface GroupDraft {
  id: string
  name: string
  required: boolean
  minSelect: number
  maxSelect: number
  sortOrder: number
  active: boolean
  options: OptionDraft[]
}
interface QuantityPriceDraft {
  id: string
  quantity: number
  totalPrice: string
}
interface ProductDraft {
  id: string
  categoryId: string
  code: string
  name: string
  description: string
  basePrice: string
  promotionalPrice: string
  promotionStartsAt: string
  promotionEndsAt: string
  imagePath: string | null
  active: boolean
  available: boolean
  featured: boolean
  sortOrder: number
  stockQuantity: string
  stockBaseline: CatalogStockBalance | null
  quantityPrices: QuantityPriceDraft[]
  groups: GroupDraft[]
}
const categorySchema = z.array(z.object({ id: z.string().uuid(), name: z.string() }))
const productSchema = z.object({
  id: z.string().uuid(),
  category_id: z.string().uuid(),
  code: z.string(),
  name: z.string(),
  description: z.string(),
  base_price_cents: z.union([z.number(), z.string()]),
  promotional_price_cents: z.union([z.number(), z.string()]).nullable(),
  promotion_starts_at: z.string().nullable(),
  promotion_ends_at: z.string().nullable(),
  image_path: z.string().nullable(),
  active: z.boolean(),
  available: z.boolean(),
  featured: z.boolean(),
  sort_order: z.number().int(),
  family_id: z.string().nullable().optional(),
})
const groupSchema = z.array(
  z.object({
    id: z.string().uuid(),
    name: z.string(),
    required: z.boolean(),
    min_select: z.number().int(),
    max_select: z.number().int(),
    sort_order: z.number().int(),
    active: z.boolean(),
  }),
)
const optionSchema = z.array(
  z.object({
    id: z.string().uuid(),
    option_group_id: z.string().uuid(),
    name: z.string(),
    price_delta_cents: z.union([z.number(), z.string()]),
    sort_order: z.number().int(),
    active: z.boolean(),
  }),
)
const quantityPriceSchema = z.array(
  z.object({
    id: z.string().uuid(),
    quantity: z.number().int().min(2).max(20),
    total_price_cents: z.union([z.number(), z.string()]),
  }),
)
function toLocal(value: string | null) {
  if (!value) return ''
  const date = new Date(value)
  const offset = date.getTimezoneOffset()
  return new Date(date.getTime() - offset * 60000).toISOString().slice(0, 16)
}
export function ProductEditorPage() {
  const { productId } = useParams()
  const isNew = productId === undefined || productId === 'nuevo'
  const validId = isNew || z.string().uuid().safeParse(productId).success
  const scope = useRestaurantScope()
  const client = useQueryClient()
  const navigate = useNavigate()
  const [draft, setDraft] = useState<ProductDraft | null>(null)
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [saving, setSaving] = useState(false)
  const saveInFlight = useRef(false)
  const promotionsSection = useRef<HTMLDetailsElement>(null)
  const extrasSection = useRef<HTMLDetailsElement>(null)
  const organizationSection = useRef<HTMLDetailsElement>(null)
  const [error, setError] = useState<string | null>(null)
  function showEditorError(message: string | null) {
    setError(message)
    if (!message) return
    if (/precios|precio|vigencia/.test(message) && promotionsSection.current) promotionsSection.current.open = true
    if (/opciones|grupo/.test(message) && extrasSection.current) extrasSection.current.open = true
    if (/código|orden/.test(message) && organizationSection.current) organizationSection.current.open = true
  }
  const [pendingSave, setPendingSave] = useState<ProductSaveAttempt | null>(null)
  const stock = useQuery({
    queryKey: ['catalog-stock', scope.selected?.id, isNew ? 'new' : productId],
    enabled: Boolean(scope.selected && validId),
    queryFn: async () => {
      const result = await supabase.rpc('get_catalog_stock', { p_restaurant_id: scope.selected!.id, p_product_ids: isNew ? [] : [productId!] })
      if (result.error) throw new Error('No se pudo cargar el stock del producto. Reintentá antes de guardar.')
      return catalogStockSchema.parse(result.data)
    },
  })
  const categories = useQuery({
    queryKey: queryKeys.categoryOptions(scope.selected?.id),
    enabled: Boolean(scope.selected),
    queryFn: async () => {
      const { data, error: loadError } = await supabase
        .from('categories')
        .select('id,name')
        .eq('restaurant_id', scope.selected?.id ?? '')
        .is('deleted_at', null)
        .eq('active', true)
        .order('sort_order')
      if (loadError) throw new Error('No se pudieron cargar las categorías.')
      return categorySchema.parse(data)
    },
  })
  const product = useQuery({
    queryKey: queryKeys.productEditor(scope.selected?.id, productId),
    enabled: Boolean(scope.selected && !isNew && validId),
    // An editor draft must never be rehydrated from a previous visit. The draft is
    // intentionally initialized only once, so retaining this query after unmount
    // could show an older snapshot while a background refetch is still running.
    gcTime: 0,
    queryFn: async () => {
      const [p, g, q] = await Promise.all([
        supabase
          .from('products')
          .select('*')
          .eq('id', productId ?? '')
          .eq('restaurant_id', scope.selected?.id ?? '')
          .single(),
        supabase
          .from('product_option_groups')
          .select('*')
          .eq('product_id', productId ?? '')
          .eq('restaurant_id', scope.selected?.id ?? '')
          .eq('active', true)
          .order('sort_order'),
        supabase
          .from('product_quantity_prices')
          .select('id,quantity,total_price_cents')
          .eq('product_id', productId ?? '')
          .eq('restaurant_id', scope.selected?.id ?? '')
          .eq('active', true)
          .order('quantity'),
      ])
      if (p.error || g.error || q.error) throw new Error('No se pudo cargar el producto.')
      const parsedProduct = productSchema.parse(p.data),
        groups = groupSchema.parse(g.data),
        quantityPrices = quantityPriceSchema.parse(q.data)
      if (groups.length === 0) return { product: parsedProduct, groups, options: [], quantityPrices }
      const o = await supabase
        .from('product_options')
        .select('*')
        .eq('restaurant_id', scope.selected?.id ?? '')
        .in(
          'option_group_id',
          groups.map((group) => group.id),
        )
        .eq('active', true)
        .order('sort_order')
      if (o.error) throw new Error('No se pudo cargar el producto.')
      return {
        product: parsedProduct,
        groups,
        options: optionSchema.parse(o.data),
        quantityPrices,
      }
    },
  })
  useEffect(() => {
    setDraft(null)
    setImageFile(null)
    setError(null)
    setPendingSave(null)
  }, [productId, scope.selected?.id])
  useEffect(() => {
    if (draft || !scope.selected) return
    const recovered = recoverProductSave(scope.selected.id, isNew ? undefined : productId)
    if (recovered) { setDraft(recovered.draft); setPendingSave(recovered); return }
    if (!stock.data) return
    if (isNew && categories.data?.[0]) {
      setDraft(recoverProductDraft(scope.selected.id) ?? {
        id: crypto.randomUUID(),
        categoryId: categories.data[0].id,
        code: '',
        name: '',
        description: '',
        basePrice: '0',
        promotionalPrice: '',
        promotionStartsAt: '',
        promotionEndsAt: '',
        imagePath: null,
        active: true,
        available: true,
        featured: false,
        sortOrder: 0,
        stockQuantity: '',
        stockBaseline: null,
        quantityPrices: [],
        groups: [],
      })
    } else if (product.data) {
      const p = product.data.product
      setDraft({
        id: p.id,
        categoryId: p.category_id,
        code: p.code,
        name: p.name,
        description: p.description,
        basePrice: (Number(p.base_price_cents) / 100).toString(),
        promotionalPrice: p.promotional_price_cents === null ? '' : (Number(p.promotional_price_cents) / 100).toString(),
        promotionStartsAt: toLocal(p.promotion_starts_at),
        promotionEndsAt: toLocal(p.promotion_ends_at),
        imagePath: p.image_path,
        active: p.active,
        available: p.available,
        featured: p.featured,
        sortOrder: p.sort_order,
        stockQuantity: stock.data.items.find(item => item.productId === p.id)?.onHand ?? '',
        stockBaseline: stock.data.items.find(item => item.productId === p.id) ?? null,
        quantityPrices: product.data.quantityPrices.map((rule) => ({
          id: rule.id,
          quantity: rule.quantity,
          totalPrice: (Number(rule.total_price_cents) / 100).toString(),
        })),
        groups: product.data.groups.map((g) => ({
          id: g.id,
          name: g.name,
          required: g.required,
          minSelect: g.min_select,
          maxSelect: g.max_select,
          sortOrder: g.sort_order,
          active: g.active,
          options: product
            .data!.options.filter((o) => o.option_group_id === g.id)
            .map((o) => ({
              id: o.id,
              name: o.name,
              price: (Number(o.price_delta_cents) / 100).toString(),
              sortOrder: o.sort_order,
              active: o.active,
            })),
        })),
      })
    }
  }, [categories.data, draft, isNew, product.data, scope.selected, stock.data, productId])
  const originalGroupIds = useMemo(() => new Set(product.data?.groups.map((g) => g.id) ?? []), [product.data])
  const originalOptionIds = useMemo(() => new Set(product.data?.options.map((o) => o.id) ?? []), [product.data])
  const imagePreview = useMemo(() => imageFile ? { src: URL.createObjectURL(imageFile) } : responsiveAssetUrls(draft?.imagePath ?? null), [draft?.imagePath, imageFile])
  useEffect(
    () => () => {
      if (imagePreview.src?.startsWith('blob:')) URL.revokeObjectURL(imagePreview.src)
    },
    [imagePreview],
  )
  if (!validId) return <Navigate to="/admin/catalogo/productos" replace />
  if (!pendingSave && (categories.isLoading || stock.isLoading || (!isNew && product.isLoading))) return <LoadingScreen />
  if (!pendingSave && (categories.error || product.error)) return <ErrorPanel>{categories.error?.message ?? product.error?.message}</ErrorPanel>
  if (!pendingSave && stock.error) return <ErrorPanel>{stock.error.message}<button type="button" className="button-secondary mt-3" onClick={() => void stock.refetch()}>Reintentar carga</button></ErrorPanel>
  if (!pendingSave && !categories.data?.length)
    return (
      <ErrorPanel title="Primero creá una categoría">
        Necesitás al menos una categoría activa antes de crear productos.
        <div className="mt-4">
          <Link className="button-primary" to="/admin/catalogo/categorias">
            Crear categoría
          </Link>
        </div>
      </ErrorPanel>
    )
  if (!draft) return <LoadingScreen />
  function patch<K extends keyof ProductDraft>(key: K, value: ProductDraft[K]) {
    if (pendingSave || saving) return
    setDraft((d) => (d ? { ...d, [key]: value } : d))
  }
  function patchGroup(id: string, values: Partial<GroupDraft>) {
    patch(
      'groups',
      draft!.groups.map((g) => (g.id === id ? { ...g, ...values } : g)),
    )
  }
  function patchOption(groupId: string, id: string, values: Partial<OptionDraft>) {
    patch(
      'groups',
      draft!.groups.map((g) =>
        g.id === groupId
          ? {
              ...g,
              options: g.options.map((o) => (o.id === id ? { ...o, ...values } : o)),
            }
          : g,
      ),
    )
  }
  function patchQuantityPrice(id: string, values: Partial<QuantityPriceDraft>) {
    patch(
      'quantityPrices',
      draft!.quantityPrices.map((rule) => (rule.id === id ? { ...rule, ...values } : rule)),
    )
  }
  function addQuantityPrice() {
    const used = new Set(draft!.quantityPrices.map((rule) => rule.quantity))
    const quantity = Array.from({ length: 19 }, (_, index) => index + 2).find((value) => !used.has(value))
    if (quantity) patch('quantityPrices', [...draft!.quantityPrices, { id: crypto.randomUUID(), quantity, totalPrice: '0' }])
  }
  function removeQuantityPrice(id: string) {
    patch(
      'quantityPrices',
      draft!.quantityPrices.filter((rule) => rule.id !== id),
    )
  }
  function addGroup() {
    patch('groups', [
      ...draft!.groups,
      {
        id: crypto.randomUUID(),
        name: '',
        required: false,
        minSelect: 0,
        maxSelect: 1,
        sortOrder: draft!.groups.length,
        active: true,
        options: [],
      },
    ])
  }
  function removeGroup(id: string) {
    patch(
      'groups',
      draft!.groups.filter((g) => g.id !== id),
    )
  }
  function addOption(groupId: string) {
    patch(
      'groups',
      draft!.groups.map((g) =>
        g.id === groupId
          ? {
              ...g,
              options: [
                ...g.options,
                {
                  id: crypto.randomUUID(),
                  name: '',
                  price: '0',
                  sortOrder: g.options.length,
                  active: true,
                },
              ],
            }
          : g,
      ),
    )
  }
  async function save() {
    if (!scope.selected || saveInFlight.current) return
    const restaurantId = scope.selected.id
    const currentDraft = pendingSave?.draft ?? draft!
    const maxCents = 1_000_000_000_000
    const base = parsePriceCents(currentDraft.basePrice) ?? Number.NaN
    const promo = currentDraft.promotionalPrice.trim() === '' ? null : parsePriceCents(currentDraft.promotionalPrice) ?? Number.NaN
    const startsAt = currentDraft.promotionStartsAt ? new Date(currentDraft.promotionStartsAt) : null
    const endsAt = currentDraft.promotionEndsAt ? new Date(currentDraft.promotionEndsAt) : null
    const moneyIsValid = (value: number) => Number.isSafeInteger(value) && value >= 0 && value <= maxCents
    setSaving(true)
    showEditorError(null)
    let stockChange: ProductSaveAttempt['request']['p_stock'] = null
    if (!pendingSave) {
      try {
        const onHand = currentDraft.stockQuantity.trim() === currentDraft.stockBaseline?.onHand ? null : parseStockQuantity(currentDraft.stockQuantity)
        if (onHand !== null && onHand !== currentDraft.stockBaseline?.onHand) {
          if (stock.data?.policy.cutoverId) throw new Error(catalogStockError({ message: 'INVENTORY_CUTOVER' }))
          if (stock.data?.policy.mode === 'paused') throw new Error(catalogStockError({ message: 'INVENTORY_PAUSED' }))
          if (BigInt(onHand) < BigInt(currentDraft.stockBaseline?.reserved ?? '0')) throw new Error(catalogStockError({ message: 'INSUFFICIENT_STOCK' }))
          stockChange = { onHand, expectedVersion: currentDraft.stockBaseline?.version ?? null }
        }
      } catch (failure) {
        showEditorError(failure instanceof Error ? failure.message : 'Revisá la cantidad de stock.'); setSaving(false); return
      }
    }
    if (!currentDraft.name.trim() || currentDraft.name.trim().length > 160 || currentDraft.code.trim().length > 80 || /[\p{Cc}]/u.test(currentDraft.code) || currentDraft.description.length > 2000 || !moneyIsValid(base) || (promo !== null && (!moneyIsValid(promo) || promo > base)) || !Number.isInteger(currentDraft.sortOrder) || Math.abs(currentDraft.sortOrder) > 100000 || (startsAt !== null && Number.isNaN(startsAt.getTime())) || (endsAt !== null && Number.isNaN(endsAt.getTime())) || (startsAt && endsAt && endsAt <= startsAt)) {
      showEditorError('Revisá el nombre, los precios y la vigencia. Los importes admiten hasta dos decimales. El código es opcional; si lo informás, debe tener hasta 80 caracteres sin saltos de línea.')
      setSaving(false)
      return
    }
    const groups = currentDraft.groups.map((group) => ({
      ...group,
      options: group.options.map((option) => ({
        ...option,
        priceDeltaCents: parsePriceCents(option.price) ?? Number.NaN,
      })),
    }))
    const quantityPrices = currentDraft.quantityPrices.map((rule) => ({
      quantity: rule.quantity,
      totalPriceCents: parsePriceCents(rule.totalPrice) ?? Number.NaN,
    }))
    const quantityValues = new Set(quantityPrices.map((rule) => rule.quantity))
    if (quantityValues.size !== quantityPrices.length || quantityPrices.some((rule) => !Number.isInteger(rule.quantity) || rule.quantity < 2 || rule.quantity > 20 || !moneyIsValid(rule.totalPriceCents))) {
      showEditorError('Revisá los precios por cantidad: cada cantidad entre 2 y 20 debe aparecer una sola vez y tener un precio válido.')
      setSaving(false)
      return
    }
    for (const group of groups) {
      const activeOptionCount = group.options.filter((option) => option.active).length
      if (!group.name.trim() || group.name.trim().length > 120 || !Number.isInteger(group.minSelect) || !Number.isInteger(group.maxSelect) || group.minSelect < 0 || group.minSelect > activeOptionCount || group.maxSelect < Math.max(1, group.minSelect) || group.maxSelect > 20 || (group.required && group.minSelect < 1) || !Number.isInteger(group.sortOrder) || Math.abs(group.sortOrder) > 100000 || group.options.some((option) => !option.name.trim() || option.name.trim().length > 120 || !moneyIsValid(option.priceDeltaCents) || !Number.isInteger(option.sortOrder) || Math.abs(option.sortOrder) > 100000)) {
        showEditorError('Revisá nombres, precios y límites de las opciones. El máximo debe estar entre 1 y 20, y el mínimo no puede superar las opciones activas.')
        setSaving(false)
        return
      }
    }
    const currentGroupIds = new Set(currentDraft.groups.map((group) => group.id))
    const currentOptionIds = new Set(currentDraft.groups.flatMap((group) => group.options.map((option) => option.id)))
    const removedGroups = [...originalGroupIds].filter((id) => !currentGroupIds.has(id))
    const removedOptions = [...originalOptionIds].filter((id) => !currentOptionIds.has(id))
    const previousPath = pendingSave?.previousImagePath ?? product.data?.product.image_path ?? null
    let nextPath = currentDraft.imagePath
    let uploadedPath: string | null = null
    let catalogSaved = false
    const cleanupAsset = async (path: string) => {
      const paths = assetVariantPaths(path)
      const [storageResult, assetResult] = await Promise.all([supabase.storage.from('restaurant-assets').remove(paths), supabase.from('image_assets').update({ deleted_at: new Date().toISOString() }).eq('restaurant_id', restaurantId).in('path', paths)])
      return !storageResult.error && !assetResult.error
    }
    try {
      saveInFlight.current = true
      if (isNew) saveProductAttempt(restaurantId, currentDraft)
      if (imageFile && !pendingSave) {
        const processed = await processImage(imageFile)
        uploadedPath = await uploadRestaurantImage({
          restaurantId,
          kind: 'products',
          entityId: currentDraft.id,
          image: processed,
        })
        nextPath = uploadedPath
        setDraft((value) => value ? { ...value, imagePath: nextPath } : value)
        setImageFile(null)
        if (isNew) saveProductAttempt(restaurantId, { ...currentDraft, imagePath: nextPath })
      }
      const attempt: ProductSaveAttempt = pendingSave ?? {
        draft: { ...currentDraft, imagePath: nextPath }, previousImagePath: previousPath,
        request: {
        p_restaurant_id: restaurantId,
        p_operation_id: crypto.randomUUID(),
        p_stock: stockChange,
        p_product: {
          id: currentDraft.id,
          categoryId: currentDraft.categoryId,
          code: currentDraft.code.trim(),
          name: currentDraft.name.trim(),
          description: currentDraft.description.trim(),
          basePriceCents: base,
          promotionalPriceCents: promo,
          promotionStartsAt: startsAt?.toISOString() ?? null,
          promotionEndsAt: endsAt?.toISOString() ?? null,
          imagePath: nextPath,
          active: currentDraft.active,
          available: currentDraft.available,
          featured: currentDraft.featured,
          sortOrder: currentDraft.sortOrder,
          quantityPrices,
        },
        p_groups: groups.map((group) => ({
          id: group.id,
          name: group.name.trim(),
          required: group.required,
          minSelect: group.minSelect,
          maxSelect: group.maxSelect,
          sortOrder: group.sortOrder,
          active: group.active,
          options: group.options.map((option) => ({
            id: option.id,
            name: option.name.trim(),
            priceDeltaCents: option.priceDeltaCents,
            sortOrder: option.sortOrder,
            active: option.active,
          })),
        })),
        p_removed_group_ids: removedGroups,
        p_removed_option_ids: removedOptions,
        },
      }
      if (!pendingSave) {
        persistProductSave(restaurantId, isNew ? undefined : productId, attempt)
        setPendingSave(attempt)
      }
      const { data: saved, error: saveError } = await supabase.rpc('save_product_catalog_with_stock', attempt.request)
      if (saveError) {
        if (isDefinitiveCatalogError(saveError)) {
          clearProductSave(restaurantId, isNew ? undefined : productId)
          setPendingSave(null)
          if (['INVENTORY_VERSION_CONFLICT', 'INSUFFICIENT_STOCK', 'INVENTORY_PAUSED', 'INVENTORY_CUTOVER'].includes(saveError.message)) {
            const refreshed = await stock.refetch()
            setDraft(value => value ? { ...value, stockQuantity: '', stockBaseline: refreshed.data?.items.find(item => item.productId === currentDraft.id) ?? value.stockBaseline } : value)
          }
        }
        showEditorError(catalogStockError(saveError))
        return
      }
      catalogSaved = true
      clearProductSave(restaurantId, isNew ? undefined : productId)
      setPendingSave(null)
      if (isNew) clearProductAttempt(restaurantId)
      setDraft(value => value ? { ...value, stockQuantity: '' } : value)
      const savedCode = z.object({ code: z.string() }).safeParse(saved)
      if (savedCode.success) setDraft((value) => value ? { ...value, code: savedCode.data.code } : value)
      await invalidateCatalogQueries(client, restaurantId)
      if (previousPath && previousPath !== nextPath) {
        const cleaned = await cleanupAsset(previousPath)
        if (!cleaned) {
          setDraft((value) => (value ? { ...value, imagePath: nextPath } : value))
          setImageFile(null)
          showEditorError('El producto quedó guardado, pero no se pudo retirar la imagen anterior. Reintentá la limpieza desde esta pantalla.')
          return
        }
      }
      if (isNew) clearProductAttempt(restaurantId)
      navigate('/admin/catalogo/productos', { state: { savedCode: savedCode.success ? savedCode.data.code : currentDraft.code } })
    } catch (failure) {
      showEditorError(catalogSaved ? 'El producto y su stock quedaron guardados, pero no se pudo completar la actualización de la pantalla.' : catalogStockError(failure))
    } finally {
      saveInFlight.current = false
      setSaving(false)
    }
  }
  async function archive() {
    if (!scope.selected || !window.confirm('¿Ocultar este producto? El historial de pedidos no se elimina.')) return
    setError(null)
    const { error: archiveError } = await supabase.from('products').update({ deleted_at: new Date().toISOString(), active: false }).eq('id', draft!.id).eq('restaurant_id', scope.selected.id)
    if (archiveError) {
      setError('No se pudo dar de baja el producto.')
      return
    }
    await invalidateCatalogQueries(client, scope.selected.id)
    navigate('/admin/catalogo/productos')
  }
  return (
    <>
      <PageHeader
        eyebrow="Catálogo"
        title={isNew ? 'Nuevo producto' : 'Editar producto'}
        description="Nombre, precio y stock: lo esencial para empezar."
        actions={<Link className="button-secondary" to="/admin/catalogo/productos"><ArrowLeft className="h-4 w-4" />Volver</Link>}
      />
      <div className="mx-auto max-w-4xl space-y-4">
        {pendingSave ? <p className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900" role="status">Hay un guardado pendiente de confirmación. Reintentá el mismo envío antes de cambiar los datos.</p> : null}
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <fieldset disabled={saving || Boolean(pendingSave)} className="m-0 space-y-4 border-0 p-0">
          <section className="form-card">
            <h2 className="form-card-title mb-5">Datos principales</h2>
            <div className="grid gap-5 sm:grid-cols-2">
              <label className="field"><span>Nombre</span><input maxLength={160} value={draft.name} onChange={e => patch('name', e.target.value)} placeholder="Nombre del producto" /></label>
              <label className="field"><span>Categoría</span><select disabled={Boolean(product.data?.product.family_id)} value={draft.categoryId} onChange={e => patch('categoryId', e.target.value)}>{categories.data?.map(category => <option value={category.id} key={category.id}>{category.name}</option>)}</select>{product.data?.product.family_id ? <p className="text-xs font-normal text-stone-500">La categoría se cambia desde la ficha de variantes en Productos.</p> : null}</label>
              <label className="field"><span>Precio base</span><input type="number" min="0" step="0.01" value={draft.basePrice} onChange={e => patch('basePrice', e.target.value)} /></label>
              <div className="field">
                <label htmlFor="product-stock">Stock (unidades)</label>
                <input id="product-stock" type="text" inputMode="numeric" aria-describedby="product-stock-help product-stock-current" value={draft.stockQuantity} disabled={stock.data?.policy.mode === 'paused' || Boolean(stock.data?.policy.cutoverId)} onChange={event => patch('stockQuantity', event.target.value)} placeholder={isNew ? 'Ej.: 20' : 'Sin modificar'} />
                <p id="product-stock-help" className="text-xs font-normal text-stone-500">Cantidad total. Vacío conserva el stock; 0 indica agotado.</p>
                <p id="product-stock-current" className="text-xs font-normal text-stone-500">{draft.stockBaseline?.initialized ? `Stock actual: ${draft.stockBaseline.onHand} · Reservado: ${draft.stockBaseline.reserved} · Disponible: ${draft.stockBaseline.available}` : 'Todavía no se cargó stock para este producto.'}</p>
                {stock.data?.policy.cutoverId ? <p className="text-xs font-normal text-amber-800">Hay una actualización de inventario en curso. Podés guardar los otros datos del producto.</p> : stock.data?.policy.mode === 'paused' ? <p className="text-xs font-normal text-amber-800">El stock está pausado. Podés guardar los otros datos del producto.</p> : stock.data?.policy.mode === 'never_enabled' ? <p className="text-xs font-normal text-stone-500">Podés cargar las cantidades ahora y activar el control desde Stock.</p> : null}
              </div>
              <label className="field sm:col-span-2"><span>Descripción</span><textarea rows={2} maxLength={2000} value={draft.description} onChange={e => patch('description', e.target.value)} placeholder="Una descripción breve para tus clientes (opcional)" /></label>
            </div>
            <div className="mt-5 flex flex-wrap gap-5 border-t border-stone-100 pt-4">
              <label className="check-field"><input type="checkbox" checked={draft.active} onChange={e => patch('active', e.target.checked)} />Activo</label>
              <label className="check-field"><input type="checkbox" checked={draft.available} onChange={e => patch('available', e.target.checked)} />Disponible</label>
            </div>
          </section>
        <section className="form-card">
          <h2 className="form-card-title mb-4">Foto</h2>
          <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
            {imagePreview.src ? (
              <img className="h-24 w-24 rounded-2xl object-cover" src={imagePreview.src} srcSet={imagePreview.srcSet} sizes="96px" decoding="async" alt="Previsualización del producto" />
            ) : (
              <div className="grid h-24 w-24 place-items-center rounded-2xl bg-stone-100">
                <ImagePlus className="h-6 w-6 text-stone-300" />
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <label className="button-secondary cursor-pointer">
                <ImagePlus className="h-4 w-4" />
                Elegir o tomar foto
                <input className="sr-only" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" onChange={(e: ChangeEvent<HTMLInputElement>) => setImageFile(e.target.files?.[0] ?? null)} />
              </label>
              {imagePreview.src ? (
                <button
                  className="button-quiet"
                  type="button"
                  onClick={() => {
                    setImageFile(null)
                    patch('imagePath', null)
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                  Quitar imagen
                </button>
              ) : null}
            </div>
          </div>
        </section>
          <details ref={promotionsSection} className="admin-disclosure" open={Boolean(draft.promotionalPrice || draft.quantityPrices.length) || undefined}>
            <summary>Promociones y precios especiales</summary>
            <div className="space-y-6">
              <div className="grid gap-4 sm:grid-cols-3">
                <label className="field"><span>Precio promocional</span><input type="number" min="0" step="0.01" value={draft.promotionalPrice} onChange={e => patch('promotionalPrice', e.target.value)} placeholder="Sin promoción" /></label>
                <label className="field"><span>Promoción desde</span><input type="datetime-local" value={draft.promotionStartsAt} onChange={e => patch('promotionStartsAt', e.target.value)} /></label>
                <label className="field"><span>Promoción hasta</span><input type="datetime-local" value={draft.promotionEndsAt} onChange={e => patch('promotionEndsAt', e.target.value)} /></label>
              </div>
              <div className="border-t border-stone-100 pt-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="font-semibold">Precios por cantidad</h3>
              <p className="text-sm text-stone-500">Ofrecé un precio total especial al comprar varias unidades.</p>
            </div>
            <button className="button-secondary" disabled={draft.quantityPrices.length >= 19} onClick={addQuantityPrice} type="button">
              <Plus className="h-4 w-4" />
              Agregar precio
            </button>
          </div>
          {draft.quantityPrices.length === 0 ? (
            <p className="mt-5 rounded-xl bg-stone-50 p-4 text-sm text-stone-500">No hay precios especiales por cantidad.</p>
          ) : (
            <div className="mt-5 space-y-3">
              {draft.quantityPrices.map((rule) => (
                <div className="grid items-end gap-3 rounded-2xl border border-stone-200 p-4 sm:grid-cols-[140px_1fr_auto]" key={rule.id}>
                  <label className="field">
                    <span>Cantidad</span>
                    <input
                      aria-label={`Cantidad del precio especial ${rule.quantity}`}
                      type="number"
                      min="2"
                      max="20"
                      value={rule.quantity}
                      onChange={(event) =>
                        patchQuantityPrice(rule.id, {
                          quantity: Number(event.target.value),
                        })
                      }
                    />
                  </label>
                  <label className="field">
                    <span>Precio total</span>
                    <input
                      aria-label={`Precio total para ${rule.quantity} unidades`}
                      type="number"
                      min="0"
                      step="0.01"
                      value={rule.totalPrice}
                      onChange={(event) =>
                        patchQuantityPrice(rule.id, {
                          totalPrice: event.target.value,
                        })
                      }
                    />
                  </label>
                  <button className="icon-button text-red-700" type="button" onClick={() => removeQuantityPrice(rule.id)} aria-label={`Quitar precio para ${rule.quantity} unidades`}>
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
</div>
            </div>
          </details>
          <details ref={extrasSection} className="admin-disclosure" open={Boolean(draft.groups.length) || undefined}>
            <summary>Extras y adicionales{draft.groups.length ? ` · ${draft.groups.length} grupos` : ''}</summary>
            <div>
          <div className="flex justify-between">
            <div>
              <p className="text-sm text-stone-500">Opciones que el cliente puede agregar al producto, como ingredientes o acompañamientos.</p>
            </div>
            <button className="button-secondary" onClick={addGroup}>
              <Plus className="h-4 w-4" />
              Grupo
            </button>
          </div>
          <div className="mt-5 space-y-5">
            {draft.groups.map((group) => (
              <article key={group.id} className="rounded-2xl border border-stone-200 p-4">
                <div className="grid items-end gap-3 md:grid-cols-[1fr_100px_100px_auto_auto]">
                  <label className="field">
                    <span>Nombre del grupo</span>
                    <input maxLength={120} value={group.name} onChange={(e) => patchGroup(group.id, { name: e.target.value })} />
                  </label>
                  <label className="field">
                    <span>Mínimo</span>
                    <input
                      type="number"
                      min="0"
                      max="20"
                      value={group.minSelect}
                      onChange={(e) =>
                        patchGroup(group.id, {
                          minSelect: Number(e.target.value),
                        })
                      }
                    />
                  </label>
                  <label className="field">
                    <span>Máximo</span>
                    <input
                      type="number"
                      min="1"
                      max="20"
                      value={group.maxSelect}
                      onChange={(e) =>
                        patchGroup(group.id, {
                          maxSelect: Number(e.target.value),
                        })
                      }
                    />
                  </label>
                  <label className="check-field min-h-11">
                    <input
                      type="checkbox"
                      checked={group.required}
                      onChange={(e) =>
                        patchGroup(group.id, {
                          required: e.target.checked,
                          minSelect: e.target.checked ? Math.max(1, group.minSelect) : 0,
                        })
                      }
                    />
                    Obligatorio
                  </label>
                  <button className="icon-button text-red-700" onClick={() => removeGroup(group.id)} aria-label="Quitar grupo">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
                <div className="mt-4 space-y-2">
                  {group.options.map((option) => (
                    <div className="grid items-end gap-2 rounded-xl bg-stone-50 p-3 sm:grid-cols-[1fr_150px_auto]" key={option.id}>
                      <label className="field">
                        <span>Opción</span>
                        <input
                          maxLength={120}
                          value={option.name}
                          onChange={(e) =>
                            patchOption(group.id, option.id, {
                              name: e.target.value,
                            })
                          }
                        />
                      </label>
                      <label className="field">
                        <span>Adicional</span>
                        <input
                          type="number"
                          step="0.01"
                          value={option.price}
                          onChange={(e) =>
                            patchOption(group.id, option.id, {
                              price: e.target.value,
                            })
                          }
                        />
                      </label>
                      <button
                        className="icon-button text-red-700"
                        onClick={() =>
                          patchGroup(group.id, {
                            options: group.options.filter((o) => o.id !== option.id),
                          })
                        }
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  ))}
                  <button className="button-quiet" onClick={() => addOption(group.id)}>
                    <Plus className="h-4 w-4" />
                    Agregar opción
                  </button>
                </div>
              </article>
            ))}
          </div>
</div>
          </details>
          <details ref={organizationSection} className="admin-disclosure">
            <summary>Código y organización</summary>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="field"><label htmlFor="product-code">Código / SKU (opcional)</label><input id="product-code" aria-describedby="product-code-help" maxLength={80} value={draft.code} onChange={e => patch('code', e.target.value)} /><p id="product-code-help" className="text-xs font-normal text-stone-500">{isNew ? 'Si lo dejás vacío, lo generamos automáticamente' : 'Vacío conserva el código actual.'}</p></div>
              <label className="field"><span>Orden</span><input type="number" min="0" value={draft.sortOrder} onChange={e => patch('sortOrder', Number(e.target.value))} /></label>
              <label className="check-field sm:col-span-2"><input type="checkbox" checked={draft.featured} onChange={e => patch('featured', e.target.checked)} />Destacado</label>
            </div>
          </details>
        </fieldset>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-stone-200 pt-5">
          {!isNew ? <button className="button-quiet text-stone-500" disabled={saving || Boolean(pendingSave)} onClick={() => void archive()}><Trash2 className="h-4 w-4" />Dar de baja</button> : <span />}
          <button className="button-primary" disabled={saving} onClick={() => void save()}><Save className="h-4 w-4" />{saving ? 'Guardando…' : pendingSave ? 'Reintentar guardado' : 'Guardar producto'}</button>
        </div>
      </div>
    </>
  )
}
