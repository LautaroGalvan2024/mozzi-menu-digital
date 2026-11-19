import { useQueryClient } from '@tanstack/react-query'
import { ArrowUpRight, Copy, Plus, UserRound } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { EmptyState, ErrorPanel } from '../../components/Feedback'
import { AdminLoading } from '../../components/AdminFeedback'
import { PageHeader } from '../../components/PageHeader'
import { commercePath, type CommerceChannel } from '../../lib/commerce-channel'
import { env } from '../../lib/env'
import { cleanupRestaurantImage } from '../../lib/images/cleanup'
import { processImage, validateImageFile } from '../../lib/images/processImage'
import { uploadRestaurantImage } from '../../lib/images/upload'
import { publicAssetUrl } from '../../lib/supabase/public-assets'
import { supabase } from '../../lib/supabase/client'
import { useRestaurantScope } from '../restaurants/RestaurantScope'
import { useRestaurant } from '../restaurants/useRestaurant'
import { sellerDirectoryKey, useSellerDirectory, type Seller } from './seller-directory'
import '../catalog/catalog-admin.css'

const channelOptions = [
  { channel: 'menu', label: 'Menú', key: 'menu_enabled' },
  { channel: 'store', label: 'Tienda', key: 'store_enabled' },
] as const

function sellerLink(slug: string, channel: CommerceChannel, id: string) {
  const url = new URL(commercePath(slug, channel), env.appBaseUrl)
  url.searchParams.set('vendedor', id)
  return url.toString()
}

export function SellersPage() {
  const { selected } = useRestaurantScope()
  return selected ? <SellerDirectory key={selected.id} restaurantId={selected.id} /> : <AdminLoading />
}

function SellerDirectory({ restaurantId }: { restaurantId: string }) {
  const restaurant = useRestaurant(restaurantId)
  const sellers = useSellerDirectory(restaurantId)
  const [editor, setEditor] = useState<Seller | 'new' | null>(null)
  const [notice, setNotice] = useState<{ message: string; tone: 'success' | 'error' } | null>(null)
  if (restaurant.isLoading || sellers.isLoading) return <AdminLoading variant="list" label="Cargando vendedores…" />
  if (!restaurant.data || sellers.isError) return <ErrorPanel>No pudimos cargar los vendedores. <button type="button" className="button-quiet" onClick={() => void Promise.all([restaurant.refetch(), sellers.refetch()])}>Reintentar</button></ErrorPanel>
  const business = restaurant.data
  const published = { menu: business.public_menu_enabled, store: business.store_enabled }

  async function copy(seller: Seller, channel: CommerceChannel) {
    try {
      await navigator.clipboard.writeText(sellerLink(business.slug, channel, seller.id))
      setNotice({ message: `Copiaste el enlace de ${seller.name}.`, tone: 'success' })
    } catch {
      setNotice({ message: 'No se pudo copiar. Abrí el enlace para copiarlo desde el navegador.', tone: 'error' })
    }
  }

  return <>
    <PageHeader eyebrow="Equipo comercial" title="Vendedores" description="Creá enlaces para compartir el catálogo y saber quién originó cada pedido."
      actions={!editor ? <button className="button-primary" type="button" onClick={() => { setNotice(null); setEditor('new') }}><Plus className="h-4 w-4" aria-hidden />Nuevo vendedor</button> : undefined} />
    {editor ? <SellerForm key={editor === 'new' ? 'new' : editor.id} restaurantId={restaurantId}
      initial={editor === 'new' ? undefined : editor} published={published} onCancel={() => setEditor(null)}
      onSaved={(name) => { setEditor(null); setNotice({ message: `${name}: cambios guardados.`, tone: 'success' }) }} /> : null}
    {notice ? <p className={notice.tone === 'success' ? 'form-success mb-4' : 'form-error mb-4'} role={notice.tone === 'success' ? 'status' : 'alert'}>{notice.message}</p> : null}
    {sellers.data?.length === 0 && !editor ? (
      <EmptyState title="Todavía no agregaste vendedores" description="Creá un vendedor para compartir su enlace de Menú o Tienda." />
    ) : null}
    {sellers.data?.length ? <div className="catalog-directory">
      {sellers.data.map(seller => {
        const photo = publicAssetUrl(seller.image_path)
        const availableChannels = channelOptions.filter(option => seller.active && seller[option.key] && published[option.channel])
        return <article className="catalog-directory-row seller-directory-row" key={seller.id}>
          <div className="seller-directory-identity">
            {photo ? <img src={photo} alt="" className="seller-directory-avatar object-cover" /> : <span className="seller-directory-avatar"><UserRound className="h-4 w-4" aria-hidden /></span>}
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <h2 className="break-words font-semibold">{seller.name}</h2>
                <span className="catalog-state-badge" data-tone={seller.active ? 'success' : 'neutral'}>{seller.active ? 'Activo' : 'Inactivo'}</span>
              </div>
              {seller.active ? <p className="mt-1 break-words text-sm text-stone-600">{seller.whatsapp_phone}</p> : null}
            </div>
          </div>
          <div className="seller-directory-actions">
            {availableChannels.map(({ channel, label }) =>
              <div className="seller-channel-actions" key={channel}>
                <button type="button" className="button-secondary" aria-label={`Copiar enlace de ${label} de ${seller.name}`} onClick={() => void copy(seller, channel)}><Copy className="h-4 w-4" aria-hidden />Copiar {label.toLowerCase()}</button>
                <a className="button-quiet" href={sellerLink(business.slug, channel, seller.id)} target="_blank" rel="noreferrer" aria-label={`Ver ${label.toLowerCase()} de ${seller.name}`}>Ver <ArrowUpRight className="h-4 w-4" aria-hidden /></a>
              </div>)}
            <button type="button" className="button-quiet" aria-label={`Editar ${seller.name}`} disabled={Boolean(editor)} onClick={() => { setNotice(null); setEditor(seller) }}>Editar</button>
          </div>
        </article>
      })}
    </div> : null}
  </>
}

function SellerForm({ restaurantId, initial, published, onSaved, onCancel }: {
  restaurantId: string; initial: Seller | undefined; published: Record<CommerceChannel, boolean>;
  onSaved: (name: string) => void; onCancel: () => void
}) {
  const client = useQueryClient()
  const [id] = useState(() => initial?.id ?? crypto.randomUUID())
  const [name, setName] = useState(initial?.name ?? '')
  const [phone, setPhone] = useState(initial?.whatsapp_phone ?? '')
  const [active, setActive] = useState(initial?.active ?? true)
  const [channels, setChannels] = useState({ menu: initial?.menu_enabled ?? (published.menu || !published.store), store: initial?.store_enabled ?? published.store })
  const [imagePath, setImagePath] = useState(initial?.image_path ?? null)
  const [file, setFile] = useState<File | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function save(event: FormEvent) {
    event.preventDefault()
    if (saving) return
    const compact = phone.trim().replace(/[ ).(-]/g, '').replace(/^00/, '+')
    const normalized = compact.startsWith('+') ? compact : `+${compact}`
    if (!name.trim()) { setError('Ingresá un nombre para el vendedor.'); return }
    if (!/^\+[1-9]\d{7,14}$/.test(normalized)) { setError('Ingresá el WhatsApp con código de país y área.'); return }
    if (active && !channels.menu && !channels.store) { setError('Elegí dónde compartir el enlace.'); return }
    setSaving(true)
    setError('')
    try {
      let savedPath = imagePath
      if (file) {
        savedPath = await uploadRestaurantImage({ restaurantId, entityId: id, kind: 'promotions', image: await processImage(file) })
        setFile(null)
        setImagePath(savedPath)
      }
      const { data, error: failure } = await supabase.rpc('save_seller', {
        p_restaurant_id: restaurantId, p_id: id, p_name: name.trim(), p_whatsapp_phone: normalized,
        p_image_path: savedPath, p_active: active, p_menu_enabled: channels.menu, p_store_enabled: channels.store,
      })
      if (failure || data !== id) throw new Error('No pudimos guardar los cambios. Podés reintentar con estos datos.')
      if (initial?.image_path && initial.image_path !== savedPath) void cleanupRestaurantImage(restaurantId, initial.image_path)
      await client.invalidateQueries({ queryKey: sellerDirectoryKey(restaurantId) })
      onSaved(name.trim())
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'No pudimos guardar los cambios.')
    } finally { setSaving(false) }
  }

  return <form className="form-card seller-editor mb-4" onSubmit={save}>
    <h2 className="form-card-title">{initial ? 'Editar vendedor' : 'Nuevo vendedor'}</h2>
    <fieldset disabled={saving} className="seller-editor-fields">
      <div className="seller-editor-contact">
        <label className="field"><span>Nombre</span><input value={name} onChange={event => setName(event.target.value)} maxLength={120} required /></label>
        <label className="field"><span>WhatsApp</span><input type="tel" value={phone} onChange={event => setPhone(event.target.value)} maxLength={40} placeholder="+54 9 11 1234 5678" required /><small>Los pedidos del enlace se envían a este número.</small></label>
      </div>
      <div className="seller-editor-photo">
        <label className="field max-w-full"><span>Foto (opcional)</span><input type="file" accept="image/jpeg,image/png,image/webp" onChange={event => {
          const selection = event.target.files?.[0]
          if (!selection) return
          try { validateImageFile(selection); setFile(selection); setError('') }
          catch (failure) { event.target.value = ''; setError(failure instanceof Error ? failure.message : 'Revisá la imagen.') }
        }} /></label>
        {imagePath || file ? <button className="button-quiet" type="button" onClick={() => { setImagePath(null); setFile(null) }}>Quitar foto</button> : null}
      </div>
      <fieldset className="seller-editor-channels"><legend className="mb-2 text-sm font-semibold">Dónde compartir</legend>
        <div className="flex flex-wrap gap-4">
          {channelOptions.map(({ channel, label }) => <label key={channel} className="check-field"><input type="checkbox" checked={channels[channel]} onChange={event => setChannels(values => ({ ...values, [channel]: event.target.checked }))} />{label}{published[channel] ? '' : ' (sin publicar)'}</label>)}
        </div>
      </fieldset>
      {initial ? <label className="check-field"><input type="checkbox" checked={active} onChange={event => setActive(event.target.checked)} />Vendedor activo</label> : null}
    </fieldset>
    {error ? <p className="form-error mt-4" role="alert">{error}</p> : null}
    <div className="seller-editor-actions">
      <button type="button" className="button-secondary" onClick={onCancel} disabled={saving}>Cancelar</button>
      <button type="submit" className="button-primary" disabled={saving} aria-busy={saving}>{saving ? 'Guardando…' : 'Guardar vendedor'}</button>
    </div>
  </form>
}
