import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { Link } from 'react-router'
import { ArrowDown, ArrowUp, Copy, Download, ImagePlus, Plus, Search, Trash2 } from 'lucide-react'
import { z } from 'zod'
import QRCode from 'qrcode'
import { PageHeader } from '../../components/PageHeader'
import { ErrorPanel, LoadingScreen } from '../../components/Feedback'
import { supabase } from '../../lib/supabase/client'
import { useRestaurantScope } from '../restaurants/RestaurantScope'
import { useRestaurant } from '../restaurants/useRestaurant'
import { useDebouncedValue } from '../../lib/useDebouncedValue'
import { processImage } from '../../lib/images/processImage'
import { uploadRestaurantImage } from '../../lib/images/upload'
import { responsiveAssetUrls } from '../../lib/images/responsive'
import { currentProductPrice, formatMoney } from '../../lib/money'
import { env } from '../../lib/env'
import { whatsappShareUrl } from '../../lib/phone'
import type { CommerceChannel } from '../../lib/commerce-channel'
import { getPublicCampaign } from './api'
import { getAdminCampaigns, saveCampaign, type CampaignSaveRequest } from './admin-api'
import { bannerPath, campaignPath, campaignSchema, campaignState, dateTimeInZone, localDateTime, newCampaign, parseCodes, type Campaign, type CampaignDraft } from './campaigns'
import './campaigns.css'

const draftSchema = campaignSchema.omit({ slug: true, updatedAt: true }).extend({ title: z.string().max(120), version: z.number().int().positive().nullable() })
const workspaceSchema = z.object({ draft: draftSchema, pending: z.object({ restaurantId: z.string().uuid(), requestId: z.string().uuid(), draft: draftSchema }).nullable() })
const productSchema = z.object({ id: z.string().uuid(), code: z.string(), name: z.string(), image_path: z.string().nullable(), base_price_cents: z.union([z.number(), z.string()]).transform(Number), promotional_price_cents: z.union([z.number(), z.string()]).nullable().transform(value => value === null ? null : Number(value)), promotion_starts_at: z.string().nullable(), promotion_ends_at: z.string().nullable(), active: z.boolean(), available: z.boolean(), family_id: z.string().nullable(), variant_attributes: z.record(z.string(), z.string()).nullable().optional() })
type Product = z.infer<typeof productSchema>
const PRODUCT_COLUMNS = 'id,code,name,image_path,base_price_cents,promotional_price_cents,promotion_starts_at,promotion_ends_at,active,available,family_id,variant_attributes' as const
const workspaceKey = (id: string) => `mozzi:campaign-draft:${id}`
function readWorkspace(id: string) {
  try { const parsed = workspaceSchema.safeParse(JSON.parse(localStorage.getItem(workspaceKey(id)) ?? 'null')); return parsed.success && (!parsed.data.pending || parsed.data.pending.restaurantId === id) ? parsed.data : null } catch { return null }
}
function productPrice(product: Product) { return currentProductPrice({ basePriceCents: product.base_price_cents, promotionalPriceCents: product.promotional_price_cents, promotionStartsAt: product.promotion_starts_at, promotionEndsAt: product.promotion_ends_at }) }
function productLabel(product: Product) { return `${product.name}${product.variant_attributes ? ` · ${Object.values(product.variant_attributes).join(' / ')}` : ''}` }

export function CampaignsPage() {
  const scope = useRestaurantScope()
  return scope.selected ? <CampaignWorkspace key={scope.selected.id} restaurantId={scope.selected.id} /> : <ErrorPanel>Seleccioná un comercio.</ErrorPanel>
}

function CampaignWorkspace({ restaurantId }: { restaurantId: string }) {
  const restaurant = useRestaurant(restaurantId); const client = useQueryClient()
  const query = useQuery({ queryKey: ['campaigns', restaurantId], queryFn: () => getAdminCampaigns(restaurantId) })
  const [initial] = useState(() => readWorkspace(restaurantId))
  const [draft, setDraft] = useState<CampaignDraft | null>(initial?.draft ?? null)
  const [pending, setPending] = useState<CampaignSaveRequest | null>(initial?.pending ?? null)
  const [editing, setEditing] = useState(Boolean(initial)); const [busy, setBusy] = useState(false); const [uploading, setUploading] = useState(false)
  const [error, setError] = useState(''); const [message, setMessage] = useState(initial ? 'Recuperamos la edición guardada en este dispositivo.' : '')
  const [preview, setPreview] = useState(false); const [share, setShare] = useState<Campaign | null>(null)
  const [viewNow, setViewNow] = useState(() => Date.now())
  useEffect(() => { const timer = setInterval(() => setViewNow(Date.now()), 30_000); return () => clearInterval(timer) }, [])
  const form = useRef<HTMLFormElement>(null); const sending = useRef(false)
  useEffect(() => {
    if (!draft) return
    try { localStorage.setItem(workspaceKey(restaurantId), JSON.stringify({ draft, pending })) } catch { /* Server saving remains available when local storage is full. */ }
  }, [draft, pending, restaurantId])
  useEffect(() => {
    if (!draft || !editing) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [draft, editing])
  const selectedProducts = useQuery({ queryKey: ['campaign-selected-products', restaurantId, draft?.productIds], enabled: Boolean(draft?.productIds.length), queryFn: async () => {
    const { data, error: failure } = await supabase.from('products').select(PRODUCT_COLUMNS).eq('restaurant_id', restaurantId).in('id', draft!.productIds).is('deleted_at', null)
    if (failure) throw new Error('No pudimos actualizar los productos elegidos.')
    return z.array(productSchema).parse(data)
  } })
  const categories = useQuery({ queryKey: ['campaign-categories', restaurantId], queryFn: async () => {
    const { data, error: failure } = await supabase.from('categories').select('id,name').eq('restaurant_id', restaurantId).is('deleted_at', null).order('sort_order')
    if (failure) throw new Error('No pudimos cargar las categorías.')
    return z.array(z.object({ id: z.string().uuid(), name: z.string() })).parse(data)
  } })
  if (restaurant.isLoading || query.isLoading) return <LoadingScreen />
  if (!restaurant.data || query.error) return <ErrorPanel>{restaurant.error?.message ?? query.error?.message ?? 'No pudimos cargar el comercio.'}</ErrorPanel>
  const r = restaurant.data; const locked = busy || uploading || Boolean(pending)
  const defaultChannels: CommerceChannel[] = [...(r.public_menu_enabled ? ['menu' as const] : []), ...(r.store_enabled ? ['store' as const] : [])]
  const money = (price: number) => formatMoney(price, r.currency_code, r.locale)
  function patch<K extends keyof CampaignDraft>(key: K, value: CampaignDraft[K]) { setDraft(previous => previous ? { ...previous, [key]: value } : previous); setMessage('') }
  function start(kind: Campaign['kind']) { setDraft(newCampaign(kind, defaultChannels)); setEditing(true); setPreview(false); setError(''); setMessage('') }
  function open(campaign: Campaign) { setDraft(campaign); setEditing(true); setPreview(false); setError(''); setMessage('') }
  async function save(status: Campaign['status']) {
    if (!draft || sending.current || uploading) return
    setError(''); setMessage('')
    if (!pending && !form.current?.reportValidity()) return
    if (!draft.title.trim()) { setError('Escribí un título para la publicación.'); return }
    if (!draft.channels.length) { setError('Elegí al menos un canal.'); return }
    if (draft.startsAt && draft.endsAt && Date.parse(draft.endsAt) <= Date.parse(draft.startsAt)) { setError('La fecha de finalización debe ser posterior al inicio.'); return }
    if (status === 'published' && draft.kind === 'magazine' && !draft.productIds.length) { setError('Elegí al menos un producto para publicar la revista.'); return }
    if (draft.targetKind !== 'catalog' && !draft.targetId) { setError('Elegí el producto o la categoría del anuncio.'); return }
    const request = pending ?? { restaurantId, requestId: crypto.randomUUID(), draft: { ...draft, title: draft.title.trim(), status } }
    // Persist the exact request before sending. A lost response can be replayed safely.
    try { localStorage.setItem(workspaceKey(restaurantId), JSON.stringify({ draft: request.draft, pending: request })) }
    catch { setError('No pudimos guardar el intento en este dispositivo. Liberá espacio del navegador antes de continuar.'); return }
    setPending(request); setBusy(true); sending.current = true
    try {
      const saved = await saveCampaign(request)
      localStorage.setItem(workspaceKey(restaurantId), JSON.stringify({ draft: saved, pending: null }))
      setPending(null); setDraft(saved); setMessage(`${saved.status === 'draft' ? 'Borrador guardado' : campaignState(saved)}. Los datos quedaron guardados en tu comercio.`)
      await client.invalidateQueries({ queryKey: ['campaigns', restaurantId] }); await client.invalidateQueries({ queryKey: ['public-campaigns'] }); await client.invalidateQueries({ queryKey: ['public-campaign'] })
      if (saved.status === 'published') setShare(saved)
    } catch (failure) {
      if ((failure as Error & { definitive?: boolean }).definitive) {
        setPending(null)
        try { localStorage.setItem(workspaceKey(restaurantId), JSON.stringify({ draft, pending: null })) } catch { /* Keep the in-memory draft when browser storage becomes unavailable. */ }
        void client.invalidateQueries({ queryKey: ['campaigns', restaurantId] })
      }
      setError(failure instanceof Error ? failure.message : 'No pudimos confirmar el guardado. Reintentá el mismo envío.')
    } finally { setBusy(false); sending.current = false }
  }
  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; event.target.value = ''; if (!file || !draft) return
    setUploading(true); setError('')
    try { patch('imagePath', await uploadRestaurantImage({ restaurantId, kind: 'promotions', entityId: draft.id, image: await processImage(file) })) }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'No pudimos cargar la imagen.') }
    finally { setUploading(false) }
  }
  function changeDate(key: 'startsAt' | 'endsAt', value: string) {
    try { patch(key, dateTimeInZone(value, r.timezone)); setError('') } catch (failure) { setError(failure instanceof Error ? failure.message : 'Revisá la fecha.') }
  }
  function move(index: number, delta: number) {
    if (!draft) return
    const ids = [...draft.productIds]; const next = index + delta; if (next < 0 || next >= ids.length) return
    ;[ids[index], ids[next]] = [ids[next]!, ids[index]!]; patch('productIds', ids)
  }
  const picture = responsiveAssetUrls(draft?.imagePath ?? null)
  return <>
    <PageHeader eyebrow="Difusión" title="Revistas y anuncios" description="Usá tu catálogo para compartir novedades. Cada función es opcional." actions={!editing ? <div className="flex flex-wrap gap-2"><button className="button-primary" onClick={() => start('magazine')}><Plus className="h-4 w-4" />Nueva revista</button><button className="button-secondary" onClick={() => start('banner')}>Nuevo anuncio</button></div> : <button className="button-secondary" disabled={busy || Boolean(pending)} onClick={() => setEditing(false)}>Volver al listado</button>} />
    {error ? <p role="alert" className="form-error mb-4">{error}</p> : null}{message ? <p role="status" className="form-success mb-4">{message}</p> : null}
    {!editing ? <>
      {draft ? <button className="button-secondary mb-5" onClick={() => setEditing(true)}>Continuar última edición</button> : null}
      {!query.data?.length ? <section className="form-card"><h2 className="form-card-title">Compartí lo que ya vendés</h2><p className="mt-2 text-sm text-stone-600">Elegí productos para una revista o publicá un anuncio. No necesitás volver a cargar precios ni fotos.</p></section> : <div className="space-y-3">{query.data.map(campaign => <article className="campaign-admin-row" key={campaign.id}><div><p className="text-xs text-stone-500">{campaign.kind === 'magazine' ? 'Revista' : 'Anuncio'} · {campaignState(campaign)}</p><h2 className="mt-1 font-semibold">{campaign.title}</h2><p className="mt-1 text-sm text-stone-500">{campaign.channels.map(c => c === 'menu' ? 'Menú' : 'Tienda').join(' y ')}{campaign.kind === 'magazine' ? ` · ${campaign.productIds.length} productos` : ''}</p></div><div className="flex flex-wrap gap-2"><button className="button-secondary" onClick={() => open(campaign)}>Editar</button><button className="button-quiet" onClick={() => { setDraft({ ...campaign, id: crypto.randomUUID(), version: null, title: `${campaign.title} (copia)`.slice(0, 120), status: 'draft', startsAt: null, endsAt: null }); setEditing(true); setMessage('Copia lista para editar. Todavía no está publicada.') }}><Copy className="h-4 w-4" />Duplicar</button>{campaign.status === 'published' ? <button className="button-quiet" onClick={() => setShare(campaign)}>Compartir</button> : null}</div></article>)}</div>}
    </> : draft ? <form ref={form} onSubmit={event => event.preventDefault()} className="mx-auto max-w-4xl space-y-5">
      {pending ? <p className="rounded-xl bg-amber-50 p-4 text-sm" role="status">Hay un envío pendiente de confirmación. Reintentá para recuperar el mismo resultado antes de editar.</p> : null}
      <fieldset disabled={locked} className="space-y-5">
        <section className="form-card"><h2 className="form-card-title">{draft.kind === 'magazine' ? 'Tu revista' : 'Tu anuncio'}</h2><label className="field mt-4"><span>Título</span><input required maxLength={120} value={draft.title} onChange={event => patch('title', event.target.value)} placeholder={draft.kind === 'magazine' ? 'Ej.: Selección de la semana' : 'Ej.: Envíos sin cargo los viernes'} /></label><label className="field mt-4"><span>Mensaje (opcional)</span><textarea rows={2} maxLength={1000} value={draft.description} onChange={event => patch('description', event.target.value)} /></label><div className="mt-4 flex flex-wrap items-center gap-3">{picture.src ? <img className="h-24 w-32 rounded-lg object-contain" src={picture.src} alt="Imagen del anuncio" /> : null}<label className="button-secondary cursor-pointer"><ImagePlus className="h-4 w-4" />{uploading ? 'Cargando imagen…' : 'Agregar imagen (opcional)'}<input className="sr-only" type="file" accept="image/jpeg,image/png,image/webp" onChange={event => void upload(event)} /></label>{draft.imagePath ? <button type="button" className="button-quiet" onClick={() => patch('imagePath', null)}>Quitar imagen</button> : null}</div><p className="mt-2 text-xs text-stone-500">Tu logo, colores y fotos de productos ya están en el catálogo.</p></section>
        {draft.kind === 'magazine' ? <section className="form-card"><h2 className="form-card-title">Elegí los productos</h2><p className="mt-2 text-sm text-stone-500">Usamos las fotos y precios actuales. Esta revista no cambia los precios del catálogo. Hasta 100 productos.</p><ProductPicker restaurantId={restaurantId} selected={draft.productIds} onChange={ids => patch('productIds', ids)} disabled={locked} />
          <h3 className="mt-5 text-sm font-semibold">Seleccionados: {draft.productIds.length} / 100</h3>{selectedProducts.error ? <p className="form-error">{selectedProducts.error.message}</p> : null}
          {draft.productIds.map((id, index) => { const product = selectedProducts.data?.find(item => item.id === id); return <div key={id} className="campaign-selected"><div><strong>{product ? productLabel(product) : selectedProducts.isLoading ? 'Cargando producto…' : 'Producto ya no disponible'}</strong><span className="text-xs text-stone-500">{product ? `${product.code} · ${money(productPrice(product))}${!product.active ? ' · Oculto en el catálogo' : ''}` : id}</span></div><button type="button" className="icon-button" aria-label={`Subir ${product?.name ?? 'producto'}`} disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp className="h-4 w-4" /></button><button type="button" className="icon-button" aria-label={`Bajar ${product?.name ?? 'producto'}`} disabled={index === draft.productIds.length - 1} onClick={() => move(index, 1)}><ArrowDown className="h-4 w-4" /></button><button type="button" className="icon-button" aria-label={`Quitar ${product?.name ?? 'producto'}`} onClick={() => patch('productIds', draft.productIds.filter(value => value !== id))}><Trash2 className="h-4 w-4" /></button></div> })}
        </section> : <section className="form-card"><h2 className="form-card-title">Al tocar el anuncio</h2><label className="field mt-4"><span>Destino</span><select value={draft.targetKind} onChange={event => { patch('targetKind', event.target.value as Campaign['targetKind']); patch('targetId', null) }}><option value="catalog">Abrir el catálogo</option><option value="category">Ver una categoría</option><option value="product">Ver un producto</option></select></label>{draft.targetKind === 'category' ? <label className="field mt-4"><span>Categoría</span><select required value={draft.targetId ?? ''} onChange={event => patch('targetId', event.target.value || null)}><option value="">Elegir categoría</option>{categories.data?.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label> : draft.targetKind === 'product' ? <ProductPicker restaurantId={restaurantId} selected={draft.targetId ? [draft.targetId] : []} single onChange={ids => patch('targetId', ids[0] ?? null)} disabled={locked} /> : null}</section>}
        <section className="form-card"><h2 className="form-card-title">Dónde se verá</h2><div className="mt-4 flex flex-wrap gap-5">{(['menu', 'store'] as const).map(channel => <label className="check-field" key={channel}><input type="checkbox" checked={draft.channels.includes(channel)} onChange={event => patch('channels', event.target.checked ? [...draft.channels, channel] : draft.channels.filter(item => item !== channel))} />{channel === 'menu' ? 'Menú' : 'Tienda'}{!(channel === 'menu' ? r.public_menu_enabled : r.store_enabled) ? <span className="text-xs text-stone-500">(sin publicar)</span> : null}</label>)}</div>{!defaultChannels.length ? <p className="mt-3 text-sm">Podés preparar un borrador. <Link className="underline" to="/admin/tienda">Publicá un canal</Link> antes de mostrarlo a tus clientes.</p> : null}
          <details className="admin-disclosure mt-5" open={Boolean(draft.startsAt || draft.endsAt) || undefined}><summary>Programar fechas y ordenar</summary><p className="mt-3 text-xs text-stone-500">Hora del comercio: {r.timezone}. Sin inicio, se publica al confirmar. Sin finalización, permanece hasta pausarlo.</p><div className="mt-4 grid gap-4 sm:grid-cols-2"><label className="field"><span>Desde (opcional)</span><input type="datetime-local" value={localDateTime(draft.startsAt, r.timezone)} onChange={event => changeDate('startsAt', event.target.value)} /></label><label className="field"><span>Hasta (opcional)</span><input type="datetime-local" value={localDateTime(draft.endsAt, r.timezone)} onChange={event => changeDate('endsAt', event.target.value)} /></label><label className="field"><span>Orden de aparición</span><input type="number" min={0} max={9999} value={draft.sortOrder} onChange={event => patch('sortOrder', Number(event.target.value))} /></label></div></details>
        </section>
      </fieldset>
      <button type="button" className="button-secondary" onClick={() => setPreview(value => !value)}>{preview ? 'Ocultar vista previa' : 'Ver vista previa'}</button>
      {preview ? <section className="campaign-preview" aria-label="Vista previa de la publicación">{picture.src ? <img src={picture.src} alt="" /> : null}<p className="campaign-eyebrow">{r.trade_name} · Vista previa</p><h2>{draft.title || 'Título de tu publicación'}</h2><p className="mt-2">{draft.description}</p>{draft.kind === 'magazine' ? <ul className="mt-4 space-y-2">{draft.productIds.map(id => { const p = selectedProducts.data?.find(item => item.id === id); return p ? <li key={id} className="flex justify-between gap-3 text-sm"><span>{productLabel(p)}</span><strong>{money(productPrice(p))}</strong></li> : null })}</ul> : null}<p className="mt-4 text-xs">Se verá en {draft.channels.map(c => c === 'menu' ? 'Menú' : 'Tienda').join(' y ') || 'ningún canal'}. Los productos ocultos o archivados no se muestran públicamente.</p></section> : null}
      <div className="campaign-sticky-actions">{pending ? <button type="button" className="button-primary" disabled={busy} onClick={() => void save(pending.draft.status)}>{busy ? 'Guardando…' : 'Reintentar guardado'}</button> : <><button type="button" className="button-secondary" disabled={locked} onClick={() => void save('draft')}>Guardar borrador</button>{draft.status === 'published' ? <button type="button" className="button-secondary" disabled={locked} onClick={() => void save('paused')}>Pausar publicación</button> : null}<button type="button" className="button-primary" disabled={locked} onClick={() => void save('published')}>{busy ? 'Guardando…' : draft.startsAt && Date.parse(draft.startsAt) > viewNow ? 'Programar publicación' : draft.status === 'published' ? 'Guardar y publicar cambios' : 'Publicar ahora'}</button></>}</div><p className="text-xs text-stone-500">La edición se conserva en este dispositivo. “Guardar borrador” la guarda en tu comercio sin publicarla.</p>
    </form> : null}
    {share ? <CampaignShare campaign={share} slug={r.slug} onClose={() => setShare(null)} /> : null}
  </>
}

function ProductPicker({ restaurantId, selected, onChange, disabled, single = false }: { restaurantId: string; selected: string[]; onChange: (ids: string[]) => void; disabled: boolean; single?: boolean }) {
  const [search, setSearch] = useState(''); const [codes, setCodes] = useState(''); const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false); const [page, setPage] = useState(0)
  const phrase = useDebouncedValue(search, 250).trim().replace(/[^\p{L}\p{N}\s-]/gu, ' ').slice(0, 120)
  const query = useQuery({ queryKey: ['campaign-picker', restaurantId, phrase, page], queryFn: async () => {
    let request = supabase.from('products').select(PRODUCT_COLUMNS, { count: 'exact' }).eq('restaurant_id', restaurantId).is('deleted_at', null).order('name').order('id').range(page * 30, page * 30 + 29)
    if (phrase) request = request.or(`name.ilike.%${phrase}%,code.ilike.%${phrase}%`)
    const result = await request; if (result.error) throw new Error('No pudimos buscar los productos.')
    return { products: z.array(productSchema).parse(result.data), count: result.count ?? 0 }
  } })
  async function addCodes() {
    const values = parseCodes(codes); if (!values.length) return
    if (values.length > 100) { setMessage('Pegá hasta 100 códigos por vez.'); return }
    setBusy(true); setMessage('')
    try {
      const result = await supabase.from('products').select('id,code').eq('restaurant_id', restaurantId).is('deleted_at', null).in('code', values)
      if (result.error) throw new Error('No pudimos buscar los códigos. Reintentá.')
      const rows = z.array(z.object({ id: z.string(), code: z.string() })).parse(result.data)
      const ordered = values.flatMap(code => rows.filter(row => row.code === code).map(row => row.id)); const all = [...new Set([...selected, ...ordered])]
      if (all.length > 100) throw new Error('La revista admite hasta 100 productos. Quitá algunos antes de agregar más.')
      onChange(all); const missing = values.filter(code => !rows.some(row => row.code === code)); setCodes(missing.join('\n'))
      setMessage(missing.length ? `Agregamos los encontrados. Revisá estos códigos: ${missing.join(', ')}` : 'Productos agregados. Los repetidos se conservaron una sola vez.')
    } catch (failure) { setMessage(failure instanceof Error ? failure.message : 'No pudimos agregar los códigos.') } finally { setBusy(false) }
  }
  const rows = query.data?.products ?? []
  return <div className="mt-4 space-y-3"><label className="field"><span className="flex gap-2"><Search className="h-4 w-4" />Buscar por nombre o código</span><input value={search} disabled={disabled} onChange={event => { setSearch(event.target.value); setPage(0) }} /></label>
    {!single ? <div className="flex flex-wrap items-center gap-3"><button type="button" className="button-quiet" disabled={disabled || !rows.length} onClick={() => { const all = [...new Set([...selected, ...rows.map(row => row.id)])]; if (all.length > 100) setMessage('Elegí hasta 100 productos.'); else onChange(all) }}>Seleccionar esta página</button><span className="text-xs text-stone-500">{selected.length} elegidos · La selección se conserva al buscar</span></div> : null}
    {query.error ? <p className="form-error">{query.error.message}</p> : null}<div className="campaign-picker-results" aria-busy={query.isFetching}>{rows.map(product => <label className="campaign-picker-result" key={product.id}><input type={single ? 'radio' : 'checkbox'} name={single ? 'campaign-target' : undefined} checked={selected.includes(product.id)} disabled={disabled || (!single && selected.length >= 100 && !selected.includes(product.id))} onChange={event => onChange(single ? [product.id] : event.target.checked ? [...selected, product.id] : selected.filter(id => id !== product.id))} /><span>{productLabel(product)}<small>{product.code}{!product.active ? ' · Oculto' : ''}</small></span></label>)}{query.isLoading ? <p className="p-3 text-sm">Buscando…</p> : !rows.length ? <p className="p-3 text-sm">No encontramos productos.</p> : null}</div>
    <div className="flex items-center justify-end gap-3 text-sm"><button type="button" className="button-quiet" disabled={page === 0 || query.isFetching} onClick={() => setPage(value => value - 1)}>Anterior</button><span>Página {page + 1}</span><button type="button" className="button-quiet" disabled={(page + 1) * 30 >= (query.data?.count ?? 0) || query.isFetching} onClick={() => setPage(value => value + 1)}>Siguiente</button></div>
    {!single ? <details className="admin-disclosure"><summary>Pegar varios códigos desde una planilla</summary><label className="field mt-3"><span>Un código por línea, separado por coma o punto y coma</span><textarea rows={3} value={codes} disabled={disabled || busy} onChange={event => setCodes(event.target.value)} /></label><button type="button" className="button-secondary mt-3" disabled={disabled || busy || !codes.trim()} onClick={() => void addCodes()}>{busy ? 'Buscando códigos…' : 'Agregar códigos'}</button></details> : null}{message ? <p className="text-sm text-amber-900" role="status">{message}</p> : null}
  </div>
}

function CampaignShare({ campaign, slug, onClose }: { campaign: Campaign; slug: string; onClose: () => void }) {
  const [channel, setChannel] = useState<CommerceChannel>(campaign.channels[0]!); const [qr, setQr] = useState(''); const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false); const dialog = useRef<HTMLDialogElement>(null)
  const url = new URL(campaign.kind === 'magazine' ? campaignPath(slug, channel, campaign) : bannerPath(slug, channel, campaign), `${env.appBaseUrl}/`).toString()
  useEffect(() => { dialog.current?.showModal() }, [])
  useEffect(() => { let cancelled = false; setQr(''); void QRCode.toDataURL(url, { width: 256, margin: 2 }).then(value => { if (!cancelled) setQr(value) }).catch(() => { if (!cancelled) setMessage('No pudimos generar el QR.') }); return () => { cancelled = true } }, [url])
  async function pdf() {
    setBusy(true); setMessage('Preparando PDF…')
    try { const data = await getPublicCampaign(slug, campaign.slug, channel); if (!data || data.expired) throw new Error('La revista todavía no está vigente o ya finalizó. El PDF estará disponible durante su publicación.'); const module = await import('./campaign-pdf'); await module.downloadCampaignPdf(data, channel, (current, total) => setMessage(`${current} de ${total} productos…`)); setMessage('PDF descargado.') }
    catch (failure) { setMessage(failure instanceof Error ? failure.message : 'No pudimos preparar el PDF.') } finally { setBusy(false) }
  }
  return <dialog ref={dialog} className="modal-card max-w-lg" onCancel={onClose} onClose={onClose}><div className="flex items-center justify-between gap-3"><h2 className="form-card-title">Compartir {campaign.kind === 'magazine' ? 'revista' : 'catálogo'}</h2><button type="button" className="button-quiet" disabled={busy} onClick={() => dialog.current?.close()}>Cerrar</button></div><p className="mt-3 text-sm">{campaign.title} · {campaignState(campaign)}</p>{campaign.channels.length > 1 ? <label className="field mt-4"><span>Canal del enlace</span><select value={channel} onChange={event => setChannel(event.target.value as CommerceChannel)}>{campaign.channels.map(value => <option key={value} value={value}>{value === 'menu' ? 'Menú' : 'Tienda'}</option>)}</select></label> : null}<label className="field mt-4"><span>Enlace</span><input readOnly value={url} onFocus={event => event.target.select()} /></label>{qr ? <div className="my-4 text-center"><img src={qr} className="mx-auto h-36 w-36" alt="Código QR de la publicación" /><a className="text-sm underline" href={qr} download={`qr-${slug}.png`}>Descargar QR</a></div> : null}<div className="mt-4 flex flex-wrap gap-2"><button type="button" className="button-secondary" onClick={() => void navigator.clipboard.writeText(url).then(() => setMessage('Link copiado.')).catch(() => setMessage('Seleccioná y copiá el enlace del campo.'))}>Copiar link</button><a className="button-primary" href={whatsappShareUrl(`${campaign.title}\n${url}`)} target="_blank" rel="noreferrer">WhatsApp</a><a className="button-secondary" href={url} target="_blank" rel="noreferrer">Abrir</a>{campaign.kind === 'magazine' ? <button type="button" className="button-secondary" disabled={busy} onClick={() => void pdf()}><Download className="h-4 w-4" />{busy ? 'Preparando…' : 'PDF'}</button> : null}</div>{message ? <p className="mt-4 text-sm" role="status">{message}</p> : null}</dialog>
}
