import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link2, ShoppingBag } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { z } from 'zod'
import { ErrorPanel } from '../../components/Feedback'
import { InlineFeedback, AdminLoading } from '../../components/AdminFeedback'
import { PageHeader } from '../../components/PageHeader'
import { SectionNavigation } from '../../components/SectionNavigation'
import { invalidateCatalogQueries } from '../../lib/catalog-cache'
import { supabase } from '../../lib/supabase/client'
import { PublicChannelsCard } from './PublicChannelsCard'
import { useRestaurantScope } from './RestaurantScope'
import { useRestaurant } from './useRestaurant'
import './settings-workspace.css'

const readinessSchema = z.object({ configured: z.boolean(), readyForPayments: z.boolean(), environment: z.enum(['test', 'production']) })
type StoreForm = { published: boolean; ordering: 'always' | 'business_hours'; whatsapp: boolean; online: boolean }
const storeSections = [
  { id: 'orders', label: 'Publicación y pedidos', icon: ShoppingBag },
  { id: 'links', label: 'Enlaces y QR', icon: Link2 },
] as const

export function StoreSettingsPage() {
  const { selected } = useRestaurantScope()
  return <StoreSettings key={selected?.id ?? 'none'} restaurantId={selected?.id} />
}

function StoreSettings({ restaurantId }: { restaurantId: string | undefined }) {
  const restaurant = useRestaurant(restaurantId)
  const cache = useQueryClient()
  const [form, setForm] = useState<StoreForm | null>(null)
  const [section, setSection] = useState<typeof storeSections[number]['id']>('orders')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const payment = useQuery({
    queryKey: ['store-payment-readiness', restaurantId], enabled: Boolean(restaurantId),
    queryFn: async () => {
      const result = await supabase.functions.invoke('mercadopago-connect', { body: { restaurantId, action: 'status' } })
      if (result.error) throw new Error('No pudimos verificar Mercado Pago. Podés publicar con pedidos por WhatsApp.')
      return readinessSchema.parse(result.data)
    },
  })
  useEffect(() => {
    if (!restaurant.data || form) return
    const r = restaurant.data
    setForm({ published: r.store_enabled, ordering: r.store_ordering_policy, whatsapp: r.store_checkout_whatsapp_enabled, online: r.store_checkout_online_enabled })
  }, [restaurant.data, form])
  if (restaurant.isLoading) return <AdminLoading label="Cargando la configuración de la tienda…" variant="list" />
  if (restaurant.error || !restaurant.data) return <ErrorPanel>{restaurant.error?.message ?? 'No encontramos el comercio.'}</ErrorPanel>
  if (!form) return <AdminLoading label="Cargando la configuración de la tienda…" variant="list" />
  const r = restaurant.data
  const current = form
  const stockReady = r.inventory_mode === 'enforced' && !r.inventory_cutover_id
  const canEnableOnline = stockReady && r.currency_code === 'ARS' && payment.data?.configured === true && payment.data.readyForPayments && !payment.isError
  const canReceive = r.pickup_enabled || r.delivery_enabled
  function change<K extends keyof StoreForm>(key: K, value: StoreForm[K]) { setForm(previous => previous ? { ...previous, [key]: value } : previous); setMessage(null) }

  async function save(event: FormEvent) {
    event.preventDefault()
    if (saving || !restaurantId) return
    setError(null); setMessage(null)
    if (current.published && r.status !== 'active') { setError('El comercio debe estar activo para publicar la tienda. Contactá al administrador de Mozzi.'); return }
    if (current.published && !canReceive) { setError('Primero habilitá retiro o envío en Configuración.'); return }
    if (current.published && !current.whatsapp && !current.online) { setError('Elegí pedidos por WhatsApp, pagos online o ambas opciones para publicar.'); return }
    if (current.online && !canEnableOnline) { setError('Para cobrar online, conectá Mercado Pago y activá el control de stock. Podés publicar ahora con pedidos por WhatsApp.'); return }
    setSaving(true)
    try {
      const result = await supabase.from('restaurants').update({
        store_enabled: current.published, store_ordering_policy: current.ordering,
        store_checkout_whatsapp_enabled: current.whatsapp, store_checkout_online_enabled: current.online,
      }).eq('id', restaurantId).select('id').maybeSingle()
      if (result.error || result.data?.id !== restaurantId) throw new Error('No pudimos guardar la tienda. Revisá la conexión y las opciones de compra.')
      setMessage(current.published ? 'Tu tienda está publicada. Podés compartirla desde Enlaces y QR.' : 'Cambios guardados. La tienda está sin publicar.')
      await Promise.all([
        cache.invalidateQueries({ queryKey: ['restaurant', restaurantId] }),
        cache.invalidateQueries({ queryKey: ['restaurant-scope-choices'] }),
        invalidateCatalogQueries(cache, restaurantId),
      ])
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'No pudimos guardar la tienda.') }
    finally { setSaving(false) }
  }

  return <>
    <PageHeader eyebrow="Canales de venta" title="Tienda online" description="Elegí cómo recibir compras y compartí tu catálogo." />
    <SectionNavigation label="Sección de tienda online" panelPrefix="store-settings" sections={storeSections} selected={section} onSelect={setSection} />
    {error ? <InlineFeedback tone="error" className="mb-3">{error}</InlineFeedback> : null}
    {message ? <InlineFeedback tone="success" className="mb-3">{message}</InlineFeedback> : null}
    <form id="store-settings-orders" hidden={section !== 'orders'} onSubmit={save} className="form-card settings-panel">
      <fieldset disabled={saving} className="space-y-4">
        <div className="settings-panel-heading">
          <h2 className="form-card-title">Publicación</h2>
          <span className={`status-badge ${r.store_enabled ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-stone-200 bg-stone-100 text-stone-600'}`}>{r.store_enabled ? 'Publicada' : 'Sin publicar'}</span>
        </div>
        <label className="check-field settings-option w-full"><input type="checkbox" checked={current.published} onChange={event => change('published', event.target.checked)} /><span><strong className="font-semibold">Publicar mi tienda online</strong><span className="settings-help mt-1 block">Se aplica al guardar los cambios.</span></span></label>
        <div className="settings-field-grid border-t border-stone-200 pt-4">
        <div>
          <h3 className="mb-2 text-sm font-semibold">Formas de compra</h3>
          <div className="space-y-2">
            <label className="check-field min-h-11"><input type="checkbox" checked={current.whatsapp} onChange={event => change('whatsapp', event.target.checked)} />Pedidos por WhatsApp</label>
            <p className="settings-help">Disponible sin conectar una cuenta de pagos.</p>
            <label className="check-field min-h-11"><input type="checkbox" checked={current.online} disabled={!canEnableOnline && !current.online} onChange={event => change('online', event.target.checked)} />Pagos online con Mercado Pago</label>
            {!stockReady ? <p className="settings-help">Para cobrar online, cargá tus cantidades y <Link className="font-medium text-[var(--admin-accent-strong)] hover:underline" to="/admin/stock">activá el control de stock</Link>.</p> : null}
            {!payment.data?.readyForPayments || payment.isError ? <p className="settings-help">Conectá la cuenta de tu comercio en <Link className="font-medium text-[var(--admin-accent-strong)] hover:underline" to="/admin/medios-de-pago">Medios de pago</Link>.</p> : null}
            {payment.data?.readyForPayments ? <p className="settings-help">Mercado Pago: {payment.data.environment === 'production' ? 'cuenta autorizada para cobros reales' : 'modo de prueba'}.</p> : null}
            {payment.isError ? <button type="button" className="button-quiet" onClick={() => void payment.refetch()}>Reintentar consulta de Mercado Pago</button> : null}
            {r.currency_code !== 'ARS' ? <p className="settings-help">Los pagos online están disponibles en pesos argentinos.</p> : null}
          </div>
        </div>
        <div className="space-y-3"><label className="field"><span>Cuándo recibir pedidos</span><select value={current.ordering} onChange={event => change('ordering', event.target.value as StoreForm['ordering'])}><option value="always">Las 24 horas</option><option value="business_hours">Dentro del horario de atención</option></select></label>
        <p className="settings-help">{canReceive ? `Entrega habilitada: ${[r.pickup_enabled ? 'retiro' : '', r.delivery_enabled ? 'envío local' : ''].filter(Boolean).join(' y ')}.` : 'Falta habilitar retiro o envío.'}</p><Link className="button-quiet settings-related-link" to="/admin/configuracion">Configurar entrega y datos del comercio</Link></div>
        </div>
      </fieldset>
      <div className="settings-save-bar"><p className="settings-help">Guarda la publicación y las opciones de compra de la tienda.</p><button className="button-primary" type="submit" disabled={saving} aria-busy={saving}>{saving ? 'Guardando…' : current.published && !r.store_enabled ? 'Guardar y publicar tienda' : 'Guardar cambios'}</button></div>
    </form>
    <div id="store-settings-links" hidden={section !== 'links'} className="settings-panel">
      <PublicChannelsCard slug={r.slug} menuEnabled={r.public_menu_enabled} storeEnabled={r.store_enabled} canConfigure={false} />
    </div>
  </>
}
